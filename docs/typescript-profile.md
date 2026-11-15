# TypeScript Profile — probot-poc

Status: final · 2026-11-15
Canonical source: `engineering-handbook`, branch
`feat/CU-86bcdv1c9-typescript-guidelines`, snapshot `2c2182a`
Companions: [TypeScript gap analysis](./typescript-gap-analysis.md) ·
[Refactor design](./specs/2026-11-14-typescript-refactor-design.md) ·
[Architecture](./architecture.md) · [ADRs](./adr/README.md) ·
[Final verification report](./typescript-refactor-report.md)

This file records how the Nativewit TypeScript guidelines apply to this
repository. It is a decision record, not a copy of the handbook. Update it when
an adaptation or deviation is accepted.

## Repo shape

- **Package manager:** npm, single package (`package-lock.json`), Node >= 24,
  ESM (`"type": "module"`).
- **Runtime/framework:** Probot GitHub App, a plain Node HTTP server, and a
  BullMQ worker.
- **Data/queue:** PostgreSQL via Prisma; Redis via ioredis; BullMQ queue.
- **Frontend:** none. No React, Next.js, design tokens, or forms.
- **Tests:** Vitest with four tiers in `vitest.config.ts`: service-free
  `unit` + `contract`, and `integration` + `characterization` with
  Postgres/Redis (Docker for the sandbox suite).
- **CI:** GitHub Actions (`Quality`, `Unit`, `Test`, `Docker smoke`,
  `Commitlint`, `Security`).

## Adopt unchanged

- Strict TypeScript; no `any`, `!`, or boundary `as`.
- Parse, don't cast: every boundary shape gets one Zod schema and inferred type.
- Typed `AppError` family with stable codes and one edge mapping.
- Controller/adapter → service → repository dependency direction.
- Injected dependencies; no hidden module-level clients or env reads in domain
  code.
- Tests fake at seams; integration tests are explicit.
- SOLID, one primary export per file, kebab-case names.
- Conventional Commits, one intent per PR, refactor separate from behaviour.
- CI must run lint, typecheck, test, and build.

## Adapt

| Guideline assumption | This repo |
|---|---|
| pnpm + Turborepo monorepo | Single npm package. Stay single-package until a second consumer exists; do not add empty `apps/`/`packages/` ceremony. |
| NestJS modules and DI container | Plain module folders under `src/` with explicit factories/options objects. Do not add Nest just for DI. |
| Drizzle schema and repositories | Prisma schema + generated client. Repositories map Prisma rows to domain types; Prisma stays out of services. |
| `@nativewit/contracts` package | `src/contracts` for now; extract a package only when a second real consumer exists. |
| Next.js route → feature hook → API client | Probot handler → ingestion/application service → worker/pipeline → outbound adapter. |
| TanStack Query / Zustand | N/A. Process state is explicit and injected, not a UI store. |
| “Features” in `apps/web/features` | Vertical modules aligned to capabilities: webhooks, triage, ingestion, workspace, review, findings, publishing, admin, execution, knowledge. Platform adapters, ports, contracts, and shared code are separate layers. |
| React components, design tokens, forms | N/A — no frontend. |
| “Unused dependency must be removed” | `effect` stays pinned at `4.1.0`. It has no direct imports, but `@opencode/sdk@2.3.0` depends on it and the root pin keeps Prisma's `effect@3.21.0` from winning peer resolution. Guarded by `test/deployment-node.test.ts`; ruling 2026-11-15 (PR 0.5). |

## Interface changes

- **Admin HTTP error envelope (2026-11-15, PR 1.3).** Every `/api/admin/*`
  failure now returns `{ code, message, statusCode, details? }` instead of
  `{ error: string }` plus ad-hoc extras (`reason`, `retryAfterSeconds`, GitHub
  `description`). HTTP statuses are unchanged: validation 400, auth 401,
  forbidden 403, not-found 404, conflict 409, rate-limit 429, internal 500,
  plus the existing 413 payload-too-large and 502/503 operational statuses.
  Client-visible extras move under `details`; request-validation issues are a
  `details` array of `{ path, message }`. Clients must read `code`/`message`
  instead of `error`. This is the approved API contract change for the
  refactor; the EJS panel and its session/CSRF flow are unchanged. The one
  request/response/error contract is `src/contracts/admin.ts`.

## Compiler strictness

`tsconfig.json` enables `strict`, `noUncheckedIndexedAccess`,
`noImplicitOverride`, and `verbatimModuleSyntax` (PR 0.3). Indexing a
`string[]`, `Record`, or regex match result therefore yields `T | undefined`,
overrides must be marked `override`, and type-only imports must use
`import type`.

- **`exactOptionalPropertyTypes` is deferred, not rejected** (2026-11-15,
  PR 0.3). The codebase declares hundreds of optional properties (`?:`), and
  several assign `undefined` into them on purpose — for example
  `ParsedDiffFile.previousPath` and `AgentRuntimeError.detail`. Enabling the
  flag would reject those assignments unless the property types become
  `field: T | undefined`, which erases the distinction between an absent key
  and a present `undefined` value in every consumer (object spreads, `in`
  checks, `Object.keys`, and Prisma writes). That is a data-shape decision, not
  a mechanical fix, so it stays out of the compiler-flag PR.
  - Follow-up: a dedicated compiler-hardening PR after this refactor. It
    audits every optional property that is written with `undefined`, splits
    "absent" from "explicitly undefined", adds tests for serialized payloads,
    then enables the flag in its own commit.

## N/A

- `09_components-ui.md`, `10_design-tokens.md`, and `11_forms.md` are not
  applicable until a frontend exists.
- `06_state-management.md` applies only in its server/process-state sense.

## Known gaps (current)

These are tracked in full in the [gap analysis](./typescript-gap-analysis.md).
Final verification on 2026-11-15: 67 test files / 1,059 tests pass
(500 unit, 194 contract, 280 integration, 85 characterization); Docker Compose
smoke passes. Details in the
[final verification report](./typescript-refactor-report.md).

At the end of the refactor:

- **Tooling and CI are in place.** ESLint (with boundary, vendor, and
  environment rules), Prettier, `typecheck`, `typecheck:tests`, metrics, four
  test tiers, build, audit, commitlint, and Docker smoke run locally and in CI.
- **Persistence is behind repositories.** No `src` file imports
  `@prisma/client` outside `*.repository.ts` adapters or `src/platform/db/**`;
  no `src` file reads `process.env` outside `src/platform/config/**`.
- **Boundary shapes are parsed.** There are zero boundary
  `JSON.parse(...) as` casts and zero explicit `any` type positions in `src`.
- **No non-null assertions in `src`.** The frozen characterization suite keeps
  a narrow lint allowance for `any`/`!`; unit, contract, integration, and
  helper code are fully checked.
- **11 `as unknown as` casts remain in `src`** in six localized adapter/
  defensive sites: `modules/workspace/git.ts` (Node error `code`), the SDK
  dynamic import and config redaction/clone helpers, the Octokit publisher
  adapter, metric internals, and a logger `child` capability probe. Each is
  confined to a platform/module edge and listed in the
  [final verification report](./typescript-refactor-report.md).
- **Three test files are flagged by the service metric**: two
  characterization suites and `test/helpers/db.ts`. The characterization tier
  is intentionally an infrastructure tier; the helper imports Prisma to clean
  the database.
- **`src/modules/review/result-schema.ts` is a compatibility re-export** of
  `src/contracts/review.ts`. New code imports the contract; removing the shim
  needs one import update in a contract test.
- **`effect` stays pinned at `4.1.0`.** It has no direct imports, but
  `@opencode/sdk@2.3.0` depends on it and the root pin keeps Prisma's
  `effect@3.21.0` from winning peer resolution. Guarded by
  `test/deployment-node.test.ts`; ruling 2026-11-15 (PR 0.5).

## Decisions and remaining follow-ups

Resolved during the refactor:

- **npm vs pnpm:** stay on a single npm package —
  [ADR 0003](./adr/0003-single-npm-package.md).
- **Integration tests in CI:** GitHub Actions service containers plus a Docker
  Compose smoke job; no Testcontainers.
- **Module boundaries:** vertical modules with public `index.ts` entry points,
  enforced by ESLint —
  [module-boundaries.md](./module-boundaries.md),
  [ADR 0001](./adr/0001-keep-probot.md),
  [ADR 0003](./adr/0003-single-npm-package.md).
- **CLI vs SDK runtimes:** keep two adapters behind the `AgentRuntime` port. A
  shared core is not extracted; the shared helpers already live in
  `src/platform/agents`.
- **Contracts location:** `src/contracts`, no package —
  [ADR 0004](./adr/0004-contracts-in-src.md).
- **Multi-repository atomic writes:** module-owned units of work —
  [ADR 0005](./adr/0005-unit-of-work.md).
- **Error and retry policy:** one `AppError` family and one queue classifier —
  [ADR 0006](./adr/0006-failure-classification.md).

Still open (owner: refactor maintainer):

- **`exactOptionalPropertyTypes`** remains deferred (see
  [Compiler strictness](#compiler-strictness)).
- **`agent/opencode-runtime.ts` (1,224 lines)** and
  **`opencode-sdk-runtime.ts` (886 lines)** remain large. They are isolated
  adapters behind the runtime port; splitting them requires a dedicated
  behavior-preserving PR.
- **Review result-schema shim** removal.
- **Characterization lint allowance** can be retired only if the frozen
  baseline is ever re-recorded.

## Rule

When a guideline is deliberately not followed, add a dated line under **Known
gaps** or **Decisions and remaining follow-ups** with the reason and owner. An
undocumented deviation is treated as a defect during review.
