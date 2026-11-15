# Characterization suite

Behavioural baseline for the TypeScript refactor (design §6.7). These tests pin
the **current** externally observable contract of the critical flows before any
production code is deleted or moved. They are intentionally black-box: they
assert Postgres rows, HTTP bodies, GitHub calls, queue state and process exit
codes rather than private helpers.

> **They are not a substitute for the focused unit/integration suites.** Several
> deep implementation details remain covered by the unit, contract and
> integration tiers (see `test/README.md`); the characterization suite protects
> the boundaries the refactor may cross.

## Requirements

The suite runs against the local docker-compose dependencies:

- **PostgreSQL** — `DATABASE_URL` (default
  `postgres://postgres:postgres@localhost:5432/reviewer`)
- **Redis** — `REDIS_URL` (default `redis://localhost:6379`)
- The Prisma migrations must be applied to that database.

Run only this suite:

```sh
npm run test:characterization
```

The `characterization` project uses a single fork because every suite shares one
Postgres/Redis instance and truncates fixture tables between tests. `npm test`
also disables file parallelism so this tier never overlaps the integration
tier.

## Coverage map

| File                        | Public boundary                                                                                                                            | Design requirement                                                                                                                                                                                                                                                     | Extends                                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `webhook-ingestion.test.ts` | Probot `receive` → ingestion/orchestrator rows and BullMQ                                                                                  | Webhook ingestion (`opened`, `synchronize`, `ready_for_review`, manual `/review`, unsupported action, bot author, draft PR), duplicate delivery and review identity (§4, §4.1, §4.4, §12.1, §12.3, §13.1)                                                              | `test/integration/review-ingestion.test.ts`                                                                                                                   |
| `review-state.test.ts`      | `transitionReviewState` + Review/ReviewStateTransition rows                                                                                | Every allowed transition, every invalid transition, idempotent same-state move, terminal states reject further moves (§4.3)                                                                                                                                            | `test/integration/review-ingestion.test.ts` (state-machine block), `test/integration/recovery.test.ts` (`resetReviewForRecovery`)                             |
| `outbox.test.ts`            | `publishOutboxEvent` / `recoverOutbox` + real BullMQ queue + OutboxEvent/ReviewJob rows                                                    | Redis available publishes, Redis unavailable leaves pending, second publish is idempotent, superseded job discarded, recovery drains pending events (§12.2)                                                                                                            | `test/integration/review-ingestion.test.ts` (`transactional outbox recovery`, `outbox publish ordering`)                                                      |
| `queue-retry.test.ts`       | `classifyFailure` / `retryPolicyFor`, outbox enqueue options, real BullMQ worker retries, `processReviewJob`, `reconcileIncompleteReviews` | Policy marks transient/permanent failures; outbox passes attempts/backoff; BullMQ executes retries (transient retried, permanent not); durable retry decision; failed-job recovery and exhaustion (§12.4, §17.3)                                                       | `test/observability.test.ts` (retry policy), `test/integration/review-workspace.test.ts` (worker processor), `test/integration/recovery.test.ts` (exhaustion) |
| `findings.test.ts`          | `persistReviewFindings` / `getFindingsForReview` / `supersedeFindingsForReview` + Finding/FindingStatusTransition rows                     | Persist, fingerprint dedupe, supersede, lifecycle transition, transaction rollback leaves no partial rows (§7.1–§7.3, §13.1)                                                                                                                                           | `test/integration/findings.test.ts`                                                                                                                           |
| `publishing.test.ts`        | `publishReview` with an injected Octokit + ReviewComment rows                                                                              | Stale head rejects publication, invalid inline position falls back to summary, duplicate summary/comments are not re-published, worker death after `createReview` retries without duplicates, GitHub 5xx retries, 4xx does not (§4.4, §7.4, §13.1)                     | `test/integration/publishing.test.ts`                                                                                                                         |
| `admin-auth.test.ts`        | `createAdminApi` HTTP handler (+ `setGithubFetch`) + AuditLog rows                                                                         | OAuth state/CSRF, session cookie, org membership, allowlist vs role policy, rate limit, audit row, unauthenticated/forbidden responses (§14.2, §15)                                                                                                                    | `test/integration/admin-api.test.ts`                                                                                                                          |
| `worker-shutdown.test.ts`   | `registerGracefulShutdown` child process + real BullMQ worker with `stopReviewWorker` + `orderShutdownSteps`                               | SIGTERM helper waits for an active step within the deadline; forced timeout does not acknowledge unfinished work; worker drains before connection teardown; an active attempt that fails transiently while the worker is closing is retried, never lost (§12.4, §17.3) | `test/logger.test.ts` (`registerGracefulShutdown` registration smoke test)                                                                                    |
| `triage.test.ts`            | Probot `issues.opened` handler + global fetch transport                                                                                    | `issues.opened` posts a comment, bot/PR issues are skipped, provider/config failures are logged without crashing the webhook (§1.2, §6.7)                                                                                                                              | `test/integration/index.test.ts`                                                                                                                              |
| `runtime-errors.test.ts`    | `createAgentRuntime` registry factory + `classifyQueueFailure` + normalized error classes                                                  | Runtime selection by configured type, fail-closed config error, agent/model error codes and queue retry dispositions (§8.2–§8.4, §9.2, §12.4)                                                                                                                          | `test/agent-runtime-registry.test.ts`, `test/model-provider.test.ts`, `test/observability.test.ts`                                                            |

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

- `retry policy from configuration > the configured policy marks transient failures as retryable` — exported `classifyFailure`/`retryPolicyFor`; classification marks transient classes retryable.
- `retry policy from configuration > the configured policy marks permanent failures as non-retryable` — permanent classes fail without retrying.
- `retry policy from configuration > the outbox enqueues with the configured attempts and backoff` — queue options visible to the `ReviewQueue` port.
- `worker retry execution > a transient failure is retried by BullMQ and the review completes` — a real worker retries a clone failure once and the second attempt succeeds.
- `worker retry execution > a permanent failure fails once without consuming the retry budget` — invalid model output ends failed on attempt 1.
- `durable retry decisions > a transient attempt with budget remaining rethrows and stays claimable` — `ReviewJobRetryError`, job stays `processing`, review reset to `queued`.
- `durable retry decisions > the final transient attempt fails the job and review with retry_exhausted` — last attempt terminates with a stable code.
- `durable retry decisions > a permanent failure fails the job and review on the first attempt` — no retry budget consumed.
- `failed-job recovery > reconciliation requeues a failed durable job whose review is not terminal` — failed jobs are recoverable when work remains.
- `failed-job recovery > reconciliation fails a failed job once its attempt budget is exhausted` — `recovery_exhausted`.
- `failed-job recovery > a terminal failed review is never requeued by reconciliation` — no duplicate/replayed work.

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

- `shutdown phase ordering > the worker drains before queue/Redis/Postgres connections close` — phase ordering is independent of array order.
- `graceful shutdown helper (synthetic active step) > SIGTERM during an active job …` — helper waits for the synthetic active step before exit 0.
- `graceful shutdown helper (synthetic active step) > a deadline breach forces exit …` — helper timeout does not acknowledge unfinished work.
- `real BullMQ worker drain > stopReviewWorker waits for a real active job …` — a real BullMQ worker picks up an enqueued job, the processor blocks, `stopReviewWorker` does not resolve until the job completes; the durable job ends `completed`.
- `real BullMQ worker retry during shutdown > worker shutdown while an active attempt fails transiently …` — `stopReviewWorker` drains the attempt; the retry is scheduled as `delayed`, the durable job stays claimable, and a restarted worker completes it.

### `triage.test.ts`

- `issues.opened triage > posts the rendered triage comment …` — human issue posts comment with the preserved model/temperature/token parameters.
- `issues.opened triage > uses GROQ_MODEL …` — the configured model overrides the default.
- `issues.opened triage > bot-authored issues …` — bot skip.
- `issues.opened triage > pull request issues …` — PR-delivered `issues.opened` events are skipped.
- `issues.opened triage > a provider failure is logged …` — webhook survives provider error.
- `issues.opened triage > a missing GROQ_API_KEY is logged …` — missing configuration does not crash the webhook.

### `runtime-errors.test.ts`

- `agent runtime selection and error contract > selects the adapter …` — configured runtime type selects the CLI/SDK adapter.
- `agent runtime selection and error contract > fails closed …` — unregistered type throws `AgentRuntimeError("config")` as an `AppError`.
- `agent runtime selection and error contract > preserves the normalized agent fields …` — code/detail/session/cause survive.
- `agent runtime selection and error contract > keeps crash and spawn retryable …` — transient agent failures keep their retry disposition.
- `agent runtime selection and error contract > keeps provider_unavailable gated …` — provider retry setting still decides.
- `agent runtime selection and error contract > keeps timeout/invalid output/security failures terminal` — no new retries.
- `model provider error contract > marks … retryable/non-retryable by default` — provider taxonomy and override preserved.
- `model provider error contract > preserves status code, provider detail, and cause` — diagnostic fields survive.

## Shared fixtures

- `support.ts` seeds installation/repository/PR/review/job/outbox rows, builds
  a small verifiable workspace, and truncates the domain tables between tests.
  It contains no assertions.
- `test/fixtures/shutdown-child.mjs` runs the real shutdown helper in a child
  process so `SIGTERM`, deadlines and exit codes are real. Node's native type
  stripping lets the fixture import `src/platform/shutdown.ts` directly.
- GitHub provider calls are stubbed at the HTTP transport boundary
  (global `fetch`) or through the production `setGithubFetch` seam. No test
  reaches the network.

## Known gaps

These flows could not be exercised end-to-end without adding a production seam,
which PR 0.4 forbids. They are tested through the closest existing public
boundary and must be revisited when the relevant module is moved.

1. **Full worker process shutdown.** `src/worker.ts` boots the agent runtime,
   workspace service, knowledge cache, metrics server and BullMQ worker.
   Starting that whole process in a test would require real provider/agent
   wiring. The suite covers the shared shutdown helper in a child process, the
   phase ordering used by the worker composition root, and a real BullMQ worker
   draining a real active job. The concrete worker step list is still assembled
   by `createWorkerRuntime`; `orderShutdownSteps` guarantees the drain-before-
   connections contract it relies on.
2. **Real Redis outage for the outbox.** Both `outbox.test.ts` and
   `test/integration/review-ingestion.test.ts` simulate an unavailable Redis by
   injecting a failing `ReviewQueue` port through `createTestIngestion`. No test
   stops a shared Redis instance, so connection loss mid-command and client
   reconnection behaviour remain uncovered by design.
3. **Admin auth stores are process-local.** OAuth states, sessions and rate-limit
   buckets are in-memory maps. The tests use the exports intended for lifecycle
   management (`clearOauthStates`, `clearSessions`, `clearRateLimitBuckets`)
   rather than adding a new storage seam.
4. **Findings transaction rollback.** Rollback is induced with a real unique-key
   conflict inside the transaction, not a database outage; the assertion (no
   partial finding or transition rows) is the same externally visible contract.
5. **GitHub publication transport.** `publishReview` is driven through its
   public injectable Octokit parameter, not a live GitHub API. Retry/fallback
   semantics are asserted from the calls GitHub would have received.
6. **Triage provider.** The LLM is stubbed at the fetch boundary; provider
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
