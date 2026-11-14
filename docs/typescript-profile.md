# TypeScript Profile — probot-poc

Status: draft · 2026-11-14
Canonical source: `engineering-handbook`, branch
`feat/CU-86bcdv1c9-typescript-guidelines`, snapshot `2c2182a`
Companions: [TypeScript gap analysis](./typescript-gap-analysis.md) ·
[Refactor design](./specs/2026-11-14-typescript-refactor-design.md)

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
- **Tests:** Vitest. Integration suites currently require Postgres and Redis.
- **CI:** none yet (`.github/` is absent).

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
| “Features” in `apps/web/features` | Vertical modules aligned to capabilities: webhooks, ingestion, review engine, publishing, admin, execution, knowledge. |
| React components, design tokens, forms | N/A — no frontend. |

## N/A

- `09_components-ui.md`, `10_design-tokens.md`, and `11_forms.md` are not
  applicable until a frontend exists.
- `06_state-management.md` applies only in its server/process-state sense.

## Known gaps (current)

These are tracked in full in the [gap analysis](./typescript-gap-analysis.md).

- No ESLint, Prettier, lint/format/typecheck scripts, or CI.
- No repository layer: 16 files across 10 top-level modules run Prisma queries
  directly.
- 13 `JSON.parse(...) as ...` boundary casts in `src`.
- 28 bespoke error classes; no shared `AppError` family or error envelope.
- Import-time `loadEnv()` in `src/ingestion/orchestrator.ts` and
  `src/ingestion/outbox.ts`; hidden `getPrisma()`/`getRedis()` call sites.
- 10 test files require real Postgres/Redis; `fileParallelism: false` works
  around shared-database fixtures.
- Dead legacy path: `src/controllers/pull-request.controller.ts` and
  `src/services/review.service.ts` are unreferenced by the live ingestion path.
- Large files: `opencode-runtime.ts` 1,200 lines, `opencode-sdk-runtime.ts` 866,
  `admin/api.ts` 820, `admin/panel.ts` 770, `review-engine/engine.ts` 637.

## Decisions pending

- Stay on npm or migrate to pnpm (single-package decision).
- How to run integration tests in CI (service containers vs Testcontainers).
- Error envelope shape and stable code registry for HTTP + queue failures.
- Module boundaries and public entry points for `src/`.
- Whether `src/agent`'s CLI and SDK runtimes share a common core.

## Rule

When a guideline is deliberately not followed, add a dated line under **Known
gaps** or **Decisions pending** with the reason and owner. An undocumented
deviation is treated as a defect during review.
