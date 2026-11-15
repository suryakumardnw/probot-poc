# TypeScript Refactor — Final Verification Report

Date: 2026-11-15
Status: complete
Baseline: `e6a1b36` (536 tests) · Phase 4 code: `5cef56b` · Final fixes: `b76df7a`
Scope: PRs 5.1–5.2 plus the final whole-branch review fixes. Documentation,
verification, and targeted correctness/configuration fixes; the intentional
behavior changes are listed in §1.1.

Companions: [TypeScript profile](./typescript-profile.md) ·
[Gap analysis](./typescript-gap-analysis.md) ·
[Baseline metrics](./typescript-refactor-baseline.md) ·
[Architecture](./architecture.md) · [ADRs](./adr/README.md)

## 1. Outcome

The refactor is complete. The repository now has one enforced architecture,
boundary contracts at every external seam, repositories behind ports, injected
dependencies, a single edge error family, four test tiers, and CI gates that
run the same commands locally and remotely. All six P0 findings from the
[gap analysis](./typescript-gap-analysis.md) are closed at the HTTP/queue/outbox
edge scope; the internal error-family migration remains a documented follow-up.

The frozen characterization baseline is unchanged. The whole-branch review
also produced deliberate fixes that change edge behavior: atomic
ingestion/recovery writes, cross-module service boundaries, vendor adapters,
OAuth response parsing, and the configuration/correctness items in §1.1. No
characterization assertions were edited to make these pass.

The refactor added no `any`, no non-null assertions, no boundary
`JSON.parse(...) as` casts, and no `@ts-ignore`/`@ts-expect-error` to `src`.
The 11 remaining `as unknown as` casts predate or replace localized adapter
casts and are listed in §8.

### 1.1 Intentional correctness and configuration changes

These are intentional, test-pinned departures from the pre-refactor behavior.
They are not refactor side effects and do not alter the core review/publish
baseline; each is covered by unit, contract, integration, or characterization
tests.

| Area | Before | After | Why |
|---|---|---|---|
| Triage model call | Provider call could hang indefinitely. | 30 s default provider timeout (`GROQ_TRIAGE_DEFAULT_TIMEOUT_MS`). | Bounded best-effort triage; a slow provider no longer blocks the webhook handler forever. |
| Admin query input | Malformed `limit`, `offset`, or `pr` values were clamped/defaulted. | Invalid values return HTTP 400 with a validation `details` array. | Boundary validation should reject malformed input, not silently change it. |
| Admin OAuth configuration | Missing `ADMIN_OAUTH_CALLBACK_URL` produced a redirect containing `undefined`. | Admin is unconfigured and `/api/admin/*` returns the existing 503 envelope. | Fail closed on partial configuration instead of issuing a broken redirect. |
| `/review` environment | The handler could observe environment changes made after boot. | Handler uses the boot-time environment snapshot; `config/review.json` is still re-read per call. | Static deployment environment is the intended contract; the review config remains live. |
| `AgentRuntimeError("unknown")` | Message-pattern fallback could classify unknown agent failures as retryable. | Terminal by code; `AppError` codes no longer fall through to message matching. | Unknown agent failures follow the fail-immediately policy. |
| Publication findings | Repository rows were published in database-return order, including inactive rows. | Only active findings publish; order is `verified desc`, severity rank (`critical`→`informational`), then `createdAt asc`. | Superseded/resolved/dismissed findings must never publish; ordering is deterministic. |
| Automatic ingestion | `review.enabled`, `review.triggers.automatic`, and per-type switches were not consistently enforced. | Automatic triggers skip before any durable write when any switch is off; the per-type switch applies to manual ingestion too. | Configuration switches must actually control ingestion. |
| Reconciliation retries | Stale jobs were re-enqueued even when infrastructure retry was disabled. | `queue.retry.infrastructure.enabled=false` stops re-enqueueing; the `fail` policy still terminalizes. | Honor the operator's retry switch. |
| OAuth response parsing | Unchecked casts; missing/unknown membership fields defaulted to `member`/`active`. | Zod-parsed responses; malformed or missing fields fail closed with `GithubOauthError("unexpected_response")` (admin 502 envelope). | Never guess an authorization input. |
| Legacy `review_mode` | Queue recovery rejected legacy `standard`/`full` rows as invalid. | `LEGACY_REVIEW_MODES` are accepted at the queue boundary; new ingestion still writes `adaptive`/`fixed`. | Old non-terminal rows remain recoverable without changing new writes. |

## 2. Verification environment

| Item | Value |
|---|---|
| OS | Darwin 25.2.0, arm64 (macOS) |
| Node.js | v26.12.0 (host default; `engines.node` is `>=24`) |
| npm | 11.20.0 |
| TypeScript | 6.0.3 |
| Vitest | 3.2.7 |
| PostgreSQL | `localhost:5432`, database `reviewer`, 12 migrations, schema up to date |
| Redis | `localhost:6379` |
| Docker | 29.6.1, Compose v5.2.0 |
| Sandbox tests | `TMPDIR=/Users/surya/tmp` (shared mount for the Docker sandbox suite) |

## 3. Final quality metrics

`npm run metrics:quality` scans 208 TypeScript files under `src/` and 69 under
`test/` (baseline: 112 and 31). `Count` is occurrences; `Files` is the number
of files with at least one occurrence. The final counts include the
whole-branch review fixes.

| Metric | Scope | Baseline count | Final count | Baseline files | Final files |
|---|---|---:|---:|---:|---:|
| `any` type positions | src | 0 | **0** | 0 | **0** |
| `any` type positions | test | 17 | 5 | 6 | 2 |
| Non-null assertions (`!`) | src | 28 | **0** | 15 | **0** |
| Non-null assertions (`!`) | test | 120 | 54 | 13 | 5 |
| `as const` | src | 26 | 52 | 13 | 20 |
| `as const` | test | 6 | 17 | 3 | 12 |
| Other `as` casts | src | 132 | 66 | 43 | 30 |
| Other `as` casts | test | 103 | 103 | 22 | 27 |
| `as unknown as` | src | 26 | 11 | 11 | 6 |
| `as unknown as` | test | 40 | 35 | 14 | 12 |
| Boundary `JSON.parse(...) as` | src | 13 | **0** | 9 | **0** |
| Boundary `JSON.parse(...) as` | test | 22 | 24 | 8 | 9 |
| Prisma imports outside repositories/platform DB | src | 17 | **0** | 16 | **0** |
| Prisma imports outside repositories/platform DB | test | 1 | 3 | 1 | 3 |
| `process.env` reads outside `platform/config` | src | 70 | **0** | 24 | **0** |
| `process.env` reads outside `platform/config` | test | 61 | 137 | 14 | 24 |
| Cross-module internal imports | src | 0 | **0** | 0 | **0** |
| Test files requiring Postgres/Redis outside `test/integration` | test | 10 | 3 | 10 | 3 |

Targets achieved for `src`: zero `any`, zero non-null assertions, zero boundary
`JSON.parse(...) as`, zero Prisma imports outside repository/platform DB,
zero `process.env` reads outside `platform/config`, and zero cross-module
internal imports.

The test-scope increases are deliberate: the refactor added contract,
integration, characterization, and fake-heavy unit coverage. Test code is not
application code and the characterization tier keeps a documented lint
allowance (§8). `as const` and total `as` counts are informational; the goal was
zero unsafe boundary casts, not zero casts.

## 4. Test results

| Tier | Files | Tests | Duration | Infrastructure |
|---|---:|---:|---:|---|
| `npm run test:unit` | 27 | 517 | 2.70 s | None (service-free) |
| `npm run test:contract` | 10 | 207 | 1.35 s | None (service-free) |
| `npm run test:integration` | 22 | 293 | 27.40 s | Postgres + Redis + Docker sandbox |
| `npm run test:characterization` | 10 | 86 | 5.24 s | Postgres + Redis |
| **`TMPDIR=/Users/surya/tmp npm test`** | **69** | **1,103** | **40.59 s** | Full suite |

The unit and contract tiers (724 tests) are service-free: CI runs them in a job
with no Postgres/Redis service containers or dependency URLs. The integration
tier includes the Docker sandbox security suite; the characterization tier is
the frozen black-box behavioral baseline.

Baseline comparison: 31 files / 536 tests. Final: 69 files / 1,103 tests
(+38 files, +567 tests). The final fixes added the ingestion/recovery,
boundary, ordering, configuration-switch, and OAuth tests on top of the
1,059-test Phase 4 result.

## 5. Command results

| Command | Result |
|---|---|
| `npm run format:check` | Pass — all matched files use Prettier style |
| `npm run lint` | Pass — no errors |
| `npm run typecheck` | Pass |
| `npm run typecheck:tests` | Pass |
| `npm run build` | Pass |
| `npm run metrics:quality` | Pass — final counts in §3 |
| `npm run test:unit` | Pass — 27 files / 517 tests |
| `npm run test:contract` | Pass — 10 files / 207 tests |
| `npm run test:integration` | Pass with `TMPDIR=/Users/surya/tmp` — 22 files / 293 tests |
| `npm run test:characterization` | Pass — 10 files / 86 tests |
| `TMPDIR=/Users/surya/tmp npm test` | Pass — 69 files / 1,103 tests |
| `npm run security:audit` | Pass — 43 advisories, all high/critical allowlisted in `scripts/npm-audit-allowlist.json` |
| `bash scripts/smoke/docker-smoke.sh` | Pass — see §6 |

CI runs the same commands in six jobs: `Quality`, `Unit`, `Test`,
`Docker smoke`, `Commitlint`, and `Security`.

## 6. Docker Compose smoke

`bash scripts/smoke/docker-smoke.sh` passed on 2026-11-15:

```text
[docker-smoke] PASS: /healthz 200, /readyz ok, degraded server start,
worker ready and consuming review-jobs
```

The script built the production image and started the real Compose stack
(Postgres, Redis, the one-shot migration, Probot, and the worker) from
`deploy/docker-compose.yml`, `deploy/docker-compose.local.yml`, and
`scripts/smoke/docker-compose.smoke.yml`. It verified:

- `GET /healthz` returns 200 and `GET /readyz` reports Postgres and Redis `ok`.
- The server starts degraded when no GitHub App credentials are configured.
- The worker logs readiness with Postgres/Redis `ok` and connects a BullMQ
  consumer to the `review-jobs` queue.
- `migrate` exits 0 after applying the schema.

The project name, network, volumes, and containers are removed at the end of
the run. Container logs were written to `test-results/docker-smoke/` (ignored
build artifact).

## 7. Characterization evidence

The 10 characterization suites (86 tests) cover the frozen behavioral baseline:

- webhook ingestion and idempotency (`webhook-ingestion`),
- review state transitions and supersession (`review-state`),
- outbox publication and recovery (`outbox`),
- queue retry classification and retry exhaustion (`queue-retry`),
- worker shutdown and deadline behavior (`worker-shutdown`),
- publishing summary/inline output and duplicate reconciliation (`publishing`),
- findings validation, fingerprinting, and lifecycle (`findings`),
- admin auth/session/CSRF behavior (`admin-auth`),
- issue triage output (`triage`),
- agent/runtime error normalization (`runtime-errors`).

No characterization assertions were edited to make the refactor pass. The
tier retains its narrow `any`/`!` lint allowance because it is the black-box
baseline.

## 8. Remaining deviations and follow-ups

Every deviation below is either an approved stack adaptation or a localized,
documented implementation detail. The intentional edge behavior changes are
listed separately in §1.1; the items here are omissions or deferred cleanups,
not hidden behavior changes.

### 8.1 Eleven `as unknown as` casts in `src`

| File:line | Why it exists | Follow-up |
|---|---|---|
| `src/ports/review-logging.ts:31` | Capability probe for simplified test logger stubs without `child`. | Keep; the port boundary intentionally tolerates stubs. |
| `src/modules/workspace/git.ts:79` | Reads Node's numeric spawn error `code` after a type guard. | Could be modeled with a local `Error & { code?: number }` type; no behavior impact. |
| `src/platform/github/octokit.ts:23` | Adapts a concrete Octokit instance to the narrow `PublisherOctokit` port surface. | Keep; vendor adapter boundary. |
| `src/platform/observability/metrics.ts:193,196,197,200` | Reads/clears Prometheus metric internals that the library does not export. | Keep; test reset helper, confined to the platform adapter. |
| `src/platform/agents/sdk/host-process.ts:43` | Dynamic `import("@opencode/sdk")` returns a module typed as `unknown` to the sanitized child host. | Keep; the module is validated as `SdkModule` at the host boundary. |
| `src/platform/config/review-loader.ts:120,127` | Recursive redaction/clone preserves the input shape while replacing secret values. | Keep; shape-preserving projection, not a boundary parse. |
| `src/platform/config/review-loader.ts:285` | `structuredClone` result is narrowed to a mutable record before applying allowlisted overrides. | Keep; config patching is validated afterward. |

The refactor removed the 13 boundary `JSON.parse(...) as` casts and reduced
`as unknown as` from 26 to 11. The remaining casts are localized to
platform/module edges and are listed in §8.

### 8.2 Remaining plain `Error` classes

The `AppError` family covers failures at the HTTP and queue/outbox edges. Several
module/adapter errors still extend plain `Error` and are translated or
classified at the edge. A complete single-family migration remains a follow-up.

| Group | Classes | Current handling |
|---|---|---|
| Provider construction | `ProviderConfigError` (`TODO(error-family)`) | Adapter construction only; never crosses the provider port; mapped to startup/log failure. |
| Review engine | `ReviewEngineError` | Worker failure path; terminal unless a known code maps through `classifyFailure`. |
| Workspace retrieval | `ReviewRetrievalError` + `StaleCommitError`, `CloneFailedError`, `DiffFailedError` | Queue classifier maps retrieval/clone failures; stale is terminal. |
| Workspace files/git | `GitCommandError`, `PathEscapeError`, `FileTooLargeError`, `FileNotFoundError`, `CredentialUnavailableError` | Tool/workspace rejection paths; converted to invalid tool output or review failure. |
| Findings/knowledge/execution | `FindingValidationError`, `KnowledgeSnapshotError`, `ExecutionPolicyError`, `ExecutionError` | Domain failure paths; surfaced through the review result or audit. |
| Ingestion/publishing | `ManualIngestionError`, `StaleHeadError`, `ApiError` | Edge handlers map them to HTTP/404 or a stale/publish failure. |
| Config/OAuth/HTTP helpers | `EnvValidationError`, `ConfigValidationError` (`MissingEnvVarError`, `EmbeddedSecretError`), `GithubOauthError`, `BodyTooLargeError`, `InvalidBodyError` | Startup/config and HTTP edges translate them to envelopes/statuses. |
| Queue control flow | `ReviewJobRetryError` | Intentional control signal, not an application error. |

### 8.3 Test-tier allowances

- `test/characterization/**` turns off
  `@typescript-eslint/no-explicit-any` and
  `@typescript-eslint/no-non-null-assertion`. This is permanent until the
  frozen baseline is re-recorded: 5 `any` positions and 54 non-null assertions
  remain in that tier.
- Three test files are flagged by the "requires Postgres/Redis outside
  `test/integration`" metric: `test/characterization/queue-retry.test.ts`,
  `test/characterization/worker-shutdown.test.ts`, and `test/helpers/db.ts`.
  Characterization is intentionally an infrastructure tier, and the helper
  imports Prisma only to clean the database.
- Test-scope `as unknown as` (35) and `JSON.parse(...) as` (24) counts are
  fixture-construction and vendor-row assertions, not application boundaries.

### 8.4 Code and dependency follow-ups

| Item | Reason | Owner / next step |
|---|---|---|
| `manualReviewBodySchema` in `src/bootstrap/http.ts` | The only Zod schema still defined outside `src/contracts`; validated at the `/api/reviews` HTTP edge. | Move to `src/contracts/admin.ts` and import it from the composition root in a small `refactor(http)` PR. See ADR 0004. |
| Findings supersession is not wired into ingestion | `supersedeFindingsForReview` exists and is tested, but a superseded review does not mark its findings superseded. Publication filters to active findings, so stale rows cannot publish; the lifecycle gap remains. | Wire ingestion's supersede path to the findings store, or record the active-review filter as the permanent contract. |
| Manual `/api/reviews` still returns `{ error }` and is unauthenticated by design | The admin envelope migration covered `/api/admin/*` only. The manual trigger is an internal/deployment-scoped endpoint and intentionally has no session auth. | Decide whether to align it with the admin envelope and an auth policy; otherwise document it as a permanent interface exception. |
| Preflight queue failures bypass `classifyQueueFailure` | The durable lookup/claim happens before the processing `try`; routing it through the classifier needs job context. | Documented in `docs/queue-reliability.md`; deferred. |
| Docker sandbox tests need a shared `TMPDIR` on macOS | Docker volume mounts must be visible to the daemon; the integration suite passes with `TMPDIR=/Users/surya/tmp`. | Environmental, not a code regression; documented in `CONTRIBUTING.md` and this report. |
| Security-audit allowlist (4 high/critical advisory IDs) | Prisma 7 / Vitest 5 / upstream `@opencode/sdk` upgrades are major or upstream-blocked. | Tracked in `docs/security-audit-follow-ups.md`; `scripts/npm-audit-allowlist.json` fails on any new ID. |
| `src/modules/review/result-schema.ts` compatibility re-export | Keeps the contract move behavior-preserving; one contract test imports the shim. | Replace that import with `src/contracts/review.ts`, then delete the shim in a small `refactor(review)` PR. |
| `src/platform/agents/opencode-runtime.ts` (1,224 lines) and `opencode-sdk-runtime.ts` (886 lines) | Isolated adapters behind `AgentRuntime`; splitting them needs its own behavior-preserving PR and runtime tests. | Dedicated runtime split PR. |
| `exactOptionalPropertyTypes` deferred | Hundreds of optional properties intentionally accept `undefined`; enabling it is a data-shape decision, not a mechanical fix. | Compiler-hardening PR; see `docs/typescript-profile.md`. |
| `effect` pinned at `4.1.0` | `@opencode/sdk@2.3.0` depends on it; the root pin prevents Prisma's `effect@3.21.0` from winning peer resolution. | Keep; guarded by `test/deployment-node.test.ts`. |
| Reconciliation backoff is fixed (`exponential`, 5000 ms) | Attempt budgets are configuration-aware; backoff alignment is a follow-up. | Documented in `docs/queue-reliability.md`; deferred. |
| Orphaned job rows for terminal reviews | A crash between the review and job failure writes leaves an operator-cleanable row. | Documented in `docs/queue-reliability.md`; deferred. |
| 81 source files contain a stale `ARCHITECTURE.md` section reference (80 with `§...`) | The architecture doc was renumbered/shortened; comments still cite old section numbers. Comments only, no behavior. | Comment-only sweep in a later PR; update each reference to the current `docs/architecture.md` section or remove it. |
| `src/shared/errors/classify.ts` comment says the queue policy integration is still pending and that `src/shared/retry.ts` remains live “until that staged migration lands” | `classifyQueueFailure` now composes `classifyAppFailure`; the comment describes an earlier staging state. | Comment-only cleanup in a later PR. |

## 9. Acceptance criteria

| Criterion | Result |
|---|---|
| Every P0 gap closed | Edge scope met (P0 #5 internal error-family migration remains a follow-up); see the gap-analysis closure table. |
| Remaining deviations documented with reason and owner | Yes — §8 and the profile. |
| Service still deploys with the same commands | Yes — `npm run start:probot`, `npm run start:worker`, and the Compose smoke passed unchanged. |
| All docs links resolve | Yes — relative-link check across `README.md`, `CONTRIBUTING.md`, `docs/`, `docs/adr/`, `docs/specs/`, and `docs/plans/`. |
| Product behavior | Characterized review/publish behavior preserved; intentional edge changes are listed in §1.1 and covered by tests. | Qualified — the refactor was not literally behavior-free, and this report does not claim it was. |

## 10. Reproduction

```bash
npm ci
npx prisma migrate deploy
npm run metrics:quality
npm run test:unit
npm run test:contract
npm run test:integration
npm run test:characterization
TMPDIR=/Users/surya/tmp npm test
npm run lint
npm run typecheck
npm run typecheck:tests
npm run build
npm run security:audit
bash scripts/smoke/docker-smoke.sh
```
