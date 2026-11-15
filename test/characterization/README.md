# Characterization suite

Behavioural baseline for the TypeScript refactor (design §6.7). These tests pin
the **current** externally observable contract of the critical flows before any
production code is deleted or moved. They are intentionally black-box: they
assert Postgres rows, HTTP bodies, GitHub calls, queue state and process exit
codes rather than private helpers.

> **They are not a substitute for the focused unit/integration suites.** Several
> deep implementation details remain covered by `test/*.test.ts`; the
> characterization suite protects the boundaries the refactor may cross.

## Requirements

The suite runs against the local docker-compose dependencies:

- **PostgreSQL** — `DATABASE_URL` (default
  `postgres://postgres:postgres@localhost:5432/reviewer`)
- **Redis** — `REDIS_URL` (default `redis://localhost:6379`)
- The Prisma migrations must be applied to that database.

Run only this suite:

```sh
npx vitest run test/characterization --no-file-parallelism
```

`fileParallelism` is disabled in `vitest.config.ts` because every suite shares
one Postgres/Redis instance and truncates fixture tables between tests.

## Coverage map

| File                        | Public boundary                                                                                                        | Design requirement                                                                                                                                                                                                                                 | Extends                                                                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `webhook-ingestion.test.ts` | Probot `receive` → ingestion/orchestrator rows and BullMQ                                                              | Webhook ingestion (`opened`, `synchronize`, `ready_for_review`, manual `/review`, unsupported action, bot author, draft PR), duplicate delivery and review identity (§4, §4.1, §4.4, §12.1, §12.3, §13.1)                                          | `test/review-ingestion.test.ts`                                                                                                       |
| `review-state.test.ts`      | `transitionReviewState` + Review/ReviewStateTransition rows                                                            | Every allowed transition, every invalid transition, idempotent same-state move, terminal states reject further moves (§4.3)                                                                                                                        | `test/review-ingestion.test.ts` (state-machine block), `test/recovery.test.ts` (`resetReviewForRecovery`)                             |
| `outbox.test.ts`            | `publishOutboxEvent` / `recoverOutbox` + real BullMQ queue + OutboxEvent/ReviewJob rows                                | Redis available publishes, Redis unavailable leaves pending, second publish is idempotent, superseded job discarded, recovery drains pending events (§12.2)                                                                                        | `test/review-ingestion.test.ts` (`transactional outbox recovery`, `outbox publish ordering`)                                          |
| `queue-retry.test.ts`       | `classifyFailure` / `retryPolicyFor`, outbox enqueue options, `processReviewJob`, `reconcileIncompleteReviews`         | Policy only (classification marks retryable/non-retryable); BullMQ execution is a gap (PR 2.8). Attempts/backoff metadata, reconciliation re-enqueue, exhausted job ends failed (§12.4, §17.3)                                                     | `test/observability.test.ts` (retry policy), `test/review-workspace.test.ts` (worker processor), `test/recovery.test.ts` (exhaustion) |
| `findings.test.ts`          | `persistReviewFindings` / `getFindingsForReview` / `supersedeFindingsForReview` + Finding/FindingStatusTransition rows | Persist, fingerprint dedupe, supersede, lifecycle transition, transaction rollback leaves no partial rows (§7.1–§7.3, §13.1)                                                                                                                       | `test/findings.test.ts`                                                                                                               |
| `publishing.test.ts`        | `publishReview` with an injected Octokit + ReviewComment rows                                                          | Stale head rejects publication, invalid inline position falls back to summary, duplicate summary/comments are not re-published, worker death after `createReview` retries without duplicates, GitHub 5xx retries, 4xx does not (§4.4, §7.4, §13.1) | `test/publishing.test.ts`                                                                                                             |
| `admin-auth.test.ts`        | `createAdminApi` HTTP handler (+ `setGithubFetch`) + AuditLog rows                                                     | OAuth state/CSRF, session cookie, org membership, allowlist vs role policy, rate limit, audit row, unauthenticated/forbidden responses (§14.2, §15)                                                                                                | `test/admin-api.test.ts`                                                                                                              |
| `worker-shutdown.test.ts`   | `registerGracefulShutdown` child process + real BullMQ worker with `stopReviewWorker`                                  | SIGTERM helper waits for an active step within the deadline; forced timeout does not acknowledge unfinished work; `stopReviewWorker` waits for a real active job (§12.4, §17.3)                                                                    | `test/logger.test.ts` (`registerGracefulShutdown` registration smoke test)                                                            |
| `triage.test.ts`            | Probot `issues.opened` handler + global fetch transport                                                                | `issues.opened` posts a comment, bot issues are skipped, provider failure is logged without crashing the webhook (§1.2, §6.7)                                                                                                                      | `test/index.test.ts`                                                                                                                  |

## Per-test / per-describe map

### `webhook-ingestion.test.ts`

- `pull_request ingestion > opened persists …` — triggers/rows/job/outbox for `pull_request.opened` (§4, §12.3, §13.1).
- `pull_request ingestion > synchronize reviews …` — new head reviewed, old in-flight review superseded (§4.4).
- `pull_request ingestion > ready_for_review …` — trigger mapping (§4.1).
- `pull_request ingestion > unsupported pull_request actions …` — `closed`/`labeled` create nothing (§4.1).
- `pull_request ingestion > bot-authored …` — bot authors skipped (§4.1).
- `pull_request ingestion > draft pull requests …` — draft skipped while disabled (§4.1).
- `duplicate delivery and review identity > the same deliveryId …` — delivery dedupe (§12.1).
- `duplicate delivery and review identity > the same (PR, headSha, mode, type) …` — review identity dedupe (§12.3).
- `manual /review trigger > a /review comment …` — manual ingestion, default type, acknowledgment (§4.1, §12.3).
- `manual /review trigger > forced manual re-reviews increment attempt …` — attempt counter identity (§12.3).

### `review-state.test.ts`

- `review state transitions (§4.3) > every allowed transition …` — full allowed table.
- `review state transitions (§4.3) > every disallowed transition …` — full rejected table; row untouched.
- `review state transitions (§4.3) > terminal states accept no further move` — terminal lockout.
- `review state transitions (§4.3) > a same-state transition is idempotent …` — no duplicate audit rows.
- `review state transitions (§4.3) > terminal side effects …` — completedAt/error/supersede fields.

### `outbox.test.ts`

- `outbox publication (§12.2) > with Redis available …` — real BullMQ job, published event.
- `outbox publication (§12.2) > with Redis unavailable …` — injected failing Queue; event stays pending.
- `outbox publication (§12.2) > publishing the same event twice …` — idempotent re-publish.
- `outbox publication (§12.2) > a superseded job is discarded …` — no enqueue for superseded work.
- `outbox publication (§12.2) > recovery drains pending events …` — `recoverOutbox` published/discarded summary.

### `queue-retry.test.ts`

- `retry policy from configuration > the configured policy marks transient failures as retryable` — **policy only**; exported `classifyFailure`/`retryPolicyFor`. No BullMQ job is enqueued or retried; execution is the PR 2.8 gap.
- `retry policy from configuration > the configured policy marks permanent failures as non-retryable` — **policy only**; same caveat.
- `retry policy from configuration > the outbox enqueues with the configured attempts and backoff` — queue options visible to BullMQ.
- `job exhaustion (§12.4, §17.3) > reconciliation re-enqueues a stale transient failure …` — working reconciliation retry path.
- `job exhaustion (§12.4, §17.3) > reconciliation fails a stale review once … exhausted` — exhausted job ends failed.
- `job exhaustion (§12.4, §17.3) > a failing processing attempt leaves the durable job failed …` — first-attempt terminal state; documents the production gap.

### `findings.test.ts`

- `finding persistence (§7.1, §13.1) > a valid finding is persisted …` — row, verification, first transition.
- `finding persistence (§7.1, §13.1) > fingerprint duplicates inside one review …` — in-review dedupe.
- `finding persistence (§7.1, §13.1) > the same issue across commits …` — new → updated → resolved → reopened.
- `finding persistence (§7.1, §13.1) > superseding a review …` — superseded lifecycle/link.
- `finding persistence (§7.1, §13.1) > a failed persistence transaction …` — rollback leaves no partial rows.

### `publishing.test.ts`

- `publication guards (§4.4, §7.4) > a stale head rejects …` — stale-head guard.
- `publication guards (§4.4, §7.4) > an invalid inline position falls back …` — summary fallback.
- `publication guards (§4.4, §7.4) > re-publishing never creates …` — summary/comment dedupe.
- `publication guards (§4.4, §7.4) > a worker death after createReview …` — marker reconciliation on retry creates no duplicate summary or inline comment.
- `GitHub error handling > 5xx responses are retried …` — retryable API failure.
- `GitHub error handling > 4xx responses are not retried` — deterministic client failure.

### `admin-auth.test.ts`

- `OAuth state and CSRF (§14.2) > the authorize redirect …` — authorize URL, state single use.
- `OAuth state and CSRF (§14.2) > a callback without state …` — CSRF rejection/audit.
- `session cookie and logout (§14.2) > login issues …` — signed HttpOnly cookie/session document.
- `session cookie and logout (§14.2) > logout requires the CSRF token …` — CSRF + session destruction.
- `session cookie and logout (§14.2) > unauthenticated admin requests …` — 401/fall-through.
- `organization membership and admin role policy (§14.2) > non-members and pending members …` — membership gate.
- `organization membership and admin role policy (§14.2) > an allowlist wins …` — allowlist vs role policy.
- `organization membership and admin role policy (§14.2) > without an allowlist …` — org-role policy.
- `rate limiting (§14.2) > requests beyond the configured budget …` — 429 headers/body.

### `worker-shutdown.test.ts`

- `graceful shutdown helper (synthetic active step) > SIGTERM during an active job …` — helper waits for the synthetic active step before exit 0.
- `graceful shutdown helper (synthetic active step) > a deadline breach forces exit …` — helper timeout does not acknowledge unfinished work.
- `real BullMQ worker drain > stopReviewWorker waits for a real active job …` — a real BullMQ worker picks up an enqueued job, the processor blocks, `stopReviewWorker` does not resolve until the job completes; the durable job ends `completed`.

### `triage.test.ts`

- `issues.opened triage > posts the rendered triage comment …` — human issue posts comment.
- `issues.opened triage > bot-authored issues …` — bot skip.
- `issues.opened triage > a provider failure is logged …` — webhook survives provider error.

## Shared fixtures

- `support.ts` seeds installation/repository/PR/review/job/outbox rows, builds
  a small verifiable workspace, and truncates the domain tables between tests.
  It contains no assertions.
- `test/fixtures/shutdown-child.mjs` runs the real shutdown helper in a child
  process so `SIGTERM`, deadlines and exit codes are real. Node's native type
  stripping lets the fixture import `src/lib/shutdown.ts` directly.
- GitHub provider calls are stubbed at the HTTP transport boundary
  (global `fetch`) or through the production `setGithubFetch` seam. No test
  reaches the network.

## Known gaps and production findings

These flows could not be exercised end-to-end without adding a production seam,
which PR 0.4 forbids. They are tested through the closest existing public
boundary and must be revisited when the relevant module is moved.

1. **Known production gap (deferred to PR 2.8): BullMQ retry execution is not
   wired.** `processReviewJob` records the retry decision in structured logs but
   resolves `"failed"` instead of rethrowing, and it immediately marks both the
   review and the durable `ReviewJob` `failed`. BullMQ therefore treats the run
   as successful and never applies the configured `attempts`/`backoff`; failed
   durable jobs are also not picked up by reconciliation (it scans only
   `pending_outbox`/`enqueued`/`processing`). The queue-level retry
   configuration is currently metadata only. This is a **production finding**,
   not merely a test gap, and is explicitly out of scope for this tests-only PR.
   `queue-retry.test.ts` pins the policy decisions, outbox options, the working
   reconciliation re-enqueue path, and first-attempt failure; it does **not**
   claim that a transient failure is re-attempted by BullMQ. PR 2.8 should fix
   the worker contract and update these assertions.
2. **Full worker process shutdown.** `src/worker.ts` boots the agent runtime,
   workspace service, knowledge cache, metrics server and BullMQ worker.
   Starting that whole process in a test would require real provider/agent
   wiring. The suite covers the shared shutdown helper in a child process and a
   real BullMQ worker draining a real active job; the worker's concrete step
   list and ordering are still not asserted here.
3. **Real Redis outage for the outbox.** `outbox.test.ts` simulates an
   unavailable Redis by injecting a failing `Queue` through the exported
   `publishOutboxEvent(eventId, queue)` parameter. The existing
   `test/review-ingestion.test.ts` performs the real container stop/start.
4. **Admin auth stores are process-local.** OAuth states, sessions and rate-limit
   buckets are in-memory maps. The tests use the exports intended for lifecycle
   management (`clearOauthStates`, `clearSessions`, `clearRateLimitBuckets`)
   rather than adding a new storage seam.
5. **Findings transaction rollback.** Rollback is induced with a real unique-key
   conflict inside the transaction, not a database outage; the assertion (no
   partial finding or transition rows) is the same externally visible contract.
6. **GitHub publication transport.** `publishReview` is driven through its
   public injectable Octokit parameter, not a live GitHub API. Retry/fallback
   semantics are asserted from the calls GitHub would have received.
7. **Triage provider.** The LLM is stubbed at the fetch boundary; provider
   success and failure are real code paths in `llm.service`, but no real model
   is called.

## Characterization trade-offs

Some assertions deliberately over-pin current representations. They are kept
because the refactor must either preserve them or consciously update the
baseline:

- **`jobKey` format** — `webhook-ingestion.test.ts` asserts the exact
  `installation:repository:pr:sha:mode:type[:a<attempt>]` string. It is a durable
  job identity, so the test intentionally fails if the format changes.
- **Fingerprint format** — `findings.test.ts` asserts `^fp1:[0-9a-f]{64}$`.
  The algorithm may evolve, but a format change must be a reviewed baseline
  change rather than an accidental refactor side effect.
- **Checked-in configuration values** — default review type, draft policy and
  retry budget are pinned as described below.

## Configuration coupling

Several assertions intentionally pin the checked-in `config/review.json`:
`github.defaultReviewType` is `handbook`, draft PRs are disabled, and
`queue.retry.infrastructure` is `3` attempts with `exponential` backoff. If that
configuration changes, update the expectations in this suite alongside it.
