# TypeScript Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development
> (recommended) or executing-plans to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `probot-poc` onto the approved modular-monolith architecture
without changing product behavior, in independently reviewable PRs that keep
the service buildable, testable, and deployable.

**Architecture:** Single npm package with two composition roots (server and
worker), vertical modules under `src/modules`, infrastructure adapters under
`src/platform`, interfaces under `src/ports`, Zod boundary schemas under
`src/contracts`, and repositories inside the modules that own their aggregates.
Every PR is behavior-preserving and separate from feature work.

**Tech Stack:** Node 24, TypeScript 6, ESM, Probot 14, PostgreSQL + Prisma 6,
Redis + BullMQ, Pino 10, Zod 4, Vitest 3, ESLint 9 + Prettier 3, GitHub Actions.

**Spec:** [TypeScript Refactor Design](../specs/2026-11-14-typescript-refactor-design.md)

## Global Constraints

- Keep the approved product stack: Node, TypeScript, Probot, Prisma, BullMQ,
  Pino, Zod, Vitest. Do not introduce Next.js, NestJS, Drizzle, pnpm,
  Turborepo, or a workspace layout.
- Keep a single npm package. Do not add `apps/` or `packages/`.
- Keep the existing Prisma schema and migrations. No schema changes in this
  refactor.
- No product features and no product behavior changes. The one approved
  interface change is the admin error envelope (PR 1.3); call it out in that PR.
- Every PR must leave `main` buildable, testable, and deployable. A PR that
  breaks an existing flow is rejected, not fixed forward.
- Never combine a module move with a behavior change. Move-only PRs use
  `git mv` and import updates only.
- No new `any` in type positions, no `!` non-null assertions, no unsafe `as` on
  untrusted data, and no `JSON.parse(...) as Shape` at a boundary.
- `src/contracts` imports only `zod`.
- `src/modules/*` must not import `src/platform/*` implementations.
- Modules import other modules only through their public `index.ts`.
- Only repository implementations import `@prisma/client`.
- Only `src/platform/config/**` reads `process.env`; scripts use `loadEnv()`.
- Only `src/platform/**` calls `fetch` or vendor SDKs.
- Preserve security behavior: Pino redaction, secret scrubbing, workspace path
  guards, sandbox policy, admin OAuth/session/CSRF, and audit logging.
- Keep EJS for the admin panel. Do not change the renderer.
- Keep the execution module and its tests. Do not wire it into review unless
  current live behavior already requires it; do not disable it.
- Capture characterization tests before deleting or moving any live flow.
- A test rewritten against a new internal seam does not prove behavior was
  preserved. The boundary characterization tests are the behavioral proof.
- Every PR updates `npm run metrics:quality` in its description. A PR may not
  increase any tracked violation; a phase must reduce the metric it targets.
- Commits follow Conventional Commits. One intent per PR. Refactor PRs do not
  carry product changes.
- Verification commands for every code PR:
  `npm run format:check && npm run lint && npm run typecheck && npm test && npm run build`.
  If the full suite needs Postgres/Redis, start them first and say so.

## Review Focus

The spec implies these failure modes; each gets a test in the task that owns it.

1. **Worker retry after partial GitHub publication.** A worker that dies after
   `createReview` succeeds but before the database write must not publish a
   duplicate summary review or duplicate inline comments on retry. Test in PR
   2.4 and PR 0.4.
2. **Duplicate webhook or job identity.** A duplicate GitHub delivery or a
   re-published outbox event must not create a second logical review or a second
   BullMQ job. Test in PR 0.4 and PR 2.8.
3. **Redis/outbox outage.** A Redis failure between the Postgres commit and the
   queue enqueue must leave the request durable and recoverable, never lost.
   Test in PR 0.4 and PR 2.8.
4. **Concurrent or repeated state transitions.** Two workers or a retry must not
   move a review backwards, duplicate a transition row, or publish a terminal
   review. Test in PR 2.7.
5. **Secret leakage through errors and logs.** New `AppError` details, HTTP
   envelopes, queue failure logs, and provider errors must not expose tokens,
   keys, SQL, paths, or internal identifiers. Test in PR 1.1 and PR 1.3.

## Decisions incorporated from review

| Review point | Plan response |
|---|---|
| Prisma transaction ownership | Module-owned unit-of-work port; callback receives a transaction-scoped repository bundle; no `Prisma.TransactionClient` in services. Only multi-repository atomic operations use it. |
| BullMQ idempotency/reliability | PR 2.8 documents and tests logical review identity, job identity, webhook dedupe, retry classification, failed-job recovery, and graceful shutdown. |
| Mandatory module boundaries | PR 3.1 adds the boundary lint scaffold; PR 3.12 turns on every rule with no exceptions. |
| Semantic error consistency | PR 1.1 adds `AppError` + central `classifyFailure`; HTTP status and queue retryability are separate axes, with table-driven tests. |
| Characterization before migration | PR 0.4 adds the boundary suite before any deletion or move. |
| Phase ordering | Repositories and composition roots are merged into Phase 2 with two exit gates; Phase 0 contains the behavioral baseline. |
| EJS | Kept; PR 3.7 moves and splits the panel without changing the renderer. |
| Execution module | Kept and tested; not wired into review unless already live. |
| ReviewWorkspace repository | Owned by `modules/workspace`; other modules use its public interface if needed. |
| Error codes | Added incrementally with the endpoint/job that produces them. |
| Quality metrics per phase | PR 0.1 adds the metrics script; every PR reports before/after counts. |

## Quality ledger

The baseline is captured by `npm run metrics:quality` in PR 0.1 and recorded in
`docs/typescript-refactor-baseline.md`. Until then, use these gap-analysis
counts as the expected starting point:

| Metric | Baseline | Target |
|---|---:|---|
| `any` in `src` type positions | 0 | 0 |
| Non-null assertions (`!`) in `src` | 7 | 0 |
| `as unknown as` in `src` | 24 | 0 |
| Boundary `JSON.parse(...) as ...` in `src` | 13 | 0 |
| Files importing `@prisma/client` outside repositories/platform DB | 16 | 0 |
| `process.env` files outside `platform/config` | 25 total (measure exact) | 0 |
| Cross-module internal imports | not measured yet | 0 |
| Circular imports | not measured yet | 0 |
| Test files requiring Postgres/Redis outside integration tier | 10 | only `test/integration` |

The metrics script counts `as const` separately and excludes comments. A cast
that is genuinely safe (for example, narrowing a vendor type at an adapter
boundary) must carry a one-line reason; the goal is zero unsafe boundary casts,
not zero casts in the entire codebase.

---

## Phase 0 — Behavioural baseline and guardrails

### PR 0.1 — Baseline report and quality metrics

**Objective and scope:** Capture a reproducible baseline before any code is deleted or
moved. Tooling and documentation only; no production code.

**Files / modules affected:**
- Create: `scripts/quality-metrics.mjs`
- Create: `docs/typescript-refactor-baseline.md`
- Modify: `package.json`

**Implementation steps:**
- [ ] Add `scripts/quality-metrics.mjs`. It walks `src/` and `test/` and prints a
      markdown table plus JSON with: `any` type positions, non-null assertions,
      `as const`, other `as` casts, `as unknown as`, boundary
      `JSON.parse(...) as`, Prisma imports outside `*.repository.ts` and
      `src/platform/db/**`, `process.env` outside `src/platform/config/**`,
      cross-module internal imports (once modules exist), and test files
      requiring Postgres/Redis outside `test/integration/**`.
- [ ] Skip comment-only lines (`//`, `*`, `/*`) when counting type violations.
- [ ] Add `"metrics:quality": "node scripts/quality-metrics.mjs"` to
      `package.json`.
- [ ] Run `npm run build`, `npm test` (with Postgres/Redis), and
      `npm run metrics:quality`. Record the exact commands, environment, and
      results in `docs/typescript-refactor-baseline.md`.
- [ ] Commit: `chore(refactor): capture typescript baseline metrics`.

**Tests / verification:**
- [ ] `npm run metrics:quality` produces the same counts on two consecutive
      runs.
- [ ] `npm run build` passes.
- [ ] The baseline document states the commit SHA and test environment.

**Acceptance criteria:**
- [ ] Baseline document is committed and matches the current code.
- [ ] Metrics script is deterministic and has no third-party dependencies.
- [ ] No production file changed.

**Risks / rollback strategy:**
- Regex false positives. Mitigation: document each pattern and inspect the
  first output manually. Rollback: delete the script and document.

**Dependencies on previous PRs:** none.

---

### PR 0.2 — ESLint, Prettier, commitlint, and CI

**Objective and scope:** Make style, correctness, and commit rules enforceable before the
structural work starts. Tooling and CI only; no production behavior change.

**Files / modules affected:**
- Create: `eslint.config.mjs`
- Create: `.prettierrc.json`
- Create: `.prettierignore`
- Create: `.editorconfig`
- Create: `commitlint.config.mjs`
- Create: `.github/workflows/ci.yml`
- Create: `.github/pull_request_template.md`
- Modify: `package.json`
- Modify: `CONTRIBUTING.md`
- Modify: `.gitignore` if the tool caches need ignoring

**Implementation steps:**
- [ ] Add ESLint flat config with `@eslint/js`, `typescript-eslint`,
      `eslint-plugin-import`, and Prettier compatibility. Start with the
      recommended rules plus:
      `@typescript-eslint/no-explicit-any`, `no-non-null-assertion`,
      `consistent-type-imports`, `import/order`, `import/no-cycle`, `eqeqeq`,
      `curly`, and `no-console` outside `src/scripts/**` and `test/**`.
- [ ] Set tests to `no-non-null-assertion: off` and `no-explicit-any: off`
      temporarily. Add a TODO in the config tying the override to PR 4.2.
- [ ] Add Prettier with `printWidth: 120`, `trailingComma: "all"`, and
      `endOfLine: "lf"`. Ignore `lib/`, `node_modules/`, `coverage/`,
      `prisma/migrations/`, and `docs/`.
- [ ] Add scripts: `lint`, `lint:fix`, `format`, `format:check`, `typecheck`.
- [ ] Add commitlint for `feat|fix|refactor|test|docs|perf|chore|ci` with an
      optional scope, imperative lowercase subject, no trailing period.
- [ ] Add `.github/workflows/ci.yml`:
      - `quality`: `npm ci`, `format:check`, `lint`, `typecheck`,
        `metrics:quality`.
      - `test`: Postgres 16 + Redis 7 service containers, `npm ci`,
        `npx prisma migrate deploy`, `npm test`, `npm run build`.
      - `commitlint`: validate the PR title/commit range.
      - `security`: `npm audit --audit-level=high` and a secret scan.
- [ ] Fix the small set of source lint errors that are not behavioral
      (unused imports, import order, `console` outside scripts).
- [ ] Add a PR template with: what changes for the user, what could break, how
      it was verified, quality-metrics before/after, rollback plan.
- [ ] Update `CONTRIBUTING.md` with the commands and the refactor rules.
- [ ] Commit: `chore(tooling): add eslint prettier commitlint and ci`.

**Tests / verification:**
- [ ] `npm run format:check` passes.
- [ ] `npm run lint` passes.
- [ ] `npm run typecheck` passes.
- [ ] `npm test` passes in CI with service containers.
- [ ] `npm run build` passes.
- [ ] A deliberately non-conventional commit or PR title fails commitlint.

**Acceptance criteria:**
- [ ] Every check runs locally with the same command as CI.
- [ ] No open lint rule is silently disabled in `src`; temporary test overrides
      are documented and assigned to PR 4.2.
- [ ] CI is required for merge (repository setting documented in the PR).

**Risks / rollback strategy:**
- Initial lint noise may hide behavioral issues. Mitigation: keep rule changes
  separate from code changes; list every fixed rule in the PR. Rollback: revert
  the tooling commit; no production code depends on it.

**Dependencies on previous PRs:** PR 0.1.

---

### PR 0.3 — Strict TypeScript flags

**Objective and scope:** Turn on the strictness flags the standards require and fix the
resulting type errors without runtime changes. Scope: `tsconfig.json` and
type-only fixes.

**Files / modules affected:**
- Modify: `tsconfig.json`
- Modify: source and test files flagged by the compiler

**Implementation steps:**
- [ ] Add `noUncheckedIndexedAccess` and `noImplicitOverride`.
- [ ] Add `verbatimModuleSyntax`; use ESLint `consistent-type-imports` to
      convert value imports used only as types.
- [ ] Defer `exactOptionalPropertyTypes`; record it as a decision in
      `docs/typescript-profile.md` with the reason and a follow-up ticket.
- [ ] Fix array/record indexing with guards, `Map`, or explicit lookups. Do not
      add `!` to silence the compiler.
- [ ] Fix override declarations and type-only imports.
- [ ] Run the full suite; no runtime behavior may change.
- [ ] Commit: `chore(types): enable stricter compiler flags`.

**Tests / verification:**
- [ ] `npm run typecheck` passes.
- [ ] `npm test` passes.
- [ ] `npm run build` passes.
- [ ] `npm run metrics:quality` shows no new `any`, `!`, or `as` casts.

**Acceptance criteria:**
- [ ] The three flags are on.
- [ ] No `@ts-ignore` or `@ts-expect-error` added.
- [ ] No runtime code path changed beyond equivalent narrowing.

**Risks / rollback strategy:**
- Large compiler diff. Mitigation: separate mechanical fixes from semantic
  fixes; review per file. Rollback: revert the flags and fixes; no data change.

**Dependencies on previous PRs:** PR 0.2.

---

### PR 0.4 — Characterization suite for critical flows

**Objective and scope:** Pin current production behavior at its existing boundaries
before any deletion or move. Tests only; no production code.

**Files / modules affected:**
- Create: `test/characterization/webhook-ingestion.test.ts`
- Create: `test/characterization/review-state.test.ts`
- Create: `test/characterization/outbox.test.ts`
- Create: `test/characterization/queue-retry.test.ts`
- Create: `test/characterization/findings.test.ts`
- Create: `test/characterization/publishing.test.ts`
- Create: `test/characterization/admin-auth.test.ts`
- Create: `test/characterization/worker-shutdown.test.ts`
- Create: `test/characterization/triage.test.ts`
- Create: `test/characterization/README.md`

**Implementation steps — required test cases:**
- [ ] Webhook ingestion: `opened`, `synchronize`, `ready_for_review`, manual
      trigger, unsupported action, bot author, draft PR.
- [ ] Duplicate delivery: same `deliveryId` twice creates one review; same
      `(PR, headSha, mode, type)` with a new delivery creates one review; a
      forced manual re-review increments `attempt`.
- [ ] Review state: every allowed transition, every invalid transition,
      idempotent same-state transition, terminal state rejects further moves.
- [ ] Outbox: Redis available publishes; Redis unavailable leaves the event
      pending; a second publish is idempotent; a superseded job is discarded;
      recovery drains pending events.
- [ ] Queue retry: transient failure retries; permanent failure does not;
      attempts/backoff match config; exhausted job ends failed.
- [ ] Findings: persist, fingerprint dedupe, supersede, lifecycle transition,
      transaction rollback leaves no partial rows.
- [ ] Publishing: stale head rejects publication; invalid inline position falls
      back to summary; duplicate summary/comments are not re-published; GitHub
      5xx retries; 4xx does not.
- [ ] Admin auth: OAuth state/CSRF, session cookie, org membership, allowlist vs
      role policy, rate limit, audit row, unauthenticated/forbidden responses.
- [ ] Worker shutdown: SIGTERM during an active job waits for completion within
      the deadline; a forced timeout does not acknowledge unfinished work.
- [ ] Triage: `issues.opened` posts a comment, bot issues are skipped, provider
      failure is logged without crashing the webhook.
- [ ] `test/characterization/README.md` maps each test to the design requirement
      and the existing test it extends.

**Rules:**
- [ ] Tests use public boundaries: HTTP handlers, exported service functions,
      BullMQ/outbox APIs, Postgres/Redis state. Do not test private internals.
- [ ] Mark the suite as requiring Postgres/Redis in the README.
- [ ] Do not modify production code. If a flow is not testable without a seam,
      test it through the closest existing public boundary and record the gap in
      the README; do not refactor production code in this PR.

**Tests / verification:**
- [ ] `npx vitest run test/characterization --no-file-parallelism` passes
      against the current code.
- [ ] `npm test` remains green.
- [ ] The suite fails if a deliberate temporary behavior change is introduced
      (spot-check one test manually).

**Acceptance criteria:**
- [ ] Every critical flow in the design's testing section has a boundary test.
- [ ] The suite passes before any production deletion/move.
- [ ] The README lists any flow that still needs a seam.

**Risks / rollback strategy:**
- Characterization tests may encode incidental behavior. Mitigation: assert
  externally observable results (rows, HTTP bodies, published calls), not
  implementation details. Rollback: delete the suite; no production impact.

**Dependencies on previous PRs:** PR 0.2 (and PR 0.3 for compiler clean-up).

---

### PR 0.5 — Delete the dead legacy path; keep the `effect` pin

**Objective and scope:** Remove code that no live path uses, after the baseline is
green. Deletion only. Keep `effect`: it is a transitive dependency of
`@opencode/sdk`, not an unused import (ruling 2026-11-15).

**Files / modules affected:**
- Delete: `src/controllers/pull-request.controller.ts`
- Delete: `src/services/review.service.ts`
- Delete: `src/views/review.view.ts`
- Delete: `src/models/review.ts` (orphaned by the deletions above)
- Modify: docs that describe the dead path or the `effect` decision

**Implementation steps:**
- [ ] Confirm with `rg` that `handlePullRequest`, `reviewPullRequest`, and
      `renderReviewComment` have no importers outside the deleted files.
- [ ] Confirm `src/controllers/issue.controller.ts` and the triage path remain
      live; do not delete them.
- [ ] Delete the three files, then delete `src/models/review.ts` if it has no
      importers. Remove the now-empty `src/views/` directory only if
      `triage.view.ts` has moved; otherwise leave it.
- [ ] Confirm `effect` has no direct imports in `src`, `test`, `scripts`, or
      config. Do **not** run `npm uninstall effect`: `@opencode/sdk@2.3.0`
      depends on `effect@4.1.0`, and the root pin keeps Prisma's
      `effect@3.21.0` out of its peer slot. `test/deployment-node.test.ts`
      guards the pin.
- [ ] Run the full suite and build.
- [ ] Commit: `refactor: remove dead legacy review path`.

**Tests / verification:**
- [ ] `npm test` passes.
- [ ] `npm run build` passes.
- [ ] `rg 'handlePullRequest|reviewPullRequest|renderReviewComment|from "effect' src test` returns nothing.
- [ ] `npm run metrics:quality` is unchanged or better.

**Acceptance criteria:**
- [ ] No live behavior changes.
- [ ] `effect` stays pinned at `4.1.0` in `package.json`; no direct imports in
      `src`, `test`, `scripts`, or config. It remains in the lockfile as the
      SDK's transitive dependency.
- [ ] The dead path no longer appears in docs that describe the live flow (note
      follow-up in PR 5.1 if needed).

**Risks / rollback strategy:**
- Hidden dynamic import. Mitigation: `rg` plus build plus full suite. Rollback:
  revert the deletion commit; the files are restored exactly.

**Dependencies on previous PRs:** PR 0.4.

---

## Phase 1 — Contracts and errors

### PR 1.1 — `AppError` family and failure classifier

**Objective and scope:** Introduce one error family and one classifier for HTTP and
queue/outbox decisions.

**Files / modules affected:**
- Create: `src/shared/errors/app-error.ts`
- Create: `src/shared/errors/subclasses.ts`
- Create: `src/shared/errors/classify.ts`
- Create: `src/shared/errors/index.ts`
- Create: `src/platform/http/error-mapper.ts`
- Create: `src/platform/http/error-mapper.test.ts`
- Create: `src/shared/errors/classify.test.ts`
- Create: `src/contracts/errors.ts` (schema + code types)
- Modify: `src/admin/api.ts` only where an existing error is trivially
  convertible; full admin migration is PR 1.3.

**Interfaces:**
- `AppError` fields: `code: string`, `statusCode: number`, `retryable: boolean`,
  `details?: unknown`, standard `cause`.
- Subclasses: `ValidationError` (400, false), `AuthError` (401, false),
  `ForbiddenError` (403, false), `NotFoundError` (404, false),
  `ConflictError` (409, false), `RateLimitError` (429, true),
  `ProviderError` (502/503, per provider code), `InternalError` (500, false).
- `classifyFailure(error: unknown, context: "http" | "queue" | "outbox"):
  { disposition: "retry" | "fail"; code: string; reason: string }`.
- `toHttpEnvelope(error: unknown): { statusCode: number; body: ErrorEnvelope }`.

**Implementation steps:**
- [ ] Write failing tests for each error class: status code, retryable,
      classification in each context, unknown error -> 500/`INTERNAL_ERROR`/no
      retry by default, `ProviderError` -> retry only for rate-limit/network/5xx.
- [ ] Write a secret-leak test: an error whose `cause` contains a token must
      produce an envelope and log payload without the token.
- [ ] Implement `AppError`, subclasses, `classifyFailure`, and
      `toHttpEnvelope`.
- [ ] Add contract tests for `errorEnvelopeSchema`.
- [ ] Run tests and commit: `feat(errors): add app error family and failure classifier`.

**Tests / verification:**
- [ ] `npm test -- src/shared/errors src/platform/http`
- [ ] `npm run typecheck`
- [ ] `npm run metrics:quality`

**Acceptance criteria:**
- [ ] Every subclass has a table-driven test for status and retryability.
- [ ] The classifier is the only place that maps error -> retry/fail.
- [ ] No stack, SQL, token, or path appears in an envelope.

**Risks / rollback strategy:** Classification differences may alter retry behavior.
Mitigation: existing tests plus characterization queue tests. Rollback: revert
the PR; no callers depend on it yet except the mapper.

**Dependencies on previous PRs:** PR 0.5.

---

### PR 1.2 — Queue and outbox contracts

**Objective and scope:** Make the queue/outbox boundary a parsed contract instead of a
cast and silent defaults.

**Files / modules affected:**
- Create: `src/contracts/queue.ts`
- Modify: `src/ingestion/queue.ts`
- Modify: `src/ingestion/outbox.ts`
- Modify: `src/recovery/reconciliation.ts`
- Modify: `src/server.ts`, `src/worker.ts` where payloads are constructed
- Create: `src/contracts/queue.test.ts`

**Interfaces:**
- `reviewJobPayloadSchema` -> `ReviewJobPayload` with `reviewId`, `jobKey`,
  `githubInstallationId`, `githubRepositoryId`, `repositoryFullName`,
  `pullRequestNumber`, `headSha`, `baseSha`, `reviewMode`
  (`"adaptive" | "fixed"`), `reviewType`
  (`"standard" | "skill" | "handbook"`), `trigger`, and `configurationHash`.
- `outboxPayloadSchema` -> `OutboxPayload`.
- `ingestOutcomeSchema` for the status API if it crosses HTTP.

**Implementation steps:**
- [ ] Write contract tests: valid payload, missing field, wrong type, unknown
      review type, invalid trigger.
- [ ] Replace the hand-written `ReviewJobPayload` type with `z.infer`.
- [ ] Parse outbox payloads in `publishOutboxEvent`; replace the
      `as Partial<ReviewJobPayload>` + defaults with a parse and a typed
      `ValidationError`/`InternalError` on invalid data.
- [ ] Keep backward compatibility for existing queued payloads: the schema must
      accept the current shape. Do not add required fields.
- [ ] Parse at the worker boundary; a malformed job fails with a permanent
      code, not a retry loop.
- [ ] Run tests and commit: `refactor(queue): validate queue and outbox payloads`.

**Tests / verification:**
- [ ] `npm test -- test/review-ingestion.test.ts test/recovery.test.ts test/characterization/outbox.test.ts`
- [ ] `npm run typecheck`
- [ ] `rg 'as Partial<ReviewJobPayload>|JSON.parse.*as ' src/ingestion` returns
      no boundary cast.

**Acceptance criteria:**
- [ ] Queue/outbox payloads have one schema and one inferred type.
- [ ] Invalid payloads produce a stable error code.
- [ ] No silent defaults for missing required fields.

**Risks / rollback strategy:** Tightening types can reject old payloads. Mitigation:
backward-compatible schema and characterization tests. Rollback: revert to the
previous type; no schema migration.

**Dependencies on previous PRs:** PR 1.1.

---

### PR 1.3 — Admin contracts and HTTP error envelope

**Objective and scope:** Give the admin HTTP API one request/response contract and one
error envelope.

**Files / modules affected:**
- Create: `src/contracts/admin.ts`
- Modify: `src/admin/api.ts`
- Modify: `src/admin/panel.ts` where it calls the API
- Modify: `test/admin-api.test.ts`, `test/admin-panel.test.ts`
- Create: `src/contracts/admin.test.ts`

**Interfaces:**
- `triggerReviewBodySchema`, `compareQuerySchema`, `configUpdateBodySchema`,
  `reviewStatusResponseSchema`, `adminErrorEnvelopeSchema`.
- `sendJson`/`sendError` helpers take a contract type.

**Implementation steps:**
- [ ] Write contract tests for each admin request/query/response shape.
- [ ] Update admin tests to expect `{ code, message, statusCode, details? }` for
      every error response.
- [ ] Validate every JSON body and query string at the route boundary; no
      route-specific ad-hoc parsing.
- [ ] Replace hand-built `{ error: string }` bodies with the envelope; unknown
      errors map through `toHttpEnvelope`.
- [ ] Keep HTTP status semantics: validation 400, auth 401, forbidden 403,
      not-found 404, conflict 409, rate-limit 429, internal 500.
- [ ] Document the intentional API contract change in the PR description and
      `docs/typescript-profile.md`.
- [ ] Run tests and commit: `refactor(admin): validate admin contracts and error envelope`.

**Tests / verification:**
- [ ] `npm test -- test/admin-api.test.ts test/admin-panel.test.ts`
- [ ] `npm run typecheck`
- [ ] Manual: `curl` an invalid body and confirm the envelope and no secret.

**Acceptance criteria:**
- [ ] Every admin route validates its input.
- [ ] Every error response uses the envelope.
- [ ] The panel still works with EJS and the existing session/CSRF flow.
- [ ] No secret/token appears in an envelope or log.

**Risks / rollback strategy:** API consumers see a new error shape. Mitigation: this is
the approved contract change; update tests and docs. Rollback: revert the PR;
the old shape returns.

**Dependencies on previous PRs:** PR 1.1.

---

### PR 1.4 — Model and agent protocol contracts

**Objective and scope:** Remove cast-based parsing from model responses, agent NDJSON
events, and the SDK host protocol.

**Files / modules affected:**
- Create: `src/contracts/model.ts`
- Create: `src/contracts/agent.ts`
- Move: `src/review-engine/result-schema.ts` -> `src/contracts/review.ts`
- Modify: `src/review-engine/engine.ts` and `src/eval/**` to import the result
  schema from `contracts`
- Modify: `src/models/openai-compatible.ts`
- Modify: `src/agent/opencode-runtime.ts`
- Modify: `src/agent/opencode-sdk-runtime.ts`
- Modify: `src/agent/sdk/client.ts`
- Modify: `src/agent/sdk/host-process.ts`
- Modify: `src/agent/sdk/host.ts`
- Create: `src/contracts/model.test.ts`, `src/contracts/agent.test.ts`,
  `src/contracts/review.test.ts`

**Implementation steps:**
- [ ] Write contract tests for the raw OpenAI-compatible response/error shapes,
      the review result schema, and representative agent event fixtures.
- [ ] Replace `JSON.parse(...) as ChatCompletionPayload` with a schema parse.
- [ ] Replace `JSON.parse(...) as OpenCodeEvent` / `SdkHostResponse` /
      `SdkHostRequest` with schema parses at the process boundary.
- [ ] Move the review result schema to `contracts/review.ts`; keep a temporary
      re-export from `review-engine` until PR 3.4.
- [ ] Malformed events become typed `AgentRuntimeError`/`ProviderError` with a
      permanent code; do not crash the whole worker.
- [ ] Keep existing event fixtures passing; add one malformed fixture per
      protocol.
- [ ] Commit: `refactor(contracts): validate model and agent protocol messages`.

**Tests / verification:**
- [ ] `npm test -- test/agent-runtime.test.ts test/agent-sdk-runtime.test.ts test/model-provider.test.ts test/contracts`
- [ ] `npm run typecheck`
- [ ] `rg 'JSON.parse.*\) as ' src/agent src/models` returns no boundary cast.

**Acceptance criteria:**
- [ ] No cast-parsed external JSON remains in these paths.
- [ ] Malformed input fails closed with a stable code.
- [ ] Existing model/agent behavior is unchanged.

**Risks / rollback strategy:** Overly strict schemas may reject valid provider output.
Mitigation: permissive optional fields where the provider legitimately varies;
fixtures from the existing tests. Rollback: revert the parse for the offending
protocol and record the deviation.

**Dependencies on previous PRs:** PR 1.1.

---

### PR 1.5 — Config contracts and boundary cast sweep

**Objective and scope:** Put config schemas under `contracts` and remove the remaining
untyped JSON boundary casts.

**Files / modules affected:**
- Create: `src/contracts/config.ts`
- Create: `src/contracts/index.ts` (public barrel; exports schemas/types only)
- Create: `src/contracts/knowledge.ts` if needed for manifest/fetch responses
- Modify: `src/config/env.ts`
- Modify: `src/config/review-schema.ts`
- Modify: `src/config/review-loader.ts`
- Modify: `src/knowledge/fetch.ts`
- Modify: `src/knowledge/ensure-skills.ts`
- Modify: `src/admin/panel.ts` (form JSON)
- Modify: `src/scripts/eval-run.ts` (benchmark JSON)
- Create: corresponding contract tests

**Implementation steps:**
- [ ] Move env and review config schemas to `src/contracts/config.ts`; re-export
      from the old modules so imports keep working until Phase 3.
- [ ] Add schemas for GitHub tree/content responses used by fo knowledge fetch
      and the skill manifest.
- [ ] Parse admin panel JSON and benchmark suite JSON.
- [ ] Keep validation error messages safe and actionable.
- [ ] Commit: `refactor(contracts): validate config and remaining json boundaries`.

**Tests / verification:**
- [ ] `npm test -- test/env.test.ts test/review-config.test.ts test/knowledge.test.ts test/evaluation.test.ts`
- [ ] `npm run typecheck`
- [ ] `rg 'JSON.parse\([^\n]*\) as ' src` returns nothing.

**Acceptance criteria:**
- [ ] Config schemas live under `contracts` with inferred types.
- [ ] No boundary `JSON.parse as` remains in `src`.
- [ ] Existing config behavior is unchanged.

**Risks / rollback strategy:** Schema drift with old config files. Mitigation: keep
defaults and backward-compatible fields; test the real `config/review.json`.
Rollback: revert the schema move and keep the old loader.

**Dependencies on previous PRs:** PR 1.1, PR 1.2.

---

## Phase 2 — Persistence and composition roots

> **Phase rule:** PRs 2.1–2.5 extract repositories; PR 2.6 removes the hidden
> singletons and wires composition roots. They are one phase because the
> constructor changes land in the same files. The two exit gates are listed in
> the design.
>
> During PRs 2.1–2.5, a module may keep a **temporary local factory** that
> constructs its repositories from `getPrisma()`/`getRedis()` at the module
> edge. Service functions receive the repositories/UoW and never call the
> singleton. PR 2.6 deletes every temporary factory and wires the same
> interfaces from `bootstrap/`.

### PR 2.1 — Ingestion repositories and unit of work

**Objective and scope:** Move ingestion persistence behind repository interfaces and an
atomic unit-of-work port.

**Files / modules affected:**
- Create: `src/ingestion/ingestion.repository.ts`
- Create: `src/ingestion/prisma-ingestion.repository.ts`
- Create: `src/ingestion/outbox.repository.ts`
- Create: `src/ingestion/prisma-outbox.repository.ts`
- Create: `src/ingestion/ingestion.unit-of-work.ts`
- Create: `src/ingestion/prisma-ingestion.unit-of-work.ts`
- Modify: `src/ingestion/orchestrator.ts`
- Modify: `src/ingestion/outbox.ts`
- Modify: `src/ingestion/review-state.ts`
- Create: `test/integration/ingestion-repository.test.ts`
- Create: `test/integration/ingestion-unit-of-work.test.ts`

**Interfaces:**
```ts
interface IngestionRepositories {
  installations: InstallationRepository;
  repositories: RepositoryRepository;
  pullRequests: PullRequestRepository;
  reviews: ReviewRepository;
  reviewJobs: ReviewJobRepository;
  stateTransitions: ReviewStateTransitionRepository;
  webhookDeliveries: WebhookDeliveryRepository;
  outboxEvents: OutboxRepository;
}
interface IngestionUnitOfWork {
  execute<T>(work: (repos: IngestionRepositories) => Promise<T>): Promise<T>;
}
```

**Implementation steps:**
- [ ] Write failing integration tests for each repository method and for UoW
      commit/rollback: throw inside the callback -> no rows; success -> all rows.
- [ ] Implement the interfaces and Prisma implementations; map rows/enums to
      domain/contract types.
- [ ] Make `ingestReviewRequest` use `unitOfWork.execute` for the multi-write
      transaction.
- [ ] Use repository methods directly for single-write operations.
- [ ] Keep a temporary `createIngestionServices(prisma)` factory at the module
      edge for PR 2.1; PR 2.6 replaces it with bootstrap wiring. Service
      functions receive repositories/UoW and never call `getPrisma()`.
- [ ] Do not pass a Prisma transaction client through a service signature.
- [ ] Commit: `refactor(ingestion): add repositories and unit of work`.

**Tests / verification:**
- [ ] `npm test -- test/review-ingestion.test.ts test/characterization/webhook-ingestion.test.ts test/integration/ingestion-*`
- [ ] `npm run typecheck`
- [ ] `rg 'getPrisma\(|prisma\.' src/ingestion` shows only repository/UoW files.

**Acceptance criteria:**
- [ ] Ingestion service has no Prisma import.
- [ ] The multi-write intake is atomic.
- [ ] Repository tests cover success and rollback.

**Risks / rollback strategy:** Transaction semantics change. Mitigation: preserve the
same transaction boundary and default isolation; rollback tests. Rollback:
revert to direct Prisma calls in the orchestrator; no schema change.

**Dependencies on previous PRs:** PR 1.2, PR 1.5.

---

### PR 2.2 — Split the ingestion orchestrator

**Objective and scope:** Separate the durable intake service, outbox publisher, state
machine, and recovery into focused files.

**Files / modules affected:**
- Create: `src/ingestion/ingestion.service.ts`
- Create: `src/ingestion/outbox.service.ts`
- Create: `src/ingestion/review-state.service.ts`
- Create: `src/ingestion/recovery.service.ts`
- Modify/delete: `src/ingestion/orchestrator.ts`
- Modify: `src/ingestion/index.ts`
- Modify: callers in `src/server.ts`, `src/worker.ts`, `src/admin/api.ts`

**Implementation steps:**
- [ ] Move functions by responsibility; keep exported signatures stable until
      callers are updated.
- [ ] Keep `getReviewStatus` and `ingestManualReview` in the ingestion service
      or a read service.
- [ ] No behavior change; imports only.
- [ ] Commit: `refactor(ingestion): split orchestrator by responsibility`.

**Tests / verification:**
- [ ] `npm test -- test/review-ingestion.test.ts test/recovery.test.ts`
- [ ] `npm run build`
- [ ] `wc -l src/ingestion/*.ts` shows no file over 350 lines.

**Acceptance criteria:**
- [ ] Each file has one responsibility.
- [ ] Existing public behavior is unchanged.
- [ ] No file over 350 lines without a documented reason.

**Risks / rollback strategy:** Import churn. Mitigation: move-only, no logic edit.
Rollback: revert the split commit.

**Dependencies on previous PRs:** PR 2.1.

---

### PR 2.3 — Findings repository and unit of work

**Objective and scope:** Move finding persistence behind a repository and make
persist/supersede atomic.

**Files / modules affected:**
- Create: `src/findings/findings.repository.ts`
- Create: `src/findings/prisma-findings.repository.ts`
- Create: `src/findings/findings.unit-of-work.ts`
- Create: `src/findings/prisma-findings.unit-of-work.ts`
- Modify: `src/findings/store.ts`
- Modify: `src/findings/index.ts`
- Create: `test/integration/findings-repository.test.ts`

**Implementation steps:**
- [ ] Write failing repository and UoW tests: persist + supersede commit
      together; throw -> no partial rows; duplicate fingerprint is idempotent.
- [ ] Implement the repository and UoW; keep fingerprint/validation pure.
- [ ] Update `persistReviewFindings` and `supersedeFindingsForReview` to use the
      UoW.
- [ ] Commit: `refactor(findings): add repository and transaction boundary`.

**Tests / verification:**
- [ ] `npm test -- test/findings.test.ts test/characterization/findings.test.ts`
- [ ] `rg '@prisma/client' src/findings` shows only repository/UoW files.

**Acceptance criteria:**
- [ ] Findings service has no Prisma import.
- [ ] Persist/supersede is atomic.
- [ ] Deduplication and lifecycle behavior are unchanged.

**Risks / rollback strategy:** Fingerprint/lifecycle behavior is subtle. Mitigation:
characterization tests; no logic changes. Rollback: revert; no schema change.

**Dependencies on previous PRs:** PR 2.1.

---

### PR 2.4 — Publishing repository and GitHub port

**Objective and scope:** Isolate review-comment persistence and the Octokit surface behind
a repository and a port.

**Files / modules affected:**
- Create: `src/publishing/publishing.repository.ts`
- Create: `src/publishing/prisma-publishing.repository.ts`
- Create: `src/ports/github-publisher.ts` (move the Octokit surface from
  `src/publishing/publisher.ts` if practical)
- Modify: `src/publishing/publisher.ts`
- Modify: `src/publishing/pipeline.ts`
- Modify: `src/publishing/summary.ts`
- Create: `test/integration/publishing-repository.test.ts`
- Extend: `test/characterization/publishing.test.ts`

**Implementation steps:**
- [ ] Write failing tests for comment persistence and publication idempotency:
      existing summary review is reused; duplicate fingerprint is skipped;
      partial publication retry does not duplicate.
- [ ] Implement the repository; keep Octokit behind the port.
- [ ] Remove direct Prisma calls from `publisher.pipeline`/`publisher`.
- [ ] Keep stale-head, inline fallback, and retry behavior unchanged.
- [ ] Commit: `refactor(publishing): isolate repository and github port`.

**Tests / verification:**
- [ ] `npm test -- test/publishing.test.ts test/characterization/publishing.test.ts`
- [ ] `rg '@prisma/client' src/publishing` shows only repository files.

**Acceptance criteria:**
- [ ] Publishing service has no Prisma import.
- [ ] Partial-publication retry is characterized and duplicate-free.
- [ ] GitHub error classification still uses the approved rules.

**Risks / rollback strategy:** Publication idempotency is production-critical.
Mitigation: characterization tests first; no logic changes in the move. Rollback:
revert; already-published reviews are unaffected.

**Dependencies on previous PRs:** PR 2.1.

---

### PR 2.5 — Admin, workspace, and audit repositories

**Objective and scope:** Remove the remaining direct Prisma access from admin and
workspace, and confirm `ReviewWorkspace` ownership.

**Files / modules affected:**
- Create: `src/admin/audit.repository.ts`
- Create: `src/admin/prisma-audit.repository.ts`
- Create: `src/workspace/workspace.repository.ts`
- Create: `src/workspace/prisma-workspace.repository.ts`
- Create: `src/ports/review-config.ts` (`ReviewConfigStore` interface)
- Create: `src/platform/config/review-config-store.ts` (implementation; may
  live beside the loader until PR 3.10)
- Modify: `src/admin/api.ts`, `src/admin/panel.ts`
- Modify: `src/workspace/workspace.ts`
- Modify: `src/ingestion/ingestion.service.ts` to receive the config store
- Modify: `src/recovery/reconciliation.ts` (use workspace public sweep)
- Create: `test/integration/admin-audit.test.ts`
- Create: `test/integration/workspace-repository.test.ts`
- Create: `test/integration/review-config-store.test.ts`

**Implementation steps:**
- [ ] Write failing repository tests for audit rows, workspace rows, and config
      store reads/updates.
- [ ] Move admin audit writes behind the audit repository.
- [ ] Move `ReviewWorkspace` create/update/find/sweep behind the workspace
      repository. `workspace` owns the aggregate; recovery uses the public
      sweep callback.
- [ ] Replace admin review-status queries with the ingestion public service.
- [ ] Put review config load/update behind `ReviewConfigStore`; inject it into
      admin and ingestion so modules never import `platform/config`.
- [ ] Commit: `refactor(admin, workspace): add repositories and config port`.

**Tests / verification:**
- [ ] `npm test -- test/admin-api.test.ts test/admin-panel.test.ts test/review-workspace.test.ts test/recovery.test.ts`
- [ ] `rg '@prisma/client' src/admin src/workspace` shows only repository files.

**Acceptance criteria:**
- [ ] Admin and workspace services have no Prisma import.
- [ ] `ReviewWorkspace` has one owner.
- [ ] Audit behavior and workspace cleanup are unchanged.

**Risks / rollback strategy:** Recovery/cleanup paths are easy to break. Mitigation:
characterization tests for recovery and workspace. Rollback: revert; no schema
change.

**Dependencies on previous PRs:** PR 2.1, PR 2.2.

---

### PR 2.6 — Composition roots and singleton removal

**Objective and scope:** Make server and worker wiring explicit and remove hidden
process-wide singletons.

**Files / modules affected:**
- Create: `src/bootstrap/clients.ts`
- Create: `src/bootstrap/server.ts`
- Create: `src/bootstrap/worker.ts`
- Create: `src/bootstrap/http.ts`
- Create: `src/ports/logger.ts`
- Create: `src/ports/clock.ts`
- Create: `src/ports/index.ts` (public barrel)
- Modify: `src/server.ts`
- Modify: `src/worker.ts`
- Modify: `src/index.ts`
- Modify: `src/lib/prisma.ts` -> factory only
- Modify: `src/lib/redis.ts` -> factory only
- Modify: `src/ingestion/queue.ts` -> factory only
- Modify: `src/lib/logger.ts`, `src/lib/health.ts`, `src/lib/shutdown.ts` as needed
- Modify: modules that import `pino` directly to use `ports/logger`
- Create: `test/helpers/db.ts` for tests that still need a real client
- Modify: tests importing `getPrisma`/`getRedis`/`getReviewQueue`

**Interfaces:**
```ts
export async function bootstrapServer(): Promise<void>;
export async function bootstrapWorker(): Promise<void>;

interface Logger {
  debug(message: string): void;
  debug(obj: Record<string, unknown>, message: string): void;
  info(message: string): void;
  info(obj: Record<string, unknown>, message: string): void;
  warn(message: string): void;
  warn(obj: Record<string, unknown>, message: string): void;
  error(message: string): void;
  error(obj: Record<string, unknown>, message: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

interface Clock { now(): Date; }
```

**Implementation steps:**
- [ ] Write a bootstrap smoke test: `bootstrapServer` constructs the graph
      without starting the listener; `bootstrapWorker` constructs without
      consuming jobs (or start/stop in a test).
- [ ] Move env/client creation into `bootstrap/clients.ts`; construct once.
- [ ] Move health/readiness/metrics/admin mounting into `bootstrap/http.ts`.
- [ ] Remove `loadEnv()` at module scope from ingestion/outbox.
- [ ] Replace `getPrisma()`, `getRedis()`, `getReviewQueue()` with
      `createPrisma(env)`, `createRedis(env)`, `createReviewQueue(env)`; pass
      instances into services.
- [ ] Add `ports/logger.ts` and `ports/clock.ts`; platform `createLogger`
      satisfies `Logger`. Replace `import type pino` in modules with the port.
- [ ] Update tests to create/close clients via `test/helpers/db.ts`.
- [ ] Keep entry-point paths stable: `lib/server.js`, `lib/worker.js`,
      `lib/index.js`.
- [ ] Commit: `refactor(bootstrap): add composition roots and remove singletons`.

**Tests / verification:**
- [ ] `npm test` (full suite with Postgres/Redis)
- [ ] `npm run build`
- [ ] `rg 'getPrisma\(|getRedis\(|getReviewQueue\(|loadEnv\(\)' src` shows no
      production module-level calls.
- [ ] Start server and worker locally; health/readiness still work.

**Acceptance criteria:**
- [ ] Server and worker are wired entirely from bootstrap.
- [ ] No module imports a concrete client.
- [ ] Tests create their own clients and close them.
- [ ] Deployment commands unchanged.

**Risks / rollback strategy:** Wide import change; bootstrap bugs can prevent startup.
Mitigation: smoke test, keep entry points, deploy to staging first. Rollback:
revert; the old singletons return.

**Dependencies on previous PRs:** PR 2.1–2.5.

---

### PR 2.7 — Atomic state transitions

**Objective and scope:** Make review state transitions race-safe and idempotent.

**Files / modules affected:**
- Modify: `src/ingestion/review-state.ts` or
  `src/ingestion/review-state.service.ts`
- Modify: `src/ingestion/ingestion.repository.ts`
- Modify: `src/ingestion/prisma-ingestion.repository.ts`
- Modify: `src/shared/errors/subclasses.ts`
- Create: `test/integration/review-state-transition.test.ts`
- Extend: `test/characterization/review-state.test.ts`

**Implementation steps:**
- [ ] Write failing tests: same-state transition is a no-op; invalid transition
      returns 409; two concurrent valid transitions -> exactly one succeeds;
      terminal state rejects all moves; a transition row is written exactly
      once.
- [ ] Implement `transitionReviewState` as an atomic update guarded by allowed
      predecessor states, followed by the transition row in the same
      transaction (repository-owned transaction).
- [ ] `InvalidStateTransitionError` extends `AppError` with code
      `INVALID_STATE_TRANSITION`, status 409, retryable false.
- [ ] Update callers to rely on the atomic result.
- [ ] Commit: `fix(ingestion): make review state transitions atomic`.

**Tests / verification:**
- [ ] `npm test -- test/characterization/review-state.test.ts test/integration/review-state-transition.test.ts test/recovery.test.ts`
- [ ] `npm run typecheck`

**Acceptance criteria:**
- [ ] No read-then-write race.
- [ ] Terminal states cannot be left.
- [ ] Transition history has one row per successful move.

**Risks / rollback strategy:** A state-machine change can strand reviews. Mitigation:
characterization tests; concurrency test; keep recovery. Rollback: revert; no
data migration.

**Dependencies on previous PRs:** PR 2.1.

---

### PR 2.8 — Queue reliability and graceful shutdown

**Objective and scope:** Make the queue/outbox reliability contract explicit and tested.

**Files / modules affected:**
- Create: `src/ports/review-queue.ts`
- Modify: `src/ingestion/outbox.service.ts`
- Modify: `src/workspace/processor.ts`
- Modify: `src/worker.ts` / `src/bootstrap/worker.ts`
- Modify: `src/lib/shutdown.ts`
- Extend: `test/characterization/outbox.test.ts`
- Extend: `test/characterization/queue-retry.test.ts`
- Extend: `test/characterization/worker-shutdown.test.ts`
- Create: `docs/queue-reliability.md` if the behavior needs operational notes

**Interfaces:**
```ts
interface ReviewQueue {
  enqueue(payload: ReviewJobPayload, options: {
    jobId: string;
    attempts: number;
    backoff: { type: "exponential" | "fixed"; delay: number };
  }): Promise<{ id?: string }>;
  close(): Promise<void>;
}
```

**Implementation steps:**
- [ ] Write failing tests for:
      duplicate outbox publish -> one job; duplicate webhook -> one review;
      transient vs permanent classification; Redis down -> pending event;
      SIGTERM during active job -> complete or retry, never lost.
- [ ] Implement the `ReviewQueue` port; keep BullMQ in platform/queue.
- [ ] Document the idempotency key derivation and retry matrix in
      `docs/queue-reliability.md`.
- [ ] Integrate `classifyFailure` into the worker retry decision; do not
      re-classify errors in multiple places.
- [ ] Make shutdown wait for active jobs up to the deadline; ensure the worker is
      closed before Redis/Postgres.
- [ ] Commit: `fix(queue): make retries idempotent and shutdown graceful`.

**Tests / verification:**
- [ ] `npm test -- test/characterization/outbox.test.ts test/characterization/queue-retry.test.ts test/characterization/worker-shutdown.test.ts`
- [ ] Manual: stop Redis, submit a review, restart Redis, confirm recovery.
- [ ] `npm run build`

**Acceptance criteria:**
- [ ] Every reliability requirement in design section 6.9 has a test.
- [ ] Duplicate delivery and duplicate publish create one logical job.
- [ ] Permanent failures do not retry; transient failures do.
- [ ] Shutdown does not silently abandon an active job.

**Risks / rollback strategy:** Retry changes can affect production load. Mitigation:
preserve existing policies where behavior is already correct; document any
change. Rollback: revert the retry classifier integration; keep the port.

**Dependencies on previous PRs:** PR 2.6, PR 2.7.

---

## Phase 3 — Module migration and boundary enforcement

> **Phase rule:** PR 3.1 adds the boundary lint scaffold. Every move PR updates
> the patterns and must leave lint green. PR 3.12 removes every exception.

### PR 3.1 — Boundary lint scaffold

**Objective and scope:** Add the import-boundary tooling before moving modules.

**Files / modules affected:**
- Modify: `eslint.config.mjs`
- Modify: `package.json` / lockfile if a plugin is added
- Create: `docs/module-boundaries.md`

**Implementation steps:**
- [ ] Add `eslint-plugin-boundaries` or equivalent rules for element types:
      `bootstrap`, `module`, `platform`, `contracts`, `ports`, `shared`,
      `script`, `test`.
- [ ] Rules: `bootstrap` -> all; `module` -> contracts, ports, shared, same
      module internals, other modules' `index.ts`; `platform` -> contracts,
      ports, shared; `contracts` -> zod only; `ports` -> contracts/shared;
      `shared` -> no app imports.
- [ ] Add `no-restricted-imports` for `@prisma/client` outside
      `**/*.repository.ts` and `src/platform/db/**`.
- [ ] Add `no-restricted-syntax` for `process.env` outside
      `src/platform/config/**` and `test/**`.
- [ ] Add `no-restricted-globals` for `fetch` outside `src/platform/**`.
- [ ] Add `import/no-cycle` for `src`.
- [ ] Document the rules and the allowed exceptions in
      `docs/module-boundaries.md`.
- [ ] Start with temporary path allowances for the current layout; each move PR
      removes its allowance. PR 3.12 removes all allowances.
- [ ] Commit: `chore(lint): add module boundary rules`.

**Tests / verification:**
- [ ] `npm run lint` passes with the scaffold.
- [ ] A deliberately bad import (temporary local check) fails.
- [ ] `docs/module-boundaries.md` matches the config.

**Acceptance criteria:**
- [ ] The boundary tooling is in CI before module moves start.
- [ ] Every temporary allowance has a removal PR number.

**Risks / rollback strategy:** Overly broad rules can block legitimate imports.
Mitigation: adjust element patterns, not disable rules. Rollback: revert the
scaffold; module moves have not started.

**Dependencies on previous PRs:** PR 2.6.

---

### PR 3.2 — Move webhooks, ingestion, findings, and recovery into modules

**Objective and scope:** Move the intake-side modules into `src/modules` without
behavior change.

**Files / modules affected:**
- Move: `src/handlers/` -> `src/modules/webhooks/`
- Move: `src/ingestion/` -> `src/modules/ingestion/`
- Move: `src/findings/` -> `src/modules/findings/`
- Move: `src/recovery/reconciliation.ts` ->
  `src/modules/ingestion/recovery.service.ts`; delete the empty `src/recovery/`
- Create: `src/modules/webhooks/index.ts`,
  `src/modules/ingestion/index.ts`, `src/modules/findings/index.ts`
- Modify: `src/index.ts` to import `registerWebhooks` from
  `modules/webhooks`
- Modify: all importers, tests, and boundary lint allowances

**Implementation steps:**
- [ ] Use `git mv` for directories; update imports to `.js` specifiers and
      public `index.ts` entry points.
- [ ] Keep file contents unchanged; only import paths and barrel exports.
- [ ] Move recovery under ingestion so outbox/reconciliation has one owner.
- [ ] Remove the old path allowances from the boundary config.
- [ ] Commit: `refactor(modules): move webhooks ingestion findings and recovery`.

**Tests / verification:**
- [ ] `npm test` (full suite)
- [ ] `npm run lint`, `npm run typecheck`, `npm run build`
- [ ] `rg 'from "\\.\\./handlers|from "\\.\\./ingestion|from "\\.\\./findings|from "\\.\\./recovery' src` shows no old
      internal paths outside the modules' public imports.

**Acceptance criteria:**
- [ ] All four capabilities have a public entry point.
- [ ] No cross-module internal import.
- [ ] No behavior change.
- [ ] `src/index.ts` is a thin webhook registration adapter.

**Risks / rollback strategy:** Import churn. Mitigation: move-only; run full suite.
Rollback: revert the move commit.

**Dependencies on previous PRs:** PR 3.1.

---

### PR 3.3 — Move workspace into a module

**Objective and scope:** Move workspace lifecycle and its repository into
`src/modules/workspace`.

**Files / modules affected:**
- Move: `src/workspace/` -> `src/modules/workspace/`
- Create: `src/modules/workspace/index.ts`
- Modify: importers in worker, recovery, publishing, review, tests
- Modify: `eslint.config.mjs` allowances

**Implementation steps:**
- [ ] `git mv`; update imports; keep behavior unchanged.
- [ ] Confirm `ReviewWorkspace` ownership stays in this module.
- [ ] Commit: `refactor(modules): move workspace`.

**Tests / verification:**
- [ ] `npm test -- test/review-workspace.test.ts test/workspace-disk.test.ts test/recovery.test.ts`
- [ ] `npm run lint`, `npm run typecheck`, `npm run build`

**Acceptance criteria:** public entry point; no behavior change; no old path imports.

**Risks / rollback strategy:** low; revert move.

**Dependencies on previous PRs:** PR 3.1.

---

### PR 3.4 — Move review into a module

**Objective and scope:** Move the review engine and runner into `src/modules/review`.

**Files / modules affected:**
- Move: `src/review-engine/` -> `src/modules/review/`
- Create: `src/modules/review/index.ts`
- Modify: importers in publishing, worker, eval, tests
- Modify: `eslint.config.mjs` allowances

**Implementation steps:**
- [ ] `git mv`; update imports; keep the engine logic unchanged.
- [ ] Keep the runner thin: it orchestrates `review`, `findings`, `publishing`,
      `knowledge`, and `ingestion` through public APIs. If it grows beyond
      orchestration, split it in a follow-up.
- [ ] Commit: `refactor(modules): move review engine`.

**Tests / verification:**
- [ ] `npm test -- test/review-engine.test.ts test/review-prompts.test.ts test/characterization/*`
- [ ] `npm run lint`, `npm run typecheck`, `npm run build`

**Acceptance criteria:** public entry point; no behavior change; no engine logic edit.

**Risks / rollback strategy:** large import surface. Mitigation: move-only; full suite.
Rollback: revert move.

**Dependencies on previous PRs:** PR 3.1.

---

### PR 3.5 — Move publishing into a module

**Objective and scope:** Move GitHub publication into `src/modules/publishing`.

**Files / modules affected:**
- Move: `src/publishing/` -> `src/modules/publishing/`
- Create: `src/modules/publishing/index.ts`
- Create: `src/platform/github/octokit.ts` (move `createGitHubOctokit` and
  Octokit plugin setup there)
- Keep: `src/ports/github-publisher.ts` (Octokit surface)
- Modify: importers in worker, review, admin, tests
- Modify: `eslint.config.mjs` allowances

**Implementation steps:**
- [ ] `git mv`; update imports; keep publication logic unchanged.
- [ ] Move the concrete Octokit factory to `platform/github`; publishing
      depends on the port.
- [ ] Ensure publishing consumes the findings public API and the GitHub port.
- [ ] Commit: `refactor(modules): move publishing`.

**Tests / verification:**
- [ ] `npm test -- test/publishing.test.ts test/summary-format.test.ts test/characterization/publishing.test.ts`
- [ ] `npm run lint`, `npm run typecheck`, `npm run build`

**Acceptance criteria:** public entry point; no behavior change.

**Risks / rollback strategy:** low; revert move.

**Dependencies on previous PRs:** PR 3.4.

---

### PR 3.6 — Move and split admin

**Objective and scope:** Move the admin feature into `src/modules/admin` and split the
HTTP, auth, panel, and audit concerns.

**Files / modules affected:**
- Move: `src/admin/` -> `src/modules/admin/`
- Create: `src/modules/admin/admin.http.ts`
- Create: `src/modules/admin/admin.service.ts`
- Create: `src/modules/admin/auth/` (`github-oauth.ts`, `session.ts`, `csrf.ts`)
- Create: `src/modules/admin/panel/` (`panel.http.ts`, `render.ts`, `templates/`)
- Create: `src/modules/admin/audit.repository.ts`,
  `src/modules/admin/prisma-audit.repository.ts`
- Move: `src/admin/rate-limit.ts` -> `src/modules/admin/rate-limit.ts`
- Create: `src/modules/admin/index.ts`
- Modify: importers/tests
- Modify: `eslint.config.mjs` allowances

**Implementation steps:**
- [ ] `git mv` the directory and EJS templates.
- [ ] Split `api.ts` by concern; keep route behavior and status codes identical.
- [ ] Split `panel.ts` into HTTP/render/templates; keep EJS as the renderer.
- [ ] Move audit persistence behind the repository from PR 2.5.
- [ ] Commit: `refactor(modules): move and split admin`.

**Tests / verification:**
- [ ] `npm test -- test/admin-api.test.ts test/admin-panel.test.ts test/characterization/admin-auth.test.ts`
- [ ] `npm run lint`, `npm run typecheck`, `npm run build`
- [ ] Manual: OAuth callback, panel save, CSRF rejection still work.

**Acceptance criteria:** EJS unchanged; auth/session/CSRF behavior unchanged; public
entry point; no god file over 350 lines without a reason.

**Risks / rollback strategy:** auth regressions are high impact. Mitigation:
characterization tests; review auth diff separately. Rollback: revert the split
commit; the old admin directory returns.

**Dependencies on previous PRs:** PR 2.5, PR 3.1.

---

### PR 3.7 — Move triage into a module

**Objective and scope:** Preserve issue triage as a live feature while moving it out of
the legacy controller/service/view layout.

**Files / modules affected:**
- Create: `src/modules/triage/triage.service.ts`
- Create: `src/modules/triage/triage.prompt.ts`
- Create: `src/modules/triage/triage.view.ts`
- Create: `src/modules/triage/index.ts`
- Create/Modify: `src/platform/models/groq-triage.ts` or a provider factory
  that preserves the existing `GROQ_API_KEY`/`GROQ_MODEL` behavior
- Modify: `src/index.ts` (register `issues.opened` handler)
- Delete: `src/controllers/issue.controller.ts`, `src/services/triage.service.ts`,
  `src/views/triage.view.ts` after the move
- Modify: `eslint.config.mjs` allowances

**Implementation steps:**
- [ ] Write/extend characterization tests for `issues.opened`: comment posted,
      bot skipped, provider failure logged without crashing.
- [ ] Move the prompt/view logic; replace the direct `fetch` with the
      `ModelProvider` port.
- [ ] Wire the triage provider in the composition root using the current
      `GROQ_*` environment variables, so behavior is unchanged.
- [ ] Register the handler from `src/index.ts` through
      `modules/webhooks`/`modules/triage`.
- [ ] Delete the old files.
- [ ] Commit: `refactor(triage): move issue triage into a module`.

**Tests / verification:**
- [ ] `npm test -- test/index.test.ts test/characterization/triage.test.ts`
- [ ] `npm run lint`, `npm run typecheck`, `npm run build`
- [ ] Manual: a fixture `issues.opened` event still posts the expected comment.

**Acceptance criteria:** triage remains live; no direct `fetch` in the module; bot skip
preserved; provider failure does not crash the webhook.

**Risks / rollback strategy:** Triaging issues is live behavior. Mitigation:
characterization tests and a staging smoke. Rollback: revert the move; the old
controller remains until the move is verified.

**Dependencies on previous PRs:** PR 3.1, PR 3.4.

---

### PR 3.8 — Move knowledge and execution into modules

**Objective and scope:** Move the remaining runtime capabilities into `src/modules`
without behavior change.

**Files / modules affected:**
- Move: `src/knowledge/` -> `src/modules/knowledge/`
- Move: `src/execution/` -> `src/modules/execution/`
- Create: `src/modules/knowledge/index.ts`,
  `src/modules/execution/index.ts`
- Modify: importers/tests
- Modify: `eslint.config.mjs` allowances

**Implementation steps:**
- [ ] `git mv` both directories; update imports.
- [ ] Keep execution behavior and tests unchanged; do not wire it into review.
- [ ] Commit: `refactor(modules): move knowledge and execution`.

**Tests / verification:**
- [ ] `npm test -- test/knowledge.test.ts test/execution-security.test.ts`
- [ ] `npm run lint`, `npm run typecheck`, `npm run build`

**Acceptance criteria:** public entry points; execution behavior unchanged; no old paths.

**Risks / rollback strategy:** low; revert move.

**Dependencies on previous PRs:** PR 3.1.

---

### PR 3.9 — Move agent and model runtimes behind ports

**Objective and scope:** Move OpenCode and model adapters into `src/platform` and define
their ports.

**Files / modules affected:**
- Move: `src/agent/` -> `src/platform/agents/`
- Create: `src/ports/agent-runtime.ts` from `src/agent/types.ts`
- Move: `AgentRuntimeError` to `src/shared/errors/` and extend `AppError`
- Move: `src/models/` -> `src/platform/models/`
- Create: `src/ports/model-provider.ts` from `src/models/provider.ts`
- Move: `ModelProviderError` to `src/shared/errors/` and extend `AppError`
- Modify: review, triage, eval, publishing, tests
- Modify: `eslint.config.mjs` allowances

**Implementation steps:**
- [ ] Write characterization tests for runtime selection and provider error
      mapping before the move.
- [ ] `git mv` both directories; update imports.
- [ ] Keep the runtime interfaces identical at first; only the error classes
      change their base.
- [ ] Commit: `refactor(platform): move agent and model adapters behind ports`.

**Tests / verification:**
- [ ] `npm test -- test/agent-runtime.test.ts test/agent-sdk-runtime.test.ts test/agent-runtime-registry.test.ts test/model-provider.test.ts`
- [ ] `npm run lint`, `npm run typecheck`, `npm run build`

**Acceptance criteria:** modules depend on ports, not `platform/agents` or
`platform/models`; runtime behavior unchanged.

**Risks / rollback strategy:** runtime adapters are complex. Mitigation: move-only; keep
interfaces stable; characterization tests. Rollback: revert move.

**Dependencies on previous PRs:** PR 3.4, PR 3.7.

---

### PR 3.10 — Move config, lib, and observability into platform

**Objective and scope:** Put infrastructure and configuration adapters under
`src/platform` and finish the `contracts`/`platform` split.

**Files / modules affected:**
- Move: `src/config/env.ts` -> `src/platform/config/env.ts`
- Move: `src/config/review-loader.ts` -> `src/platform/config/review-loader.ts`
- Move: `src/config/review-schema.ts` -> schemas already in
  `src/contracts/config.ts`; keep a re-export only if needed
- Move: `src/config/index.ts` -> `src/platform/config/index.ts`
- Move: `src/lib/prisma.ts` -> `src/platform/db/prisma.ts`
- Move: `src/lib/redis.ts` -> `src/platform/redis.ts`
- Move: `src/lib/logger.ts` -> `src/platform/logger.ts`
- Move: `src/lib/health.ts` -> `src/platform/health.ts`
- Move: `src/lib/shutdown.ts` -> `src/platform/shutdown.ts`
- Move: `src/ingestion/queue.ts` -> `src/platform/queue/review-queue.ts`
- Move: `src/observability/` -> `src/platform/observability/`
- Move: `src/platform/http/` created in PR 1.1 -> keep or fold into admin
- Modify: all importers/tests
- Modify: `eslint.config.mjs` allowances

**Implementation steps:**
- [ ] `git mv` in small commits if needed; update imports.
- [ ] Keep `src/index.ts`/`server.ts`/`worker.ts` entry points stable.
- [ ] Confirm no module imports a platform concrete; only ports/contracts.
- [ ] Commit: `refactor(platform): move config lib and observability`.

**Tests / verification:**
- [ ] `npm test` (full suite)
- [ ] `npm run lint`, `npm run typecheck`, `npm run build`
- [ ] `rg 'from "\\.\\./lib|from "\\.\\./config|from "\\.\\./observability' src/modules` returns no hits.

**Acceptance criteria:** platform layout matches the design; no module imports platform;
no behavior change.

**Risks / rollback strategy:** wide import churn. Mitigation: move-only; full suite.
Rollback: revert the move commits.

**Dependencies on previous PRs:** PR 3.9.

---

### PR 3.11 — Move eval into scripts and finalize scripts

**Objective and scope:** Move benchmark tooling out of the runtime source tree.

**Files / modules affected:**
- Move: `src/eval/` -> `src/scripts/eval/`
- Create: `src/scripts/eval/run.ts` or keep `src/scripts/eval-run.ts` as the CLI
- Modify: `package.json` scripts
- Modify: tests/importers
- Modify: `eslint.config.mjs` allowances

**Implementation steps:**
- [ ] `git mv`; update imports to public module APIs.
- [ ] Keep `npm run eval:run` working; update the built path if needed.
- [ ] Commit: `refactor(scripts): move eval tooling out of runtime modules`.

**Tests / verification:**
- [ ] `npm test -- test/evaluation.test.ts`
- [ ] `npm run build`
- [ ] `node lib/scripts/eval-run.js --help` or the existing smoke command works.

**Acceptance criteria:** eval is tooling; production modules do not import it; command
still works.

**Risks / rollback strategy:** build path changes. Mitigation: verify `package.json`
script. Rollback: revert move.

**Dependencies on previous PRs:** PR 3.10.

---

### PR 3.12 — Boundary lint enforcement

**Objective and scope:** Remove all temporary boundary allowances and make the rules
mandatory.

**Files / modules affected:**
- Modify: `eslint.config.mjs`
- Modify: `docs/module-boundaries.md`
- Fix any remaining violations

**Implementation steps:**
- [ ] Remove every temporary path allowance from PR 3.1.
- [ ] Keep only the approved exceptions: vendor-typed boundaries, Prisma inside
      `*.repository.ts`/`platform/db`, `process.env` inside
      `platform/config`, `fetch` inside `platform`.
- [ ] Add a negative test fixture or a documented manual check for each rule.
- [ ] Run `npm run lint` and fix all violations by moving code or adding a port;
      do not disable a rule.
- [ ] Commit: `chore(lint): enforce module boundaries`.

**Tests / verification:**
- [ ] `npm run lint` passes with no rule disabled.
- [ ] `rg 'eslint-disable.*boundaries|no-restricted' eslint.config.mjs` shows
      only the approved exceptions.
- [ ] `npm run build` passes.

**Acceptance criteria:**
- [ ] No module -> platform import.
- [ ] No cross-module internal import.
- [ ] No Prisma import outside repositories/DB.
- [ ] No `process.env` outside config.
- [ ] No circular imports.
- [ ] No `fetch` outside platform.

**Risks / rollback strategy:** A legitimate import may be blocked. Mitigation: introduce a
port or move the code down; do not add a blanket exception. Rollback: revert the
rule changes; the previous scaffold remains.

**Dependencies on previous PRs:** PR 3.2–3.11.

---

## Phase 4 — Test tiers and CI infrastructure

### PR 4.1 — Split unit, contract, integration, and characterization tests

**Objective and scope:** Make the test tiers explicit and runnable independently.

**Files / modules affected:**
- Modify: `vitest.config.ts`
- Create: `test/integration/` (move DB/Redis tests)
- Keep: `test/characterization/`
- Keep: contract tests beside `src/contracts/` (excluded from the unit project)
- Modify: `package.json` scripts

**Implementation steps:**
- [ ] Define Vitest projects: `unit` (src tests + pure tests), `contract`,
      `integration` (Postgres/Redis), `characterization` (Postgres/Redis).
- [ ] Move current DB/Redis tests to `test/integration`; keep
      `test/characterization` separate.
- [ ] Add scripts: `test:unit`, `test:contract`, `test:integration`,
      `test:characterization`, `test` (all).
- [ ] Set `fileParallelism: false` only for integration/characterization.
- [ ] Commit: `test: split unit contract integration and characterization`.

**Tests / verification:**
- [ ] `npm run test:unit` passes with no Postgres/Redis.
- [ ] `npm run test:integration` passes with services.
- [ ] `npm run test:characterization` passes with services.
- [ ] `npm test` runs all tiers.

**Acceptance criteria:**
- [ ] Unit tier has no infrastructure dependency.
- [ ] Integration/characterization tiers are explicit and documented.
- [ ] Characterization suite still passes.

**Risks / rollback strategy:** Test file moves can hide missing coverage. Mitigation:
count tests before/after; ensure no test deleted. Rollback: revert config/moves.

**Dependencies on previous PRs:** PR 3.12.

---

### PR 4.2 — Fakes and unit-test migration

**Objective and scope:** Make the unit tier fast and deterministic with fakes at the new
seams.

**Files / modules affected:**
- Create: `test/fakes/repositories.ts`
- Create: `test/fakes/agent-runtime.ts`
- Create: `test/fakes/model-provider.ts`
- Create: `test/fakes/review-queue.ts`
- Create: `test/fakes/logger.ts`
- Create: `test/fakes/clock.ts`
- Modify: unit tests across modules
- Modify: `eslint.config.mjs` to remove the test `no-non-null-assertion`
  override if all violations are fixed

**Implementation steps:**
- [ ] Write fakes that implement the full interfaces, not just happy-path
      methods.
- [ ] Migrate unit tests to fakes; keep integration tests on real
      Postgres/Redis.
- [ ] Add tests for the error/failure paths.
- [ ] Remove the temporary test overrides for `any`/`!` after fixing or
      justifying each case.
- [ ] Commit: `test: add fakes and migrate unit tests`.

**Tests / verification:**
- [ ] `npm run test:unit` passes with no services running.
- [ ] `npm run test:integration` passes with services.
- [ ] `npm run lint`, `npm run typecheck`, `npm run build`

**Acceptance criteria:**
- [ ] Unit tests do not import `@prisma/client`, `getPrisma`, `getRedis`, or
      `fetch`.
- [ ] Fakes honor their interfaces (LSP).
- [ ] Characterization tests remain untouched.

**Risks / rollback strategy:** Rewritten tests may reduce coverage. Mitigation:
characterization suite is the safety net; count assertions/tests. Rollback:
revert the test migration; the old tests remain.

**Dependencies on previous PRs:** PR 4.1.

---

### PR 4.3 — CI integration services and quality gates

**Objective and scope:** Run every tier in CI with the same commands as local.

**Files / modules affected:**
- Modify: `.github/workflows/ci.yml`
- Modify: `CONTRIBUTING.md`

**Implementation steps:**
- [ ] Add Postgres/Redis services to the integration job.
- [ ] Run `npx prisma migrate deploy` before integration tests.
- [ ] Run unit/contract first, then integration/characterization.
- [ ] Upload test logs/artifacts on failure.
- [ ] Keep `npm audit` and secret scanning.
- [ ] Document local service startup in `CONTRIBUTING.md`.
- [ ] Commit: `ci: run integration and characterization tiers`.

**Tests / verification:**
- [ ] CI green on a PR with all tiers.
- [ ] A deliberately failing integration test fails the job.
- [ ] Local commands match CI.

**Acceptance criteria:** all tiers run in CI; unit tier is fast; integration tier uses
real services; characterization suite is required.

**Risks / rollback strategy:** CI runtime cost. Mitigation: cache npm, run unit first,
fail fast. Rollback: revert to the Phase 0 workflow.

**Dependencies on previous PRs:** PR 4.2.

---

### PR 4.4 — Docker Compose smoke test

**Objective and scope:** Prove the built image starts both processes and reaches healthy
state.

**Files / modules affected:**
- Create: `scripts/smoke/docker-smoke.sh` or `.mjs`
- Modify: `.github/workflows/ci.yml` if feasible
- Modify: `CONTRIBUTING.md`

**Implementation steps:**
- [ ] Build the image and start Postgres, Redis, server, and worker with the
      existing Compose files.
- [ ] Poll `/healthz` and `/readyz`; assert both are healthy.
- [ ] Assert the worker logs readiness and connects to the queue.
- [ ] Do not require real GitHub/model credentials; use the degraded-start path
      or existing fixtures.
- [ ] Tear down containers and volumes.
- [ ] Commit: `test: add docker compose smoke test`.

**Tests / verification:**
- [ ] `bash scripts/smoke/docker-smoke.sh` passes locally.
- [ ] CI job passes if Docker is available.
- [ ] Failure output includes container logs.

**Acceptance criteria:** both processes start from the built image; health/readiness
work; no secrets required.

**Risks / rollback strategy:** Docker may be unavailable in some environments. Mitigation:
make the smoke job conditional and document local usage. Rollback: remove the
script/job; no runtime impact.

**Dependencies on previous PRs:** PR 4.3.

---

## Phase 5 — Documentation and decisions

### PR 5.1 — Architecture docs and ADRs

**Objective and scope:** Make the implemented architecture discoverable and record the
approved deviations.

**Files / modules affected:**
- Modify: `docs/architecture.md`
- Modify: `README.md`
- Modify: `CONTRIBUTING.md`
- Modify: `docs/typescript-profile.md`
- Create: `docs/adr/0001-keep-probot.md`
- Create: `docs/adr/0002-prisma-over-drizzle.md`
- Create: `docs/adr/0003-single-npm-package.md`
- Create: `docs/adr/0004-contracts-in-src.md`
- Create: `docs/adr/0005-unit-of-work.md`
- Create: `docs/adr/0006-failure-classification.md`

**Implementation steps:**
- [ ] Replace the legacy architecture description with the module map and
      dependency rules.
- [ ] Document the server/worker flows and the queue reliability contract.
- [ ] Record the deviations and their reasons in ADRs.
- [ ] Update the profile's known gaps and decisions.
- [ ] Commit: `docs: document the refactored architecture`.

**Tests / verification:**
- [ ] All links resolve.
- [ ] `rg 'controllers/|services/|review-engine/' docs README.md` shows no stale
      live-path references (historical notes are allowed if labeled).
- [ ] A new contributor can follow the README/CONTRIBUTING to run the app/tests.

**Acceptance criteria:** docs match the code; ADRs explain every deviation; profile is
current.

**Risks / rollback strategy:** docs drift. Mitigation: review in the same PR as the final
code changes. Rollback: revert docs.

**Dependencies on previous PRs:** PR 4.4.

---

### PR 5.2 — Final verification and profile update

**Objective and scope:** Prove the refactor met its goals and close the gap analysis.

**Files / modules affected:**
- Create: `docs/typescript-refactor-report.md`
- Modify: `docs/typescript-profile.md`
- Modify: `docs/typescript-gap-analysis.md` (status column only)

**Implementation steps:**
- [ ] Run the full suite, characterization suite, metrics, and Docker smoke.
- [ ] Compare each metric to the baseline and record the final table.
- [ ] Re-run the gap-analysis commands; update the scorecard.
- [ ] List any remaining deviations or follow-ups in the profile.
- [ ] Commit: `docs: record typescript refactor verification`.

**Tests / verification:**
- [ ] `npm run format:check && npm run lint && npm run typecheck && npm test && npm run build`
- [ ] `npm run metrics:quality` shows the final counts.
- [ ] Docker smoke passes.

**Acceptance criteria:**
- [ ] Every P0 gap is closed.
- [ ] Remaining deviations are documented with a reason and owner.
- [ ] The service still deploys with the same commands.

**Risks / rollback strategy:** final verification may reveal a regression. Mitigation:
fix before merge; do not lower the bar. Rollback: revert the offending PR, not
the whole refactor.

**Dependencies on previous PRs:** PR 5.1.

---

## Dependency graph

```text
0.1 -> 0.2 -> 0.3 -> 0.4 -> 0.5
                         |
                         v
1.1 -> 1.2 -> 1.3 -> 1.4 -> 1.5
                         |
                         v
2.1 -> 2.2 -> 2.3 -> 2.4 -> 2.5 -> 2.6 -> 2.7 -> 2.8
                         |
                         v
3.1 -> 3.2 -> 3.3 -> 3.4 -> 3.5 -> 3.6 -> 3.7 -> 3.8 -> 3.9 -> 3.10 -> 3.11 -> 3.12
                         |
                         v
4.1 -> 4.2 -> 4.3 -> 4.4
                         |
                         v
5.1 -> 5.2
```

Some PRs in a phase can run in parallel once their dependencies are met
(for example, 2.3/2.4/2.5 after 2.1; 3.2/3.3/3.4 after 3.1). The dependency
graph shows the safe default order.

## PR checklist (copy into every PR)

- [ ] Objective and scope are in the title/description.
- [ ] Files/modules affected are listed.
- [ ] Implementation steps are checked off.
- [ ] Tests and verification commands are listed with results.
- [ ] Acceptance criteria are met.
- [ ] Risks and rollback are stated.
- [ ] Dependencies on previous PRs are linked.
- [ ] `npm run metrics:quality` before/after is in the description.
- [ ] No product feature or unrelated behavior change is included.
- [ ] The app still builds and deploys with the existing commands.
