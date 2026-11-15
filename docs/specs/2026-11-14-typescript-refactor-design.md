# TypeScript Refactor Design — probot-poc

Status: Accepted design baseline (historical)
Date: 2026-11-14
Companions: [TypeScript gap analysis](../typescript-gap-analysis.md),
[TypeScript profile](../typescript-profile.md)
Standards: `engineering-handbook`, branch
`feat/CU-86bcdv1c9-typescript-guidelines`, snapshot `2c2182a`

> **Historical note.** The target tree and move table below describe the
> pre-refactor layout and the planned destination. The implemented module map,
> dependency rules, and flows are in [architecture.md](../architecture.md).

## 1. Intent

Bring `probot-poc` into conformance with the Nativewit TypeScript guidelines
without changing product behavior and without replatforming the service.

The refactor keeps the runtime that already fits the product — Node.js,
TypeScript, Probot, Prisma, BullMQ, Pino, Zod, Vitest — and adopts the
guidelines' engineering invariants: enforceable tooling, explicit contracts,
typed errors, layer boundaries, repository seams, injected dependencies, test
isolation, and documented deviations.

## 2. Why now

The gap analysis found that the repository has good raw material but no
enforcement and several structural seams missing:

- no ESLint, Prettier, lint/format/typecheck scripts, or CI;
- two parallel architectures, including a dead legacy review path;
- Prisma queries spread across 16 files in 10 top-level modules;
- 13 boundary `JSON.parse(...) as ...` casts;
- 28 bespoke error classes and no shared error envelope;
- import-time environment reads and hidden process singletons;
- 10 test files that require real Postgres/Redis.

The cost of leaving this is that every new feature adds another unenforced
convention, and the test suite becomes harder to trust as a refactor safety net.

## 3. Goals

1. **One architecture.** Delete the dead legacy review path; the live path is
   webhooks → ingestion → worker/review engine → publishing.
2. **Enforceable tooling.** ESLint, Prettier, `tsc --noEmit`, Vitest, and CI
   run the same commands locally and remotely.
3. **Contracts at every boundary.** One Zod schema and inferred type per HTTP,
   queue/outbox, config, model, and agent boundary; repositories map Prisma
   rows to domain types so database shapes do not leak.
4. **One error family.** `AppError` subclasses with stable codes and one
   mapping at the HTTP/queue edge.
5. **Repository and DI seams.** Prisma stays inside repositories; services and
   workers receive dependencies through composition roots.
6. **Module boundaries.** Vertical modules with public entry points; no module
   reaches into another module's internals.
7. **Test tiers.** Fast unit tests with fakes; explicit integration tests with
   Postgres/Redis; CI runs both.
8. **Documented deviations.** The product-stack choices that differ from the
   handbook are recorded in `docs/typescript-profile.md`.

## 4. Non-goals

- Introducing Next.js, React, Tailwind, shadcn/ui, TanStack Query, Zustand, or
  react-hook-form. This repository has no frontend.
- Introducing NestJS. Probot is the GitHub App framework; Nest would duplicate
  webhook, HTTP, and container concerns.
- Migrating Prisma to Drizzle. The Prisma schema and migrations are mature;
  switching ORMs is a data-layer rewrite with no domain benefit.
- Introducing pnpm, Turborepo, or a workspace layout for a single deployable.
  Revisit if the repo splits into independently deployed apps/packages.
- Adding product features, changing review behavior, or changing the database
  schema.
- Rewriting the agent runtimes beyond extracting shared utilities and
  testable seams.

## 5. Target stack

| Concern | Refactor stack | Action | Why |
|---|---|---|---|
| Runtime | Node.js 24, TypeScript 6, ESM | Keep | Already correct for the service; no framework migration. |
| GitHub integration | Probot 14 | Keep | Webhook verification, auth, and GitHub API integration are the product. |
| HTTP surface | Probot middleware + plain Node `http` | Keep, thin it | Admin/health routes already exist; extract routers from the composition root. |
| Database | PostgreSQL + Prisma 6 | Keep | Existing schema, migrations, and transactions. Repositories will wrap Prisma. |
| Queue | Redis + BullMQ | Keep | Durable review jobs and transactional outbox already depend on it. |
| Contracts | Zod 4 in `src/contracts` | Adopt/expand | Handbook requires Zod contracts; a package is unnecessary with one consumer. |
| Errors | `AppError` family + envelope | Adopt | Replaces 28 independent error classes and ad-hoc responses. |
| Persistence | Repository interfaces + Prisma adapters | Adopt | Removes Prisma from services and HTTP handlers. |
| DI | Composition roots + constructor/options injection | Adopt | No container needed; makes tests deterministic. |
| Logging | Pino 10 | Keep | Already structured and redacted. |
| Observability | OpenTelemetry + Prometheus | Keep | Existing spans, metrics, and alerts. |
| Testing | Vitest 3, fakes for unit, Postgres/Redis for integration | Keep/adapt | Preserves the test suite while making the unit tier fast and isolated. |
| Lint/format | ESLint 9 flat config + Prettier 3 | Adopt | Makes style reviewable by tooling, not humans. |
| CI | GitHub Actions | Adopt | Runs lint, format check, typecheck, test, build, and scanning. |
| Package manager | npm, single package | Keep (deviation) | One deployable; avoid package-manager churn during a structural refactor. |
| Workspace | Single package under `src/` | Keep (deviation) | No second app/package yet; module boundaries are enforced by structure and lint. |
| Frontend | None | N/A | No UI. |

### Why not the literal handbook stack?

The handbook's standard stack is written for a web product: Next.js for the
client, NestJS for the API, Drizzle for the database, and pnpm + Turborepo for a
monorepo. This repository is a GitHub App and background worker. Adopting that
stack literally would mean replacing Probot's webhook lifecycle, rewriting the
Prisma data layer, and adding a frontend framework to a service with no
frontend. That is a replatform with high risk and no user-facing benefit.

The handbook's own "Existing apps" rule supports this: new code uses the
standard where it applies, existing modules migrate when substantially changed,
and parts that stay on a non-standard library are recorded with a reason. The
invariants above are adopted; the product-stack deviations are recorded in
`docs/typescript-profile.md`.

## 6. Target architecture

### 6.1 Shape

A modular monolith in a single npm package, with two processes and explicit
ports/adapters:

```text
src/
├── index.ts                      # Probot app function: registers webhooks
├── server.ts                     # entry: bootstrapServer()
├── worker.ts                     # entry: bootstrapWorker()
├── bootstrap/
│   ├── server.ts                 # composition root: Probot + admin/health HTTP
│   ├── worker.ts                 # composition root: BullMQ worker lifecycle
│   ├── clients.ts                # env, logger, Prisma, Redis, queue, metrics
│   └── http.ts                   # health, readiness, metrics, admin routing
├── modules/
│   ├── webhooks/                 # Probot event handlers (thin adapters)
│   ├── triage/                   # issue triage use case + comment view
│   ├── ingestion/                # durable intake, state machine, outbox
│   ├── workspace/                # clone, checkout, diff, files, cleanup
│   ├── review/                   # adaptive engine, prompts, retrieval, runner
│   ├── findings/                 # validation, fingerprinting, persistence
│   ├── publishing/               # GitHub review/comment publication
│   ├── admin/                    # OAuth, session, API, panel, audit, rate limit
│   ├── execution/                # command policy and sandbox executors
│   └── knowledge/                # handbook/skill fetch, materialization
├── ports/                        # interfaces for external dependencies
│   ├── agent-runtime.ts
│   ├── model-provider.ts
│   ├── review-queue.ts
│   ├── logger.ts
│   └── clock.ts
├── contracts/                    # Zod schemas + inferred types
│   ├── admin.ts
│   ├── agent.ts
│   ├── config.ts
│   ├── errors.ts
│   ├── model.ts
│   ├── queue.ts
│   └── review.ts
├── platform/                     # concrete infrastructure adapters
│   ├── agents/                   # OpenCode CLI + SDK runtimes
│   ├── models/                   # OpenAI-compatible provider
│   ├── github/                   # Octokit + app auth
│   ├── config/                   # env + review config loaders
│   ├── db/                       # Prisma client
│   ├── queue/                    # BullMQ connection + review queue
│   ├── redis.ts
│   ├── logger.ts
│   ├── health.ts
│   ├── shutdown.ts
│   └── observability/            # metrics, tracing, alerts, retry, correlation
├── shared/                       # pure utilities + AppError family
│   ├── errors/
│   ├── ids.ts
│   ├── text.ts
│   └── time.ts
└── scripts/                      # operational CLIs, not runtime modules
    ├── config-validate.ts
    ├── config-dry-run.ts
    ├── eval/                     # benchmark runner, scoring, persistence
    ├── model-smoke.ts
    └── review-smoke.ts
```

`index.ts` stays as the Probot CLI entry point (`probot run ./lib/index.js`).
`server.ts` and `worker.ts` stay as process entry points for the existing
deployment commands.

### 6.2 Dependency direction

```text
                    bootstrap/*  (composition roots)
                         │ constructs + injects
                         ▼
                    modules/*    (application + domain)
                    │        │
                    │        └──────────────┐
                    ▼                       ▼
                 ports/*                contracts/*
              (interfaces)          (Zod boundary schemas)
                    ▲                       ▲
                    │ implements            │ used by
                    └──────── platform/* ───┘
                       (Prisma, Redis, BullMQ, Octokit,
                        OpenCode, model provider, Pino, OTel)
```

Rules:

- `contracts/` imports only `zod`.
- `shared/` and `ports/` are dependency-free apart from `contracts/` types.
- `modules/` may import `contracts/`, `shared/`, `ports/`, and another module's
  public `index.ts`. It must not import another module's internals or a
  `platform/` implementation.
- `platform/` implements `ports/` and may import `contracts/`, `shared/`, and
  `ports/`. It must not import `modules/`.
- `bootstrap/` is the only place that constructs concrete platform adapters and
  wires them into modules.
- Only repository implementations inside a module may import Prisma. Services
  receive repository interfaces.
- Only `platform/config/` may read `process.env`; scripts use `loadEnv()`.
- Only `platform/` adapters may call `fetch` or vendor SDKs.

### 6.3 Composition roots

`bootstrap/server.ts` and `bootstrap/worker.ts` do the same four things:

1. Load and validate environment and review config once.
2. Create the process-wide clients (logger, Prisma, Redis, queue connection,
   metrics registry).
3. Construct repositories, then services, then modules — injecting each layer.
4. Start the process and register shutdown.

Tests construct the same services directly with fakes. There is no service
locator or global container.

### 6.4 Contracts

`src/contracts` owns every shape that crosses a process, network, queue, or
external-system boundary:

- queue/outbox job payloads and outcomes;
- admin request/response bodies and query shapes;
- raw model-provider responses and error details;
- agent protocol messages and NDJSON/SDK host events;
- error envelope and stable code unions;
- environment and review-config schemas.

Types are inferred with `z.infer`; there is no hand-written duplicate. Vendor
boundaries that already provide trusted types — Probot webhook payloads and
Octokit REST responses — use those types rather than re-declaring them. Raw
JSON parsed outside a typed SDK still gets a schema.

### 6.5 Errors

```ts
class AppError extends Error {
  readonly code: string;        // stable identifier, e.g. REVIEW_NOT_FOUND
  readonly statusCode: number;  // HTTP mapping default
  readonly details?: unknown;   // safe details only
  readonly retryable: boolean;  // queue/outbox retry default
}
```

- Subclasses: `ValidationError`, `AuthError`, `ForbiddenError`,
  `NotFoundError`, `ConflictError`, `RateLimitError`, `ProviderError`,
  `InternalError`, plus domain errors (`ReviewEngineError`,
  `WorkspaceError`, `PublishingError`, `ExecutionError`).
- HTTP status and retryability are separate axes. Each class supplies a
  sensible default; `ProviderError` and `InternalError` may override
  `retryable` only with an explicit reason.
- A central `classifyFailure(error, context)` returns `retry` or `fail` plus a
  stable code and reason. The HTTP mapper and BullMQ/outbox policy both use it;
  neither re-implements classification.
- The HTTP envelope is `{ code, message, statusCode, details? }`. Stack traces,
  SQL, paths, and identifiers never enter `message` or `details`. Logs may carry
  the cause, still redacted.
- Existing error classes are migrated to `AppError` subclasses, not kept
  beside it.

### 6.6 Repositories and transactions

Each module owns the repository interfaces for the aggregates it uses, plus the
Prisma implementation:

```text
modules/ingestion/
├── ingestion.repository.ts          # interface + domain types
├── prisma-ingestion.repository.ts   # Prisma implementation
├── ingestion.unit-of-work.ts        # transaction port for multi-repo writes
├── ingestion.service.ts
├── outbox.service.ts
├── outbox.repository.ts
├── prisma-outbox.repository.ts
├── review-state.service.ts
├── recovery.service.ts
└── index.ts
```

- Repositories map Prisma rows/enums to contract or domain types.
- **Single-write operations use repository methods directly.** There is no
  transaction ceremony for one aggregate.
- **Multi-repository atomic operations use a module-owned unit-of-work port.**
  The callback receives a transaction-scoped repository bundle; Prisma's
  transaction client never appears in a service signature.
- The ingestion intake is the canonical case: installation, repository, pull
  request, review, job, state transition, webhook delivery, and outbox event
  must commit or roll back together.
- The Prisma implementation owns `$transaction` and creates the bundle from the
  transaction client. Default isolation and timeout semantics are preserved.
- Services do not import `@prisma/client`; repository implementations do.
- Cross-module reads go through the owning module's public service
  (`getReviewStatus`, `transitionReviewState`, `getFindingsForReview`), never
  through another module's repository.

Example port:

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

### 6.7 Testing

- **Characterization first:** before any production code is deleted or moved,
  capture the critical flows at their current boundaries — webhook ingestion,
  duplicate delivery, state transitions, outbox publication, queue retries,
  finding persistence, GitHub publication, admin auth, worker shutdown, and
  triage. These tests are the behavioral baseline.
- **Unit:** colocated `*.test.ts` beside the service; fake repositories, fake
  agent/model/queue/clock; no network, Postgres, Redis, or GitHub.
- **Contract:** next to `src/contracts`; every schema accepts a valid shape and
  rejects the important invalid cases.
- **Integration:** `test/integration/`; repositories, admin HTTP, queue/outbox,
  and Prisma transactions against real Postgres/Redis.
- **Smoke/E2E:** Docker Compose server + worker with webhook fixtures.
- Keep the existing 532 tests as behavior coverage while moving seams; do not
  delete a test unless its behavior is covered elsewhere.
- A test rewritten against a new internal seam does **not** count as proof that
  behavior was preserved. The characterization tests at the boundary are the
  proof; structural tests may be rewritten freely.

### 6.8 Runtime flows

**Webhook to review:**

```text
GitHub webhook
  → server (Probot) → modules/webhooks
  → modules/ingestion (Postgres transaction: installation/repo/PR/review/job/outbox)
  → outbox publisher → BullMQ (Redis)
  → worker → claim job → modules/workspace (clone + diff)
  → modules/review (engine → agent runtime → model provider)
  → modules/findings (validate + persist)
  → modules/publishing (GitHub API)
  → state transitions in Postgres
```

**Admin:**

```text
Browser → server (admin HTTP) → modules/admin
  → OAuth/session/CSRF → admin service
  → modules/ingestion (review status/manual trigger)
  → platform/config (review config read/update)
  → audit repository
```

**Knowledge:**

```text
worker boot → modules/knowledge (fetch handbook/skill → cache)
  → review runner receives the snapshot; review engine does not fetch
```

**Execution:**

```text
review engine (when enabled) → modules/execution
  → policy → local or Docker sandbox → audit repository
```

### 6.9 Reliability requirements

The Postgres + Redis + BullMQ + GitHub combination is at-least-once. The
refactor must preserve or improve the following:

- **Logical review identity:** `(pullRequestId, headSha, reviewMode,
  reviewType, attempt)`, enforced by a database unique constraint.
- **Job identity:** `jobKey` derived from installation, repository, PR, head
  SHA, review mode, review type, and optional attempt. BullMQ `jobId` is the
  durable `ReviewJob.id`, so re-publishing the same outbox event never creates
  a second queue job.
- **Webhook dedupe:** `WebhookDelivery.deliveryId` is unique; duplicate GitHub
  deliveries cannot create duplicate reviews.
- **Forced re-review:** manual `/review` increments `attempt`, creating a new
  logical review deliberately rather than bypassing dedupe.
- **Idempotent processing:** job processing is safe to repeat. State
  transitions are atomic and guarded by allowed predecessor states. Finding
  persistence is deduplicated by fingerprint. GitHub comments are deduplicated
  by fingerprint markers; summary reviews are reconciled against existing
  reviews.
- **Partial publication:** if a worker dies between `createReview` and the
  database write, the retry must find the existing summary review/comment and
  not publish a duplicate.
- **Retry classification:** transient failures (network, timeout, 429, 5xx,
  Redis/BullMQ unavailable, provider rate limit) may retry with explicit
  attempts/backoff. Permanent failures (validation, config, path escape, schema
  invalid, stale head, auth failure) fail the review without retrying.
- **Unknown internal errors:** default to non-retryable unless explicitly
  wrapped as transient. This avoids infinite retry loops.
- **Failed-job recovery:** BullMQ retries, the transactional outbox recovery
  loop, and startup/periodic reconciliation all have defined behavior. A
  review that exhausts attempts transitions to `failed` with a stable code.
- **Graceful shutdown:** stop accepting new jobs, allow active jobs to finish up
  to the shutdown deadline, close the worker/queue/Redis/Postgres in order, and
  never acknowledge a job that did not finish. BullMQ stalled-job recovery
  handles the forced-exit case.
- **Transaction atomicity:** the ingestion unit of work commits or rolls back
  installation, repository, pull request, review, job, transition, webhook
  delivery, and outbox rows together.

## 7. Module map

| Current | Target | Notes |
|---|---|---|
| `src/index.ts` | `src/index.ts` | Thin Probot app function; registers webhooks only. |
| `src/server.ts` | `src/server.ts` + `src/bootstrap/server.ts` | Entry point stays; composition moves to bootstrap. |
| `src/worker.ts` | `src/worker.ts` + `src/bootstrap/worker.ts` | Entry point stays; composition moves to bootstrap. |
| `src/handlers/` | `src/modules/webhooks/` | Thin event adapters. |
| `src/controllers/issue.controller.ts` | `src/modules/triage/` | Triage is a live capability; keep it, but as a service + view. |
| `src/controllers/pull-request.controller.ts` | Delete | Dead legacy review path. |
| `src/services/review.service.ts`, `src/views/review.view.ts` | Delete | Only used by the dead path. |
| `src/services/triage.service.ts`, `src/views/triage.view.ts` | `src/modules/triage/` | Replace the direct Groq `fetch` with the `ModelProvider` port. |
| `src/ingestion/` | `src/modules/ingestion/` | Orchestrator split into service + repositories + outbox + recovery. |
| `src/review-engine/` | `src/modules/review/` | Engine, prompts, retrieval, runner; contracts move to `src/contracts/review.ts`. |
| `src/findings/` | `src/modules/findings/` | Separate module: validation, fingerprint, repository, lifecycle. |
| `src/publishing/` | `src/modules/publishing/` | Octokit adapter behind a port; no review-state writes. |
| `src/admin/` | `src/modules/admin/` | HTTP, auth, session, panel, audit, rate limit; split by concern. |
| `src/execution/` | `src/modules/execution/` | Policy, executors, audit repository; wire when used. |
| `src/knowledge/` | `src/modules/knowledge/` | Fetch, materialize, summarize; public snapshot API. |
| `src/workspace/` | `src/modules/workspace/` | Clone, diff, cleanup, credentials, redaction. |
| `src/agent/` | `src/platform/agents/` + `src/ports/agent-runtime.ts` | OpenCode CLI/SDK are adapters; the runtime contract is a port. |
| `src/models/` | `src/platform/models/` + `src/ports/model-provider.ts` | OpenAI-compatible adapter; provider contract is a port. |
| `src/config/` | `src/contracts/config.ts` + `src/platform/config/` | Schemas in contracts; loaders in platform. |
| `src/lib/` | `src/platform/` | Prisma, Redis, logger, health, shutdown. |
| `src/observability/` | `src/platform/observability/` | Metrics, tracing, alerts, retry, correlation. |
| `src/recovery/` | `src/modules/ingestion/recovery.service.ts` | Outbox/reconciliation is ingestion lifecycle. |
| `src/eval/` | `src/scripts/eval/` | Benchmark tooling, not a runtime module. |
| `src/scripts/` | `src/scripts/` | Operational CLIs; use the same logger/config. |
| `src/views/` | Delete / move | Review view deleted; triage view moves to `modules/triage`. |

Settled placements:

- `agent` and `models` are **platform adapters** behind `ports/`.
- `findings` is a **separate module**, not part of `review`.
- `eval` is **tooling** under `scripts/eval`, not a runtime module.
- `recovery` is part of **ingestion**.
- `triage` is a **live module**, not part of the dead legacy path.

## 8. Migration phases

Each phase is a set of independently reviewable PRs. Every PR must leave the
application buildable, testable, and deployable.

### Phase 0 — Behavioral baseline and guardrails

- Capture the quality baseline and per-PR metrics script.
- Add ESLint, Prettier, scripts, stricter tsconfig, and CI.
- **Capture characterization tests before deleting or moving anything.**
- Delete only the verified dead legacy review path. Keep `effect` pinned at the
  root: it has no direct imports, but `@opencode/sdk` depends on it (ruling
  2026-11-15, PR 0.5).

**Exit:** CI green; characterization tests green against the current code; dead
path gone; no behavior change.

### Phase 1 — Contracts and errors

- Create `src/contracts` for queue/outbox, admin, model, agent, config, and the
  error envelope.
- Introduce the `AppError` family and the central failure classifier.
- Replace boundary casts with parsing; add contract tests.

**Exit:** no `JSON.parse as` at boundaries; admin responses use the envelope;
HTTP and queue classification are tested per error category.

### Phase 2 — Persistence and composition roots

This phase merges the reviewer's separate "repositories" and "DI" phases because
they land in the same PRs: you cannot extract a repository without changing the
constructor that used to call `getPrisma()`.

- Define repository interfaces and Prisma implementations per aggregate.
- Introduce the transaction-scoped unit-of-work port for ingestion (and any
  other multi-repository atomic operation).
- Create composition roots; inject dependencies; remove import-time env reads
  and hidden singletons.
- Make review state transitions atomic and idempotent.
- Document and test BullMQ idempotency, retry classification, duplicate webhook
  handling, failed-job recovery, and graceful shutdown.

**Exit (two gates):**
1. All Prisma access is behind repositories; multi-write operations use the
   unit-of-work port; no service imports Prisma or `process.env`.
2. Server and worker are wired entirely from composition roots; no module-level
   `loadEnv()`, `getPrisma()`, `getRedis()`, or `getReviewQueue()` remains.

### Phase 3 — Module migration and boundary enforcement

- Move code into `src/modules/*` with public `index.ts` entry points.
- Move platform adapters into `src/platform/*` and ports into `src/ports/*`.
- Split god files; extract shared agent-runtime utilities after characterization
  tests.
- **Add mandatory boundary linting**: no module → platform imports, no
  cross-module internals, no Prisma outside repositories, no `process.env`
  outside the config adapter, no circular imports, no `fetch` outside platform.

**Exit:** all boundary rules active with no exceptions; no cross-module internal
imports; module entry points stable.

### Phase 4 — Test tiers and CI infrastructure

- Split unit/contract/integration test projects.
- Move unit tests to fakes at the new seams.
- Keep/expand integration tests for repositories, routes, queue/outbox, and
  transactions.
- Add Postgres/Redis services to CI; keep local instructions in `CONTRIBUTING`.
- Add a Docker smoke test for server + worker.

**Exit:** unit tier runs with no infrastructure; integration tier runs in CI;
characterization suite remains green; full suite green.

### Phase 5 — Documentation and decisions

- Record deviations in `docs/typescript-profile.md`.
- Add ADRs for: Probot instead of Nest, Prisma instead of Drizzle, npm
  single-package instead of pnpm/Turborepo, `src/contracts` instead of a
  package, the unit-of-work port, and failure classification.
- Update `README.md`, `CONTRIBUTING.md`, and `docs/architecture.md` to point at
  the new module map.

**Exit:** a new contributor can follow the docs and find the rules.

## 9. Verification

- **Baseline:** `npm run build`, the full test suite with Postgres/Redis, the
  characterization suite, and the quality-metrics output, recorded before any
  deletion or move.
- **Per PR:** format check, lint, typecheck, unit tests, integration tests where
  relevant, build, and a targeted smoke test for the changed flow. The PR
  description includes the quality-metrics before/after table.
- **Per phase:** the phase exit criteria plus a review against the gap-analysis
  checklist. A phase may not increase any violation count; it must reduce the
  metric it targets.
- **Final:** full suite, characterization suite, Docker Compose smoke for server
  and worker, and a fresh contributor walkthrough of the docs.

Quality metrics tracked per PR:

- `any` in type positions;
- non-null assertions (`!`);
- unsafe `as` casts (excluding `as const`);
- boundary `JSON.parse(...) as ...`;
- Prisma imports outside repository implementations;
- `process.env` reads outside the config adapter;
- cross-module internal imports;
- circular dependencies;
- tests requiring Postgres/Redis outside the integration tier.

## 10. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Big-bang refactor breaks behavior | Phase-per-PR; keep the 532-test suite as the baseline; no feature work in the same PR. |
| Hidden references to the legacy path | Confirm with `rg` and tests; delete only after the live path is verified. |
| Prisma transaction semantics change | Keep transaction boundaries in the application service; repositories accept a transaction client. |
| Agent runtime extraction breaks CLI/SDK behavior | Characterization tests first; extract only shared utilities, not lifecycle logic. |
| Test suite loses integration coverage | Keep an explicit integration tier; do not replace it with mocks. |
| CI cannot run Postgres/Redis | Add service containers; make integration tests opt-in locally with documented setup. |
| Module moves create noisy diffs | Move-only PRs; behavior changes separate; use `git mv` to preserve history. |
| Deployment entry points change | Keep `server.ts`/`worker.ts` paths stable; verify Docker/Dokploy commands. |

## 11. Settled decisions

1. **Workspace shape:** single npm package. No pnpm/Turborepo migration.
2. **Error envelope:** `{ code, message, statusCode, details? }`; `AppError`
   carries `code`, `statusCode`, `details`, and `retryable`. The initial code
   registry is defined in `src/contracts/errors.ts`.
3. **Transaction ownership:** single-write operations use repository methods
   directly; multi-repository atomic operations use a module-owned unit-of-work
   port whose callback receives a transaction-scoped repository bundle. Prisma
   transaction clients never appear in service signatures.
4. **Integration test infrastructure:** GitHub Actions service containers in CI;
   the existing Docker Compose stack locally. Testcontainers is not required.
5. **Agent/model placement:** `src/platform/agents/` and
   `src/platform/models/`, behind `src/ports/agent-runtime.ts` and
   `src/ports/model-provider.ts`.
6. **Eval placement:** `src/scripts/eval/`; it is tooling, not a runtime module.
7. **`effect` dependency:** keep it. It is not imported directly in `src`,
   `test`, `scripts`, or config, but `@opencode/sdk@2.3.0` depends on
   `effect@4.1.0`; the root pin keeps npm from resolving Prisma's
   `effect@3.21.0` into the SDK's peer slot and is guarded by
   `test/deployment-node.test.ts`. Ruling 2026-11-15 (PR 0.5): do not
   uninstall it.
8. **Triage:** keep it as a live module under `src/modules/triage/`; it is not
   part of the dead legacy path.
9. **Boundary enforcement:** mandatory ESLint boundary rules, not optional.
10. **Phase order:** Phase 2 (persistence) and Phase 3 (composition roots) are
    merged because repository extraction and constructor changes land together.
11. **Characterization:** boundary tests are captured before any deletion or
    move; rewritten structural tests do not count as behavioral proof.
12. **Execution:** keep the existing execution module and tests; do not wire it
    into review unless current live behavior already requires it.
13. **Admin renderer:** keep EJS for the panel.
14. **Quality metrics:** every PR reports before/after violation counts; a phase
    must reduce the metric it targets and may not increase any other.

Still to settle in the implementation plan:

- The exact list of stable error codes (added with the endpoints/jobs that
  produce them).
- Whether the admin panel templates stay EJS or move to a different renderer.
- Whether `modules/execution` is wired into the review engine in this refactor
  or remains available but unused.
- The final placement of the `ReviewWorkspace` repository (workspace vs
  ingestion) if both need it.

## 12. Approval

This design is approved when the stack choice and the non-goals are accepted.
The next artifact is the phased implementation plan; implementation does not
start before that plan is approved.
