# TypeScript Standards Gap Analysis

Date: 2026-11-14 (baseline snapshot)
Repository snapshot: `ca91ebb` (`feat/handbook-conformance-review`, clean)
Standards source: `engineering-handbook`, branch
`feat/CU-86bcdv1c9-typescript-guidelines`, snapshot `2c2182a`
Companions: [TypeScript profile](./typescript-profile.md) ·
[Refactor design](./specs/2026-11-14-typescript-refactor-design.md)

> **Historical baseline.** The findings and file paths below describe the
> repository before the TypeScript refactor. They are retained as the
> reproducible starting point. Current status and remaining deviations are in
> [typescript-profile.md](./typescript-profile.md) and the final verification
> report.

## Purpose

This document records the current gap between `probot-poc` and the Nativewit
TypeScript guidelines. It is the baseline for the refactor plan; it does not
change behaviour.

## Baseline

- 112 source files, 21,471 LOC.
- 31 test files, 532 tests.
- `npm run build` passes.
- 19/19 non-database unit tests pass.
- No `.github/` directory: no CI, no PR template, no commit lint.

The full test suite was not run because 10 test files require Postgres/Redis.

## Applicability

The guidelines assume a pnpm + Turborepo monorepo with Next.js, NestJS, Drizzle,
React, and a shared `@nativewit/contracts` package. This repository is a single
npm package running Probot + BullMQ + Prisma, with no frontend.

- **Applies directly:** architecture, contracts, backend modules, DI, data
  fetching, errors, testing, coding standards, SOLID, git/review, repo
  standards.
- **Applies with adaptation:** monorepo structure, state management (server
  state only), framework-specific module patterns.
- **N/A:** components/UI, design tokens, forms.

The adapt/adopt decisions live in [typescript-profile.md](./typescript-profile.md).

## Scorecard

Status: **red** = non-compliant, **amber** = partial or adaptation needed,
**gray** = not applicable.

| Guideline | Status | Summary |
|---|---|---|
| 01 Architecture | Red | Two parallel paths; dead legacy review path; DB access in application modules; no repository seam. |
| 02 Monorepo & structure | Amber | Domain folders exist; single package; 86 files export multiple top-level symbols; tests not colocated. |
| 03 Contracts & schemas | Amber | Zod at env/config/model output; 13 `JSON.parse as` boundary casts; queue/outbox casts; no error envelope. |
| 04 Backend modules | Red | HTTP routing, business logic, persistence, and queueing mixed; 16 files query Prisma directly. |
| 05 Services & DI | Red | Good isolated seams, but 21 `getPrisma()` call sites and import-time `loadEnv()`; no consistent injection. |
| 06 State management | Gray/Amber | UI rules N/A; process singletons are implicit and unevenly owned. |
| 07 Data fetching | Amber | Good model-provider abstraction; parallel outbound clients; cast-based parsing. |
| 08 Error handling | Red | 28 bespoke error classes; ad-hoc admin error bodies; no shared family or global mapping. |
| 09 Components & UI | Gray | No frontend. |
| 10 Design tokens | Gray | No frontend. |
| 11 Forms | Gray | No frontend. |
| 12 Testing | Amber | 532 tests, but 10 files need real Postgres/Redis and tables are cleaned directly. |
| 13 Coding standards | Red | No ESLint/Prettier/CI; strictness flags missing; 113 `as`, 24 `as unknown as`, 7 `!` in `src`. |
| 14 SOLID | Amber | Several good interfaces; god files and duplicated runtime helpers. |
| 15 Git & code review | Amber | Mostly Conventional Commits; no enforcement, PR template, or CI gate. |
| 08 Repo standards | Red | No CI formatting/static checks/tests/dependency/secret scanning. |

## P0 findings — fix before the structural refactor

### 1. No enforceable tooling or CI

- No ESLint config, Prettier config, `lint`, `format`, or `typecheck` script.
- No `.github/workflows` or PR template.
- Consequence: every refactor can reintroduce the same violations without a
  failing signal.
- Fix: add the standard toolchain, scripts, and CI first.

### 2. Dead and parallel architecture

- `src/controllers/pull-request.controller.ts` has no importer.
- `src/services/review.service.ts` is only used by that dead file.
- The live path is `src/handlers/pull-request.ts` →
  `src/ingestion/orchestrator.ts` → worker/review engine → publishing.
- Consequence: two architectures in one repo; readers cannot tell which is
  authoritative.
- Fix: delete the dead path before moving anything else.
- Status (2026-11-15, PR 0.5): resolved. The controller, service, view, and
  orphaned `src/models/review.ts` are deleted. `effect` is **kept**, not
  removed: it has no direct imports, but `@opencode/sdk@2.3.0` depends on
  `effect@4.1.0` and the root pin prevents Prisma's `effect@3.21.0` from
  winning peer resolution; `test/deployment-node.test.ts` guards the pin.

### 3. Persistence is not behind a seam

- 16 files across 10 top-level modules contain Prisma queries.
- 21 `getPrisma()` call sites.
- `src/ingestion/orchestrator.ts` (501 lines) mixes input types, config loading,
  a database transaction, idempotency, queueing, and status reporting.
- Consequence: domain and application code cannot be tested without Postgres;
  Prisma is effectively the domain model.
- Fix: introduce repository contracts per aggregate and inject them; keep
  Prisma mapping inside repositories.

### 4. Boundary shapes are cast, not parsed

- 13 `JSON.parse(...) as ...` sites in `src`, including:
  - `src/knowledge/fetch.ts` (GitHub API payloads),
  - `src/knowledge/ensure-skills.ts` (skill manifest),
  - `src/models/openai-compatible.ts` (provider response/content),
  - `src/agent/opencode-runtime.ts` and `opencode-sdk-runtime.ts` (NDJSON
    events),
  - `src/agent/sdk/client.ts` and `host-process.ts` (host RPC),
  - `src/admin/panel.ts` (admin form JSON).
- `src/ingestion/outbox.ts` casts the outbox payload and silently defaults
  every missing field.
- Consequence: a producer change becomes a runtime surprise, not a compile or
  test failure.
- Fix: one Zod schema per boundary, inferred types, parse at the edge.

### 5. Error handling is fragmented

- 28 custom error classes extend `Error` independently.
- No `AppError` base class, no shared code registry, no error envelope.
- Admin API hand-builds `{ error: string }` bodies with ad-hoc statuses.
- 146 catch blocks; some are documented best-effort, but there is no shared
  policy for logging, retrying, or surfacing.
- Consequence: callers cannot reliably branch on failures; messages and status
  codes drift.
- Fix: shared error family + stable codes + one mapping at the HTTP/queue edge.

### 6. Import-time environment and hidden singletons

- `src/ingestion/orchestrator.ts:36` and `src/ingestion/outbox.ts:24` call
  `createLogger(loadEnv())` at module load.
- Modules reach for `getPrisma()`, `getRedis()`, and `getReviewQueue()` directly.
- Consequence: importing a module can read the environment or open connections;
  tests cannot isolate behaviour.
- Fix: composition roots create clients; services receive them.

## P1 findings

### 7. God files and duplication

- `src/agent/opencode-runtime.ts` — 1,200 lines.
- `src/agent/opencode-sdk-runtime.ts` — 866 lines.
- `src/admin/api.ts` — 820 lines.
- `src/admin/panel.ts` — 770 lines.
- `src/review-engine/engine.ts` — 637 lines.
- `src/publishing/publisher.ts` — 562 lines.
- `src/config/review-loader.ts` — 545 lines with 26 exports.
- The two agent runtimes duplicate helpers such as `defaultGitStatus`,
  `sessionDirKey`, and `truncate`.

### 8. Tests require infrastructure

- 10 test files import Prisma/Redis; 9 clean tables directly.
- `vitest.config.ts` sets `fileParallelism: false` because suites share one
  database.
- There are no fake repositories at the persistence seam.
- The tests are a strong safety net; keep them as an explicit integration tier
  while unit tests move to fakes.

### 9. Strictness and type-safety gaps

- `strict: true`, `noUnusedLocals`, `noUnusedParameters`,
  `noImplicitReturns`, and `noFallthroughCasesInSwitch` are present.
- Missing: `noUncheckedIndexedAccess`, `noImplicitOverride`,
  `verbatimModuleSyntax`.
- `src`: 113 `as` casts, 24 `as unknown as`, 7 non-null assertions. No explicit
  `any` in type positions (the three `src` hits are prose).
- Tests: 7 `any` usages, 74 `as` casts, 75 non-null assertions.

### 10. Naming and export consistency

- 86 of 112 source files export more than one top-level symbol.
- `src/config/review-loader.ts` has 26 exports;
  `src/review-engine/types.ts` has 23.
- File naming is mostly kebab-case; the `.controller.ts`, `.service.ts`, and
  `.view.ts` suffixes belong to the dead legacy path.
- Tests live in `test/`, not beside the source.

### 11. Commit and review enforcement

- 6 of the last 20 commits do not follow Conventional Commits.
- No commit lint, PR template, or branch protection evidence.
- No refactor/behaviour separation rule is enforced.

## Strengths to preserve

- No explicit `any` in source type positions, no `@ts-ignore`, no TODO/FIXME,
  no commented-out code.
- Zod at environment, review config, structured model output, and manual review
  body boundaries.
- Typed error codes in `ModelProviderError` and `AgentRuntimeError`.
- Real interfaces and injectable seams: `ModelProvider`, `AgentRuntime`,
  `SandboxExecutor`, `PublisherOctokit`, `InstallationTokenProvider`.
- Pino redaction, correlation logging, OpenTelemetry spans, metrics, readiness
  checks, graceful shutdown.
- Security tests for sandbox policy, path escapes, secret redaction, and
  workspace integrity.
- Comments explain why; architecture decisions are documented.

## Refactor implications

The refactor should be phased and behaviour-preserving:

1. **Guardrails:** ESLint, Prettier, CI, strictness flags, scripts, dead-code
   removal, profile document.
2. **Contracts and errors:** `src/contracts` schemas, error envelope,
   `AppError` family, remove boundary casts.
3. **Repositories and DI:** Prisma repositories, injected clients/loggers,
   remove import-time env reads, split composition roots.
4. **Module boundaries:** vertical modules with public entry points; split god
   files; extract shared runtime helpers.
5. **Test seams:** fakes for the unit tier, explicit integration tier, CI
   infrastructure.
6. **Decisions:** ADRs for npm vs pnpm, test infrastructure, error envelope,
   module boundaries.

Each phase should be a separate, reviewable PR with no behaviour change. Feature
work does not ride along with a refactor.

## Reproducing the checks

```bash
npm run build
npx vitest run test/env.test.ts test/logger.test.ts test/summary-format.test.ts
rg -n ':\s*any\b|<any>|as any|any\[\]' src
rg -n '[A-Za-z0-9_\)\]]!\.' src
rg -n 'as unknown as' src
rg -n 'JSON\.parse\([^\n]*\) as ' src
rg -l '\b(prisma|tx)\.[a-zA-Z]+\.(find|create|update|delete|upsert|count|aggregate|groupBy|\$transaction)' src
```

For the full suite, start Postgres and Redis first (the tests use the database
named by `DATABASE_URL` and clean tables between cases).
