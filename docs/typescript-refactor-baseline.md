# TypeScript Refactor Baseline

Date: 2026-11-15
Baseline revision: `e6a1b36fd17492efe4c61b7667fddf70acdd8978`
(clean tree at measurement)
Tooling revision: PR 0.1 adds `scripts/quality-metrics.mjs`,
`docs/typescript-refactor-baseline.md`, and the `metrics:quality` package
script only. `src/` and `test/` are unchanged from the baseline revision.
Companions: [TypeScript profile](./typescript-profile.md) ·
[Gap analysis](./typescript-gap-analysis.md) ·
[Refactor plan](./plans/2026-11-15-typescript-refactor-implementation.md)

> **Historical baseline.** Every path and count below describes the repository
> at the baseline revision, before the module/platform moves. Compare final
> counts with `npm run metrics:quality`; the current layout is in
> [architecture.md](./architecture.md).

## Purpose

This is the reproducible starting point for the TypeScript refactor. Every later
PR reports before/after counts from the same script so progress is measured with
one definition, not ad-hoc greps. This PR changes no product behaviour.

## Environment

| Item | Value |
|---|---|
| OS | Darwin 25.2.0, arm64 (macOS) |
| Node.js | v24.22.3 (primary baseline; run via `npx -y node@24.22.3` because the host default is v26.12.0) |
| Host default Node.js | v26.12.0 (build, tests, and metrics also pass with identical counts) |
| npm | 11.20.0 |
| TypeScript | 6.0.3 |
| Vitest | 3.2.7 |
| PostgreSQL | `localhost:5432`, database `reviewer`, 12 migrations, schema up to date |
| Redis | `localhost:6379` |
| Docker | 29.6.1 (sandbox tests in `test/integration/execution-security.test.ts`) |

The worktree had no `node_modules`; `npm ci` was run first. It installed
existing locked dependencies only; no dependency was added or changed.

## Commands and results

Recorded on Node v24.22.3:

| Command | Result |
|---|---|
| `npx -y node@24.22.3 node_modules/typescript/bin/tsc` | Passed (no output) |
| `npx -y node@24.22.3 node_modules/vitest/vitest.mjs run` | Passed: 31 test files, 536 tests, 36.88s |
| `npx -y node@24.22.3 scripts/quality-metrics.mjs` (twice) | Identical output on both runs |

Re-ran the package scripts with the host default Node v26.12.0:
`npm run build`, `npm test`, and `npm run metrics:quality` all pass with the
same 536 tests and the same metrics output.

The metrics output hash is
`ccbdd41c218c958f80615008415a90e057be7160372501446a81fc8db2b8c0f5`
(SHA-256, `scripts/quality-metrics.mjs` output; identical on both Node
versions).

The test suite ran against the local Postgres and Redis above with the default
environment used by the suites
(`postgres://postgres:postgres@localhost:5432/reviewer`,
`redis://localhost:6379`). No `DATABASE_URL` or `REDIS_URL` was set in the
shell; each suite applies those defaults with `??=`.

## Quality metrics baseline

`npm run metrics:quality` scans 112 files under `src/` and 31 under `test/`.
`Count` is occurrences unless noted; `Files` is the number of files with at
least one occurrence. The test-service metric counts files.

| Metric | Scope | Count | Files |
|---|---|---:|---:|
| `any` type positions | src | 0 | 0 |
| `any` type positions | test | 17 | 6 |
| Non-null assertions (`!`) | src | 28 | 15 |
| Non-null assertions (`!`) | test | 120 | 13 |
| `as const` | src | 26 | 13 |
| `as const` | test | 6 | 3 |
| Other `as` casts | src | 132 | 43 |
| Other `as` casts | test | 103 | 22 |
| `as unknown as` | src | 26 | 11 |
| `as unknown as` | test | 40 | 14 |
| Boundary `JSON.parse(...) as` | src | 13 | 9 |
| Boundary `JSON.parse(...) as` | test | 22 | 8 |
| Prisma imports outside `*.repository.ts` and `src/platform/db/**` | src | 17 | 16 |
| Prisma imports outside `*.repository.ts` and `src/platform/db/**` | test | 1 | 1 |
| `process.env` reads outside `src/platform/config/**` | src | 70 | 24 |
| `process.env` reads outside `src/platform/config/**` | test | 61 | 14 |
| Cross-module internal imports | src | 0 | 0 |
| Test files requiring Postgres/Redis outside `test/integration/**` | test | 10 | 10 |

Headline numbers for the ledger:

- `src` has **0** explicit `any` type positions.
- `src` has **28** non-null assertions in 15 files.
- `src` has **26** `as unknown as` double casts and **13** boundary
  `JSON.parse(...) as` casts.
- **16** `src` files import `@prisma/client` outside the future repository and
  platform DB layers (17 imports; `src/findings/store.ts` has a static import
  and an inline type import).
- **24** `src` files read `process.env` outside the future
  `src/platform/config/` layer (70 reads).
- **10** test files require Postgres or Redis and none live under
  `test/integration/`, which does not exist yet.
- Cross-module imports are **0** because `src/modules/` does not exist yet.
  The metric starts reporting when that layout lands.

## Definitions

The script masks comments, string/template literal contents, and regex literal
bodies before matching. `src` and `test` are counted separately. `as const` is
counted apart from casts. Import aliases (`import * as x`,
`import { a as b }`) are not casts.

| Metric | Definition |
|---|---|
| `any` type positions | `any` used as a type, including annotations, generic arguments, `as any`, and array/union members. Property reads such as `AbortSignal.any` and `expect.any` are excluded. |
| Non-null assertions | Postfix `!` on an identifier, call, index, or `this`; `!=` and `!==` are excluded. |
| `as const` | Literal narrowing; tracked separately and not treated as a cast. |
| Other `as` casts | Every `as` assertion that is not `as const` or part of `as unknown as`. |
| `as unknown as` | A double cast, counted once per expression. |
| Boundary `JSON.parse(...) as` | A balanced `JSON.parse(...)` call whose result is asserted with `as` instead of parsed with a schema. |
| Prisma imports | Imports of `@prisma/client` (static or dynamic) in files that are neither `*.repository.ts` nor under `src/platform/db/`. |
| `process.env` reads | Occurrences of `process.env` outside `src/platform/config/`. |
| Cross-module internal imports | Imports from `src/modules/<a>/` into `src/modules/<b>/` that bypass `<b>/index.ts`. |
| Test service requirement | Test files outside `test/integration/` that import/construct Prisma, ioredis, or BullMQ clients, or bootstrap `DATABASE_URL`/`REDIS_URL` with `??=`. Bare string references such as `postgresOk` do not count. |

The future paths (`src/platform/db/**`, `src/platform/config/**`,
`src/modules/**`, `test/integration/**`) do not exist yet. The exclusions are
built in now so later PRs do not have to change the script while code moves.

## Deltas from the gap analysis

The [gap analysis](./typescript-gap-analysis.md) was produced with ad-hoc
`rg` patterns. Where its numbers differ, this table is the canonical baseline.

| Metric | Gap analysis | Measured | Reason for the difference |
|---|---:|---:|---|
| `any` in `src` | 0 | 0 | Agrees. |
| Any in tests | 7 | 17 | The gap analysis counted only `: any` annotations. The script also counts generic arguments (`Record<string, any>`) and `as any`. |
| Non-null assertions in `src` | 7 | 28 | The gap analysis counted only `!.`. The script counts every postfix `!`, including `!)`, `!,`, `!;`, and `]!`. |
| `as unknown as` in `src` | 24 | 26 | The gap analysis counted lines; two lines contain two casts each. |
| Other `as` casts in `src` | 113 | 132 | The script counts the `as` token after excluding `as const`, `as unknown as`, and import aliases; the earlier grep was not consistent about aliases. |
| Boundary `JSON.parse(...) as` in `src` | 13 | 13 | Agrees. |
| `src` files importing `@prisma/client` | 16 | 16 | Agrees (17 imports). |
| `src` files reading `process.env` | 25 | 24 | `src/agent/sdk/config.ts` only mentions `process.env` in a comment; masked comments are not counted. |
| Test files requiring Postgres/Redis | 10 | 10 | Agrees. |

## Targets

These come from the refactor plan and are the exit criteria for the relevant
phases:

| Metric | Baseline | Target |
|---|---:|---|
| `any` in `src` | 0 | 0, never introduce |
| Non-null assertions in `src` | 28 | 0 |
| `as unknown as` in `src` | 26 | 0 |
| Boundary `JSON.parse(...) as` in `src` | 13 | 0 |
| Prisma imports outside repositories/platform DB | 16 files | 0 |
| `process.env` outside `src/platform/config` | 24 files | 0 |
| Cross-module internal imports | 0 | 0 |
| Test files requiring Postgres/Redis outside `test/integration` | 10 | 0 |

`as const` and total `as` casts are informational: the goal is zero unsafe
boundary casts, not zero casts in the entire codebase. A genuinely safe cast
must carry a one-line reason.

## Reproducing

```bash
npm ci
npx prisma migrate deploy                         # only when the DB is fresh
npm run build
npm test
npm run metrics:quality                            # Markdown table + JSON
npm run metrics:quality -- --details               # every match site
npm run metrics:quality -- --json                  # machine-readable JSON only
```

Postgres and Redis must be running at `localhost:5432` and `localhost:6379`.
`test/integration/execution-security.test.ts` also needs a running Docker daemon for the
sandbox tests. Two consecutive `metrics:quality` runs must be byte-identical;
the script has no timestamps, network access, or third-party dependencies.
The recorded baseline used Node 24.22.3; Node 26.12.0 produced identical
metrics.

## Known limitations

- The script is a masked-source scanner, not a TypeScript parser. Regex
  literals are detected with a heuristic (expression position) and the
  import-alias check is line-based. Multi-line import aliases would be
  miscounted if introduced.
- Comments, string/template contents, and regex bodies are masked, so fixture
  text and prose do not inflate counts. Template `${...}` expressions remain
  code and are counted.
- Circular imports are not reported yet; the plan tracks them in the quality
  ledger and they become meaningful once `src/modules/` exists.
- Test service detection is intentionally conservative. A suite that starts a
  service indirectly through a helper without one of the listed signals would
  not be counted.
- Counts are tied to the current layout. Compare before/after with the same
  script revision, not across script changes.

## Dependency audit follow-ups

The dependency audit is separate from the refactor metrics. `npm run
security:audit` fails on new high/critical advisories; the four known
high/critical advisories and their upgrade follow-ups are tracked in
[security-audit-follow-ups.md](./security-audit-follow-ups.md) and enforced by
`scripts/npm-audit-allowlist.json`.

## Rollback

Delete `scripts/quality-metrics.mjs`, this document, and the
`metrics:quality` entry in `package.json`. Nothing in `src/` or `test/`
depends on the script.
