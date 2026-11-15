# Queue reliability and graceful shutdown

Operational contract for the review queue (BullMQ + Redis) and the durable
Postgres state that backs it. The system is **at-least-once**: every boundary is
idempotent, and Postgres — not Redis — is the source of truth.

## Idempotency keys

| Boundary            | Key                                                                               | Effect of a duplicate                                                      |
| ------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| GitHub webhook      | `WebhookDelivery.deliveryId` (unique)                                             | The delivery is acknowledged, no second review is created.                 |
| Logical review      | `(pullRequestId, headSha, reviewMode, reviewType, attempt)` (unique)              | The existing review/job identity is reused.                                |
| Queue job           | `ReviewJob.id` is the BullMQ `jobId`                                              | `queue.add` with an existing id is a no-op: one logical job.               |
| Outbox publication  | `OutboxEvent.id`, published oldest first and marked `published`                   | A repeated publish collapses into the same BullMQ job.                     |
| Forced re-review    | manual `/review` increments `attempt`                                             | A new logical review is created deliberately, not by bypassing dedupe.     |
| Finding persistence | `(reviewId, fingerprint)` (unique)                                                | Replays update instead of inserting duplicates.                            |
| GitHub publication  | HTML fingerprint markers / reconciliation against existing reviews and comments   | A retry after a partial publish does not duplicate the summary or comment. |

`ReviewJob.jobKey` is
`installation:repository:pr:headSha:mode:type[:a<attempt>]`. It is a durable
identity: recovery re-enqueues with the **same** BullMQ job id, so a crash can
never create a second queue job for the same review.

## Enqueue and Redis outages

1. Ingestion commits the review, durable job (`pending_outbox`) and outbox event
   in one Postgres transaction.
2. The outbox publisher commits `enqueued` **before** adding the BullMQ job, so
   a worker that sees the job can always claim a processable row.
3. If Redis is down, `enqueue` rejects, the durable job is restored to
   `pending_outbox`, and the event stays `pending`. `recoverOutbox()` retries on
   the worker's startup pass and every 30 s; no review request is lost.

## Retry decision (single decision point)

`classifyQueueFailure` in `src/shared/retry.ts` is the only place that
decides whether a failed attempt may retry. It composes the two existing
classifiers rather than re-implementing them:

- `classifyAppFailure` (shared `AppError` family) owns the retryability of
  validation/auth/conflict/provider errors **and the normalized
  `AgentRuntimeError`/`ModelProviderError` classes**. An `AppError` retries only
  when it is explicitly `retryable` **and** the configuration allows an
  infrastructure retry.
- `classifyFailure` + `retryPolicyFor` supply the §12.4 failure class and the
  configured attempt budget for every error. They also own errors outside the
  family (`ReviewRetrievalError`, unknown throws); for an `AppError`, the
  normalized code is authoritative and the message-pattern fallback does not
  override it.

### Agent-runtime failure ruling

`AgentRuntimeError` extends `AppError`; when no explicit `errorCode` is passed,
`classifyQueueFailure` uses `error.code`. `crash`, `spawn`, and
`provider_unavailable` are transient (still ANDed with the configured policy);
`timeout`, `invalid_output`, `config`, `permission_denied`,
`workspace_modified`, and `unknown` are terminal.

`unknown` is terminal **by code**, regardless of
`queue.retry.providerUnavailable.enabled` or whether the message looks
transient (for example, contains `503`). Before PR 3.9 the error was outside the
`AppError` family and the message-pattern fallback could retry it; that fallback
no longer overrides an `AppError` code. This is deliberate: an unclassified
runtime failure is a blind retry and conflicts with the runtime's
fail-immediately policy (§8.4/§12.4). The failure class recorded for metrics can
still reflect a message pattern, but retryability is governed by the `AppError`
flag. Strict pre-PR parity via message matching is intentionally not
implemented because it would preserve a retry path the design rejects.

The attempt budget comes from `config/review.json`
(`queue.retry.infrastructure`): `attempts` and `backoff` are passed to BullMQ at
enqueue time; `enabled: false` means `attempts: 1` (no retries).

| Failure class            | Examples                                                   | Disposition                          |
| ------------------------ | ---------------------------------------------------------- | ------------------------------------ |
| `github_api_transient`   | 429/5xx, network reset, rate limit                         | Retry within the configured budget   |
| `redis_unavailable`      | Redis connection refused, BullMQ failure                   | Retry; the outbox also recovers      |
| `postgres_unavailable`   | Prisma P1001, connection lost                              | Retry; never publish on this attempt |
| `clone_failure`          | git clone/checkout/diff failed                             | Retry when infrastructure is enabled |
| `agent_crash`            | runtime crash/spawn failure                                | Retry when infrastructure is enabled |
| `model_unavailable`      | provider unavailable                                       | Retry only if `queue.retry.providerUnavailable.enabled` |
| `invalid_model_output`   | schema/validation failure                                  | Terminal                             |
| `resource_limit_exceeded`| timeout, OOM, disk quota                                   | Terminal                             |
| `stale_commit`           | PR head moved / results rejected                           | Terminal                             |
| `unknown`                | unclassified internal error, `AgentRuntimeError("unknown")` | Terminal (by code; never retry blindly) |
| transient `AppError`     | `RateLimitError`, retryable `ProviderError`, 5xx           | Retry within the configured budget; a retryable `ProviderError` still maps to `model_unavailable`, so `queue.retry.providerUnavailable.enabled` must also be true |
| permanent `AppError`     | `ValidationError`, `AuthError`, `ForbiddenError`, conflict | Terminal                             |

### Worker contract

`processReviewJob` never resolves a failed attempt. On failure it either:

- **throws `ReviewJobRetryError`** when the decision is retryable and BullMQ has
  attempts remaining. The durable job stays `processing` (claimable by the next
  attempt), `lastError` is recorded, and the review is reset to `queued` (an
  audited recovery move) so the forward state machine can run again; or
- **marks the durable job and review failed** and throws
  `UnrecoverableError` when the failure is permanent or the attempt budget is
  exhausted. The review records `retry_exhausted` for an exhausted transient
  failure, or the error's stable code (e.g. `clone_failed`, `invalid_output`)
  for a permanent one.

Each processing attempt increments `ReviewJob.attempts` when the durable row is
claimed. BullMQ supplies the attempt context (`attemptsMade + 1` of
`opts.attempts`); the durable counter and the queue budget stay aligned because
both derive from `queue.retry.infrastructure.maxAttempts`.

## Failed-job recovery

| Situation                                        | Mechanism                                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Transient failure with attempts remaining        | BullMQ retries with the configured backoff; durable job stays `processing`.                                   |
| Worker crashes / stalls mid-review               | BullMQ stalled-job recovery re-delivers the job; reconciliation also finds `processing` rows after the stale threshold and re-enqueues the same job id. |
| Crash after the review is marked failed, before the job row is marked failed | The review is already terminal, so no work is lost; the job row is left `processing`/`enqueued` and is not requeued (reconciliation excludes terminal reviews). This orphaned job row can be cleaned by an operator. |
| Job marked failed while the review is still non-terminal | Happens when the review-failure write itself fails/conflicts, or after an operator resets a review. Reconciliation scans `failed` durable jobs whose review is non-terminal and re-enqueues them if attempts remain. |
| Attempt budget exhausted                         | Reconciliation fails the review with `recovery_exhausted`; the processor writes `retry_exhausted` when it observes the last attempt itself. |
| Permanent failure                                | The review and job are `failed` with a stable code and are never requeued. A new review requires a new ingestion (manual `/review` increments `attempt`). |
| Redis outage during publish                      | Outbox recovery republishes pending events; the durable identity prevents duplicate jobs.                     |

Reconciliation runs at startup and every 60 s. It scans
`pending_outbox`, `enqueued`, `processing` and `failed` jobs whose review is not
terminal, honors `queue.retry.infrastructure.maxAttempts`, and only removes a
retained BullMQ job when it is already terminal (`completed`/`failed`) so
re-adding with the same id actually runs.

Reconciliation re-enqueue currently uses a fixed `exponential` backoff with a
5000 ms base delay, not `queue.retry.infrastructure.backoff`. The attempt count
is configuration-aware; backoff alignment is a documented follow-up.

## Graceful shutdown

Shutdown is phase-ordered (`src/platform/shutdown.ts`):

1. **stop-intake** — timers (outbox recovery, reconciliation, alerts, workspace
   sweep) and the metrics endpoint stop producing work.
2. **drain** — the BullMQ worker closes. `worker.close(false)` waits for active
   jobs; a job that finishes is completed, and a job that fails transiently is
   scheduled for retry (`delayed`), not acknowledged as success.
3. **close-connections** — review queue, worker Redis, shared Redis, then
   Postgres. The worker is always closed before these clients, because the
   processor still writes durable state while draining.
4. **flush** — logger buffers.

The deadline defaults to **10 s** and is configurable with
`SHUTDOWN_TIMEOUT_MS`. If an active job exceeds the deadline, the process exits
without acknowledging it. The durable row stays `processing`; BullMQ's
stalled-job recovery re-delivers the job (default lock duration) and
reconciliation provides the Postgres-backed fallback.

## Metrics and logs

- Structured failure logs carry `failure_class`, `attempt`, `max_attempts` and
  `retry_decision { retry, maxAttempts, backoff, reason }`.
- `ai_pr_reviewer_reviews_failed_total{failure_class}` increments only on a
  terminal failure, not on each retried attempt.
- `ai_pr_reviewer_queue_depth` includes waiting, active and delayed jobs;
  `failed` jobs are retained for inspection (`removeOnFail: 5000`).

## Known follow-ups

1. **Preflight failures bypass the retry classifier.** The durable lookup,
   claim, review-state read and recovery reset run before the processing `try`
   block. A transient PostgreSQL error there is rethrown directly to BullMQ:
   the configured attempts/backoff still apply, but no `failure_class` metric or
   structured retry decision is recorded. Routing preflight failures through
   `classifyQueueFailure` requires a durable job/review context and is deferred.
2. **Reconciliation backoff is fixed.** Recovery re-enqueue always uses
   `exponential` with a 5000 ms delay instead of the configured backoff. Attempt
   budgets are aligned with `queue.retry.infrastructure.maxAttempts`.
3. **Orphaned terminal-review job rows.** A crash after the review is marked
   failed but before the guarded job write leaves a `processing`/`enqueued` job
   row attached to a terminal review. It is not replayed; an operator may clear
   it during housekeeping.
