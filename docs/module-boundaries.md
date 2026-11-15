# Module boundaries

ESLint enforces the module layout. The Phase 3 move is complete: there are no
temporary path allowances, no `legacy` element type, and no disabled boundary
rule. The rules below are the permanent policy.

Source of truth: `eslint.config.mjs`. This document must match the config in the
same commit.

## Element types

Element patterns are anchored at the repository root. `boundaries/elements-single-match`
is explicitly set to `true`, so the first matching descriptor wins;
`src/index.ts`, `src/server.ts`, and `src/worker.ts` fall back to the `src`
descriptor and are therefore `bootstrap`.

| Type | Paths | Meaning |
|---|---|---|
| `bootstrap` | `src/bootstrap`, `src/index.ts`, `src/server.ts`, `src/worker.ts` | Process entry points and composition roots. May wire every layer. |
| `module` | `src/modules/*` | Vertical capabilities with a public `index.ts` entry point. |
| `platform` | `src/platform` | Infrastructure adapters (config, DB, queues, observability, HTTP/network clients, runtimes). |
| `contracts` | `src/contracts` | Zod schemas and inferred types. |
| `ports` | `src/ports` | Interfaces modules and platform adapters depend on. |
| `shared` | `src/shared` | Dependency-free helpers, projections, and the `AppError` family. |
| `script` | `src/scripts`, `scripts` | Tooling and CLIs. |
| `test` | `test` | Test suites and helpers. |

There is no `legacy` element type. PR 3.11 moved the last top-level directory
(`src/eval` to `src/scripts/eval`), and PR 3.12 deleted the unused descriptor
and its policy.

Co-located `**/*.test.ts` files are also categorized as `test` files, so tests
inside `src/contracts` or `src/platform` may import fixtures and test utilities.
That category is permanent.

## Dependency policies

`boundaries/dependencies` runs with `default: "disallow"` and
`checkAllOrigins: true`. Imports within the same element (for example
`modules/ingestion/a.ts` -> `modules/ingestion/b.ts`) are not checked; every
cross-element dependency needs a policy.

| From | May depend on |
|---|---|
| `bootstrap` | every application element |
| `module` | `contracts`, `ports`, `shared`, its own internals, and other modules' `index.ts` only |
| `platform` | `contracts`, `ports`, `shared` (and its own internals) |
| `contracts` | `zod` only (own internals are unrestricted) |
| `ports` | `contracts`, `shared` |
| `shared` | `contracts` |
| `script` | every application element |
| `test` | every application element |

External and Node core packages are allowed from every element except
`contracts`. `contracts` may import only `zod`; test-category files are exempt.
No module may import another module's internal file or a platform adapter.

`import/no-cycle` remains enabled for every source file.

## Placement rulings

### PR 3.10

- `src/observability/retry.ts` moved to `src/shared/retry.ts`, and
  `src/observability/correlation.ts` moved to
  `src/ports/review-logging.ts`. Both are dependency-free, module-facing
  helpers: placing them under `src/platform` would force a
  `module -> platform` import, which the policy rejects. Behavior is
  unchanged.
- The `/review` webhook loads configuration through the injected
  `ReviewConfigStore` built by the composition root instead of reading
  `process.env` on every delivery. That store is a boot-time snapshot of the
  static deployment environment; the shipped `config/review.json` resolves
  identically, and static deployment env is the intended contract.

### PR 3.11

- `src/eval/` moved to `src/scripts/eval/`. Benchmark evaluation is tooling
  that exercises the review engine; no production module imports it, and the
  `script` element policy already allows it to depend on every layer.
- `src/scripts/eval-run.ts` remains the CLI, so the compiled entry point
  (`lib/scripts/eval-run.js`) and `npm run eval:run` are unchanged.
- The evaluation test and the CLI import the package through
  `src/scripts/eval/index.ts`, matching the public surface to the internal
  module files.

### PR 3.12

- `src/platform/http/error-mapper.ts` moved to
  `src/shared/errors/http-mapper.ts`. It is a pure projection of the shared
  `AppError` family and the error contract; it performs no platform I/O. Admin
  HTTP handlers and the bootstrap HTTP surface import it from `shared` instead
  of forcing a `module -> platform` edge. The co-located test moved with it.
- `FINDING_CATEGORIES` moved from `modules/review/types.ts` to
  `contracts/review.ts`. The taxonomy validates model output at the contract
  boundary and is shared by findings validation and publication ordering;
  `contracts` may no longer import a module.
- The knowledge HTTP adapter moved to `src/platform/knowledge/fetch.ts`. The
  `KnowledgeFetcher` type is a port (`src/ports/knowledge.ts`); bootstrap
  injects the default adapter and tests inject fakes. Response parsing and
  cache/manifest logic remain in `modules/knowledge`.
- `modules/knowledge/materialize.ts` takes a `ReviewKnowledgeStore` port. The
  Prisma adapter is `modules/knowledge/prisma-knowledge.repository.ts` (the
  approved `*.repository.ts` exception), so materialization never imports
  `@prisma/client`.
- `modules/execution/service.ts` takes an `ExecutionAuditRepository` port and an
  injected process environment. The Prisma adapter is
  `modules/execution/prisma-execution-audit.repository.ts`; the Docker and
  local executors receive `appEnv` explicitly instead of reading the process
  environment in their constructors.
- `modules/workspace` receives the process environment through
  `ReviewWorkspaceServiceOptions.appEnv` (git needs `PATH`/`HOME`) and through
  `createDefaultTokenProvider(appEnv)` (GitHub App credentials). Report
  publication receives `deps.env` for model-id metadata.
- Admin OAuth network calls moved to `src/platform/github/oauth-client.ts`,
  which implements the `GithubOAuthClient` port. `createAdminApi` receives the
  client from bootstrap; authorization policy, OAuth state and sessions remain
  in `modules/admin`. The shared `GithubOauthError` moved to
  `src/shared/errors/github-oauth.ts`.
- The admin panel receives `devLoginEnabled` from bootstrap. The panel no
  longer reads `ADMIN_DEV_LOGIN` itself; the composition root combines it with
  `NODE_ENV` and `SESSION_SECRET`.
- Bootstrap reads operational overrides through
  `platform/config/env.ts` (`readEnv`, `readProcessEnv`). It no longer mutates
  `process.env`: a base64-encoded GitHub private key is passed to Probot as a
  `privateKey` override.
- `platform/health.ts` receives a `checkDatabase` probe. `platform/db` owns
  `checkPrisma`; the readiness module needs no vendor type.
- Benchmark persistence moved behind
  `platform/db/evaluation-run.repository.ts`. `scripts/eval` maps a
  `BenchmarkRun` to a plain `EvaluationRunRecord`; no tooling file imports
  `@prisma/client`.

### Final boundary fixes (2026-11-15)

- `modules/workspace/processor.ts` no longer imports BullMQ or ioredis. It
  implements the `ReviewJobProcessor` port; `platform/queue/review-worker.ts`
  owns the BullMQ `Worker`, payload parsing, attempt context, and
  `UnrecoverableError`. Permanent application failures cross the port as
  `UnrecoverableJobError` (`shared/errors`) and are translated once at the
  adapter edge.
- Reconciliation re-enqueues through the `ReviewQueue` port
  (`removeTerminalJob`, `enqueue`, `getJobCounts`), not a BullMQ `Queue`.
- GitHub App authentication moved from `modules/workspace/credentials.ts` to
  `platform/github/app-auth.ts`, behind `ports/installation-token.ts`.
  Workspace and publishing receive an `InstallationTokenProvider`; only the
  platform adapter imports `@octokit/auth-app`.
- Webhooks depend on public ingestion services: `InstallationService` for the
  installation lifecycle and `findReviewTarget` for durable PR resolution.
  They no longer receive `IngestionRepositories` or `IngestionUnitOfWork`.
- The Octokit packages are declared as direct dependencies at the versions
  already installed; the build no longer relies on npm hoisting through Probot.

## Vendor and environment rules

The rules apply to TypeScript (`**/*.{ts,mts,cts}`), root tooling
(`scripts/**/*.mjs`), and the standalone deploy diagnostic (`deploy/**/*.js`).

| Rule | Restriction | Approved exceptions |
|---|---|---|
| `no-restricted-imports` | No `@prisma/client` import, including deep subpaths via the `@prisma/client/*` pattern. | `src/**/*.repository.ts` and `src/platform/db/**` (permanent). |
| `no-restricted-imports` | No `bullmq` or `ioredis` import. | `src/platform/queue/**` (BullMQ + ioredis) and `src/platform/redis.ts` (ioredis). |
| `no-restricted-imports` | No `@octokit/auth-app`, `@octokit/core`, `@octokit/plugin-rest-endpoint-methods`, or `@octokit/plugin-retry` import. | `src/platform/github/**`. |
| `no-restricted-imports` | Every vendor package above. | `test/**` (test-tier exception; tests are never application code). |
| `no-restricted-syntax` | No `process.env` reads (dot or bracket form). | `src/platform/config/**`, `test/**`, and `deploy/inspect-key.js` (permanent). |
| `no-restricted-globals` | No global `fetch`. | `src/platform/**` (permanent). |

Tests may use `@prisma/client` row types and the BullMQ error classes to
arrange fixtures and assert queue behavior. This is an **approved test-tier
exception**, not application code: repositories and `platform/db` remain the
only production owners of the vendor client, and `platform/queue` is the only
production owner of BullMQ. If the test fakes migration removes those imports,
the exception can be dropped later.

`deploy/inspect-key.js` is a one-off container diagnostic copied into a running
worker container; it is CommonJS, outside the package, and never imported by the
application. It is deliberately linted by these rules, with one permanent
`process.env` exception because reading the mounted key is its entire purpose.

No module imports `@prisma/client` outside `*.repository.ts` adapters. No
module calls global `fetch` or reads `process.env`. Modules depend on ports
supplied by bootstrap:

| Module | Port / injected value | Implementation / wiring |
|---|---|---|
| `execution` | `ExecutionAuditRepository`, `appEnv` | `prisma-execution-audit.repository.ts`; bootstrap supplies `appEnv` |
| `knowledge` | `KnowledgeFetcher`, `ReviewKnowledgeStore`, `env` | `platform/knowledge/fetch.ts`, `prisma-knowledge.repository.ts` |
| `admin` | `GithubOAuthClient`, `devLoginEnabled` | `platform/github/oauth-client.ts`; bootstrap computes the flag |
| `workspace` | `appEnv`, `InstallationTokenProvider`, `ReviewJobService` | bootstrap supplies `appEnv`; `platform/github/app-auth.ts` builds the provider behind `ports/installation-token.ts`; `modules/ingestion` exposes the job lifecycle service |
| `publishing` | `env`, `InstallationTokenProvider` | bootstrap supplies both; the provider port is shared with `workspace` |
| `webhooks` | `IngestionServices` (public services only) | `modules/ingestion` exposes intake, target lookup, and installation registration; webhooks never see repositories or the unit of work |

## Negative checks

A deliberately broken fixture would fail `npm run lint` in CI, so the checks are
documented manual probes. From the repository root: create the probe, run
`npx eslint <probe>`, confirm the listed rule fires, then delete the probe.
The probe must not end in `*.test.ts` (test-category files are exempt from
several policies).

| Probe | Expected rule |
|---|---|
| `src/modules/knowledge/__probe.ts` imports `../review/prompts/index.js`. | `boundaries/dependencies` (cross-module internal, nested path) |
| `src/modules/knowledge/__probe.ts` imports `../review/types.js`. | `boundaries/dependencies` (cross-module internal, non-`index.ts`) |
| `src/modules/knowledge/__probe.ts` imports `../../platform/config/env.js`. | `boundaries/dependencies` (`module -> platform`) |
| `src/modules/knowledge/__probe.ts` imports `../../bootstrap/clients.js`. | `boundaries/dependencies` (`module -> bootstrap`) |
| `src/platform/__probe.ts` imports `../../modules/knowledge/index.js`. | `boundaries/dependencies` (`platform -> module`) |
| `src/contracts/__probe.ts` imports `node:fs`. | `boundaries/dependencies` (`contracts` external allowlist) |
| `src/contracts/__probe.ts` imports `../modules/review/index.js`. | `boundaries/dependencies` (`contracts -> module`) |
| `src/shared/__probe.ts` imports `../platform/config/env.js`. | `boundaries/dependencies` (`shared -> platform`) |
| `src/ports/__probe.ts` imports `../modules/knowledge/index.js`. | `boundaries/dependencies` (`ports -> module`) |
| `src/shared/__probe.ts` imports `@prisma/client`. | `no-restricted-imports` |
| `src/shared/__probe.ts` imports `@prisma/client/runtime/library`. | `no-restricted-imports` (deep-import pattern) |
| `src/shared/__probe.ts` reads `process.env.EXAMPLE`. | `no-restricted-syntax` |
| `src/shared/__probe.ts` reads `process.env["EXAMPLE"]`. | `no-restricted-syntax` (computed form) |
| `src/shared/__probe.ts` calls `fetch("https://example.com")`. | `no-restricted-globals` |
| `src/modules/knowledge/__probe.ts` imports `bullmq`. | `no-restricted-imports` |
| `src/modules/knowledge/__probe.ts` imports `ioredis`. | `no-restricted-imports` |
| `src/modules/knowledge/__probe.ts` imports `@octokit/auth-app`. | `no-restricted-imports` |
| `src/modules/knowledge/__probe_a.ts` imports `__probe_b.ts`, and `__probe_b.ts` imports `__probe_a.ts`. | `import/no-cycle` |

The PR 3.12 verification used this probe set with no temporary allowances
present. Every probe produced the expected rule error; the probes were then
deleted. `rg 'eslint-disable.*boundaries' .` returns no matches, and
`eslint.config.mjs` contains only the approved vendor/environment exceptions
listed above.
