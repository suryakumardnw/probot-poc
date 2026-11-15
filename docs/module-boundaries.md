# Module boundaries

ESLint enforces the module layout while Phase 3 moves code. The target policies
are active now; temporary allowances keep the current top-level layout lintable
until each directory moves. **PR 3.12 removes every temporary allowance and the
`legacy` element type.**

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
| `platform` | `src/platform` | Infrastructure adapters (HTTP error mapping, config, DB, queues, observability, runtimes). |
| `contracts` | `src/contracts` | Zod schemas and inferred types. |
| `ports` | `src/ports` | Interfaces modules and platform adapters depend on. |
| `shared` | `src/shared` | Dependency-free helpers and the `AppError` family. |
| `script` | `src/scripts`, `scripts` | Tooling and CLIs. |
| `test` | `test` | Test suites and helpers. |
| `legacy` | `src/{agent,config,eval,lib,models,observability}` | **Temporary.** Directories not moved yet. Deleted in PR 3.12. |

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
| `platform` | `contracts`, `ports`, `shared` |
| `contracts` | `zod` only (own internals are unrestricted) |
| `ports` | `contracts`, `shared` |
| `shared` | `contracts` |
| `script` | every application element |
| `test` | every application element |
| `legacy` (temporary) | every application element; removed with PR 3.12 |

External and Node core packages are allowed from every element except
`contracts`. `contracts` may import only `zod`; test-category files are exempt.
No module may import another module's internal file or a platform adapter,
except the explicit temporary admin allowance listed below.

`import/no-cycle` remains enabled for every source file.

## Vendor and environment rules

The rules apply to TypeScript (`**/*.{ts,mts,cts}`), root tooling
(`scripts/**/*.mjs`), and the standalone deploy diagnostic (`deploy/**/*.js`).

| Rule | Restriction | Approved exceptions |
|---|---|---|
| `no-restricted-imports` | No `@prisma/client` import, including deep subpaths via the `@prisma/client/*` pattern. | `src/**/*.repository.ts`, `src/platform/db/**`, and `test/**` (permanent). Temporary file allowances below. |
| `no-restricted-syntax` | No `process.env` reads. | `src/platform/config/**`, `test/**`, and `deploy/inspect-key.js` (permanent). Temporary directory allowances below. |
| `no-restricted-globals` | No global `fetch`. | `src/platform/**` (permanent). Temporary directory allowances below. |

Tests may use `@prisma/client` row types to assert database state and fixture
shapes. This is an **approved test-tier exception**, not application code:
repositories and `platform/db` remain the only production owners of the vendor
client. If the test fakes migration removes those imports, the exception can be
dropped later.

`deploy/inspect-key.js` is a one-off container diagnostic copied into a running
worker container; it is CommonJS, outside the package, and never imported by the
application. It is deliberately linted by these rules, with one permanent
`process.env` exception because reading the mounted key is its entire purpose.

## Temporary allowances

Every allowance is a `TODO(PR x.y)` in `eslint.config.mjs` with the same removal
PR recorded here. Move-only PRs sometimes leave a vendor or `fetch` use behind;
where that happens the table names both the move PR and PR 3.12 as the final
removal.

### `legacy` element type

| Path | Removed by |
|---|---|
| `src/agent`, `src/models` | PR 3.9 |
| `src/config`, `src/lib`, `src/observability` | PR 3.10 |
| `src/eval` | PR 3.11 |
| The `legacy` type and this table | PR 3.12 |

### Cross-element import allowances

| Allowance | Why it exists | Removed by |
|---|---|---|
| `module` -> `src/agent` | Workspace processors and the review engine use the agent runtime types before agent becomes a platform adapter. | PR 3.9 |
| `module` -> `src/models` | Triage imports the `ModelProvider` contract from `src/models` before it becomes `src/ports/model-provider.ts`. | PR 3.9 |
| `platform/models` -> `src/models` | The Groq triage provider reuses the OpenAI-compatible adapter until models move under `src/platform/models`. | PR 3.9 |
| `module` -> `src/config` | Modules use the review schema/loader before config becomes `platform/config`; module -> platform is forbidden, so this must become a port. | PR 3.10 |
| `module` -> `src/observability` | Modules emit metrics before observability becomes `platform/observability`; module -> platform is forbidden, so this must become a port. | PR 3.10 |
| `ports` -> `src/config` | `ports/review-config.ts` re-exports `ConfigValidationError` and the `ReviewConfig` type from the concrete loader. | PR 3.10 |
| `contracts/review.ts` -> `src/modules/review` | `FINDING_CATEGORIES` still lives in the review module's `types.ts`. The move PR is move-only, so PR 3.12 moves the constant into `contracts/review.ts`. | PR 3.12 |
| `modules/admin` -> `platform/http/error-mapper.ts` | The admin API and panel render failures through the platform HTTP projection. PR 3.12 injects the projection from the composition root or makes it a shared helper. | PR 3.12 |

### `process.env` allowances

Permanent: `src/platform/config/**`, `test/**`, `deploy/inspect-key.js`.

Every temporary row below names the move PR and **PR 3.12 as the explicit final
removal**. The reads survive move-only PRs, so the move PR alone cannot remove
the allowance.

| Temporary path | Removed by |
|---|---|
| `src/config/**` | PR 3.10; PR 3.12 final |
| `src/bootstrap/**` | PR 3.10; PR 3.12 final |
| `src/modules/admin/**` | PR 3.12 final (development-only login reads `ADMIN_DEV_LOGIN`) |
| `src/agent/**` | PR 3.9; PR 3.12 final |
| `src/modules/execution/**` | PR 3.12 final (sandbox and process environment reads) |
| `src/modules/knowledge/**` | PR 3.12 final (GitHub token reads) |
| `src/models/**` | PR 3.9; PR 3.12 final |
| `src/observability/**` | PR 3.10; PR 3.12 final |
| `src/modules/publishing/**` | PR 3.12 final (model id resolution reads environment) |
| `src/modules/workspace/**` | PR 3.12 final (token provider reads environment) |
| `src/scripts/**` | PR 3.11; PR 3.12 final |

### Prisma allowances

Permanent: `src/**/*.repository.ts`, `src/platform/db/**`, `test/**`.

| Temporary file | Removed by |
|---|---|
| `src/lib/prisma.ts`, `src/lib/health.ts` | PR 3.10 (become `platform/db` and `platform/health`) |
| `src/bootstrap/clients.ts` | PR 3.10 (composition root consumes platform factories); PR 3.12 removes any direct vendor type |
| `src/modules/knowledge/materialize.ts` | PR 3.12 replaces the vendor type with a port |
| `src/modules/execution/service.ts` | PR 3.12 replaces the vendor type with a port |
| `src/eval/persistence.ts` | PR 3.11 moves eval under scripts; PR 3.12 removes the vendor type |

### `fetch` allowances

Permanent: `src/platform/**`.

| Temporary path | Removed by |
|---|---|
| `src/modules/admin/**` | PR 3.12 replaces the OAuth client with a platform-owned identity client |
| `src/modules/knowledge/**` | PR 3.12 replaces the client with a platform-owned client or port |

## Negative checks

The rules are verified manually because a deliberately broken fixture would
fail `npm run lint` in CI. From the repository root, create a probe, run ESLint
on it, and delete it:

| Probe | Expected rule |
|---|---|
| A module imports another module's non-`index.ts` file. | `boundaries/dependencies` |
| A module imports `../../platform/...`. | `boundaries/dependencies` |
| `src/contracts/...` imports `node:fs` or a non-Zod package. | `boundaries/dependencies` |
| `src/shared/...` imports `../lib/...`. | `boundaries/dependencies` |
| A non-repository file imports `@prisma/client`. | `no-restricted-imports` |
| A non-repository file imports `@prisma/client/runtime/library`. | `no-restricted-imports` (deep-import pattern) |
| A non-platform file reads `process.env`. | `no-restricted-syntax` |
| A non-platform file calls global `fetch`. | `no-restricted-globals` |

The PR 3.1 verification used this probe set and each import produced the
expected rule error; the probes were then removed.

## PR 3.12 removal checklist

1. Delete `LEGACY_ELEMENT_PATHS`, `PROCESS_ENV_ALLOWED_FILES`,
   `PRISMA_ALLOWED_FILES`, and `FETCH_ALLOWED_FILES` from `eslint.config.mjs`.
2. Delete the `legacy` element descriptor and every policy that references it.
3. Keep only the permanent exceptions: `*.repository.ts`/`platform/db` and
   `test/**` for Prisma (including deep imports), `platform/config`, `test/**`,
   and `deploy/inspect-key.js` for `process.env`, `platform/**` for `fetch`, and
   the `test` element/file category.
4. Update this document in the same commit.
5. Re-run the negative checks above with no temporary allowances present.
