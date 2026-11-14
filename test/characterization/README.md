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

| File                        | Public boundary                                                                                                        | Design requirement                                                                                                                                                                                        | Extends                                                                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `webhook-ingestion.test.ts` | Probot `receive` → ingestion/orchestrator rows and BullMQ                                                              | Webhook ingestion (`opened`, `synchronize`, `ready_for_review`, manual `/review`, unsupported action, bot author, draft PR), duplicate delivery and review identity (§4, §4.1, §4.4, §12.1, §12.3, §13.1) | `test/review-ingestion.test.ts`                                                                                                       |
| `review-state.test.ts`      | `transitionReviewState` + Review/ReviewStateTransition rows                                                            | Every allowed transition, every invalid transition, idempotent same-state move, terminal states reject further moves (§4.3)                                                                               | `test/review-ingestion.test.ts` (state-machine block), `test/recovery.test.ts` (`resetReviewForRecovery`)                             |
| `outbox.test.ts`            | `publishOutboxEvent` / `recoverOutbox` + real BullMQ queue + OutboxEvent/ReviewJob rows                                | Redis available publishes, Redis unavailable leaves pending, second publish is idempotent, superseded job discarded, recovery drains pending events (§12.2)                                               | `test/review-ingestion.test.ts` (`transactional outbox recovery`, `outbox publish ordering`)                                          |
| `queue-retry.test.ts`       | `classifyFailure` / `retryPolicyFor`, outbox enqueue options, `processReviewJob`, `reconcileIncompleteReviews`         | Transient failure retries (recovery path), permanent failure does not, attempts/backoff match config, exhausted job ends failed (§12.4, §17.3)                                                            | `test/observability.test.ts` (retry policy), `test/review-workspace.test.ts` (worker processor), `test/recovery.test.ts` (exhaustion) |
| `findings.test.ts`          | `persistReviewFindings` / `getFindingsForReview` / `supersedeFindingsForReview` + Finding/FindingStatusTransition rows | Persist, fingerprint dedupe, supersede, lifecycle transition, transaction rollback leaves no partial rows (§7.1–§7.3, §13.1)                                                                              | `test/findings.test.ts`                                                                                                               |
| `publishing.test.ts`        | `publishReview` with an injected Octokit + ReviewComment rows                                                          | Stale head rejects publication, invalid inline position falls back to summary, duplicate summary/comments are not re-published, GitHub 5xx retries, 4xx does not (§4.4, §7.4, §13.1)                      | `test/publishing.test.ts`                                                                                                             |
| `admin-auth.test.ts`        | `createAdminApi` HTTP handler (+ `setGithubFetch`) + AuditLog rows                                                     | OAuth state/CSRF, session cookie, org membership, allowlist vs role policy, rate limit, audit row, unauthenticated/forbidden responses (§14.2, §15)                                                       | `test/admin-api.test.ts`                                                                                                              |
| `worker-shutdown.test.ts`   | `registerGracefulShutdown` in a child process + real SIGTERM                                                           | SIGTERM during an active job waits for completion within the deadline; forced timeout does not acknowledge unfinished work (§12.4, §17.3)                                                                 | `test/logger.test.ts` (`registerGracefulShutdown` registration smoke test)                                                            |
| `triage.test.ts`            | Probot `issues.opened` handler + global fetch transport                                                                | `issues.opened` posts a comment, bot issues are skipped, provider failure is logged without crashing the webhook (§1.2, §6.7)                                                                             | `test/index.test.ts`                                                                                                                  |

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

## Known characterization gaps

These flows could not be exercised end-to-end without adding a production seam,
which PR 0.4 forbids. They are tested through the closest existing public
boundary and must be revisited when the relevant module is moved.

1. **BullMQ retry execution.** The worker processor records the retry decision
   in structured logs but returns `"failed"` instead of rethrowing, and it marks
   the durable `ReviewJob` `failed` on the first failed attempt. Consequently the
   queue-level `attempts`/`backoff` options are visible metadata, not an observed
   retry loop. `queue-retry.test.ts` pins the configured options, the failure
   classification decisions, the reconciliation re-enqueue path (the retry
   mechanism that currently works), and recovery-exhaustion behaviour; it does
   **not** claim that a transient failure is re-attempted by BullMQ.
2. **Full worker shutdown.** `src/worker.ts` boots the agent runtime, workspace
   service, knowledge cache, metrics server and BullMQ worker. Starting that
   whole process in a test would require real provider/agent wiring. The suite
   characterizes the shared shutdown helper in a child process; the worker's
   concrete step list and ordering are not asserted here.
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

## Configuration coupling

Several assertions intentionally pin the checked-in `config/review.json`:
`github.defaultReviewType` is `handbook`, draft PRs are disabled, and
`queue.retry.infrastructure` is `3` attempts with `exponential` backoff. If that
configuration changes, update the expectations in this suite alongside it.
