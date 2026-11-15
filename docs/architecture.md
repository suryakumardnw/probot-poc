# Architecture

Status: current · 2026-11-15 · reflects the implemented TypeScript refactor.

This document describes the system **as implemented**. The pre-refactor design
baseline is retained in
[specs/2026-11-14-typescript-refactor-design.md](specs/2026-11-14-typescript-refactor-design.md);
where the two differ, this document and the code win.

Companions:

- [How a PR review works](how-pr-review-works.md) — end-to-end walkthrough and
  prompt reference.
- [Module boundaries](module-boundaries.md) — the enforced ESLint policy.
- [Queue reliability](queue-reliability.md) — the full queue/shutdown contract.
- [Deployment](deployment.md) — Compose topology, secrets, backup/restore.
- [ADRs](adr/README.md) — the approved deviations from the handbook stack.

## 1. System overview

A modular monolith in **one npm package**, deployed as **two processes**:

| Process | Entry point | Responsibility |
|---|---|---|
| `probot` | `src/server.ts` → `src/index.ts` | Receive and verify GitHub webhooks, persist a review request, enqueue it, serve health/readiness/metrics, the admin API/panel, and the manual review API. Never runs review inference; `issues.opened` triage is a best-effort model call (see §5). |
| `worker` | `src/worker.ts` | Consume BullMQ jobs, clone the PR, inject knowledge, run the staged agent review, validate and persist findings, publish the GitHub review, and run recovery loops. |

Both processes share the same code and the same PostgreSQL/Redis services.
PostgreSQL is the durable source of truth; Redis is transport and queue state.
The full stack (Postgres, Redis, one-shot migrations, `probot`, `worker`,
optional backups) runs as one Docker Compose project on Dokploy
([deployment.md](deployment.md)).

### Request path

```text
GitHub webhook
  → src/index.ts (Probot registration)
  → src/modules/webhooks/*          thin event adapters
  → src/modules/ingestion/*         one Postgres transaction + outbox row
  → Redis "review-jobs" queue
  → src/modules/workspace/processor.ts   BullMQ consumer
  → workspace clone/diff
  → knowledge materialization + injection
  → src/modules/review/*            staged agent review
  → src/platform/agents/*           OpenCode CLI or SDK adapter
  → src/modules/findings/*          validate, fingerprint, persist
  → src/modules/publishing/*        summary + inline comments
```

## 2. Repository layout

```text
src/
├── index.ts                 # Probot app function (probot run ./lib/index.js)
├── server.ts                # server process entry: bootstrapServer()
├── worker.ts                # worker process entry: bootstrapWorker()
├── bootstrap/               # composition roots
│   ├── server.ts            # HTTP + Probot + admin/health graph
│   ├── worker.ts            # BullMQ worker graph
│   ├── clients.ts           # env → logger, Prisma, Redis, queue, services
│   └── http.ts              # health, readiness, metrics, manual review, routing
├── modules/                 # vertical capabilities, public API in index.ts
│   ├── webhooks/            # Probot event adapters
│   ├── triage/              # issue triage use case + comment view
│   ├── ingestion/           # durable intake, state machine, outbox, recovery
│   ├── workspace/           # clone, checkout, diff, disk, cleanup, processor
│   ├── review/              # adaptive engine, prompts, retrieval, hook
│   ├── findings/            # validation, fingerprinting, store, lifecycle
│   ├── publishing/          # pipeline wiring, GitHub review/comment output
│   ├── admin/               # OAuth, sessions, API, panel, audit, rate limit
│   ├── execution/           # command policy and sandbox executors
│   └── knowledge/           # boot cache use, review materialization, summary
├── platform/                # concrete infrastructure adapters
│   ├── agents/              # OpenCode CLI + SDK runtimes, registry, config
│   ├── models/              # OpenAI-compatible provider, triage provider
│   ├── github/              # Octokit, app auth, OAuth client
│   ├── config/              # env, review config loader and store
│   ├── db/                  # Prisma client, evaluation-run repository
│   ├── queue/               # BullMQ connection and review queue
│   ├── knowledge/           # GitHub knowledge fetch adapter
│   ├── observability/       # metrics, tracing, alerts, metrics endpoint
│   ├── redis.ts             # shared Redis client
│   ├── logger.ts            # Pino logger factory
│   ├── health.ts            # readiness probes
│   └── shutdown.ts          # phase-ordered graceful shutdown
├── ports/                   # interfaces modules/platform depend on
├── contracts/               # Zod schemas + inferred boundary types
├── shared/                  # dependency-free helpers + AppError family
│   ├── errors/
│   ├── retry.ts             # failure classification + retry decision
│   ├── queue-payload.ts     # queue name/payload parsing
│   ├── model-id.ts
│   └── object-path.ts
└── scripts/                 # operational CLIs (config, eval, smoke), not runtime
```

`test/` mirrors the runtime tiers: `unit` + `contract` are service-free;
`integration` and `characterization` use Postgres/Redis (and Docker for the
sandbox suite). Tier definitions live in `vitest.config.ts`.

## 3. Dependency rules

The rules are enforced by `eslint-plugin-boundaries` in `eslint.config.mjs`
with `default: "disallow"`. The complete policy, element table, vendor
exceptions, and negative probes are in
[module-boundaries.md](module-boundaries.md). Summary:

| From | May depend on |
|---|---|
| `bootstrap` | every application element |
| `module` | `contracts`, `ports`, `shared`, its own internals, other modules' `index.ts` only |
| `platform` | `contracts`, `ports`, `shared`, its own internals |
| `contracts` | `zod` only |
| `ports` | `contracts`, `shared` |
| `shared` | `contracts` |
| `script` | every application element |
| `test` | every application element |

Additional enforced rules:

- No `@prisma/client` import outside `src/**/*.repository.ts`,
  `src/platform/db/**`, and tests.
- No `process.env` read outside `src/platform/config/**`, tests, and the
  one-off `deploy/inspect-key.js`.
- No global `fetch` outside `src/platform/**`.
- `import/no-cycle` is enabled for every source file.
- There is no `legacy` element type and no temporary allowance.

The dependency direction is:

```text
bootstrap/*  constructs + injects
     │
     ▼
modules/*  application + domain
     │                 │
     ▼                 ▼
  ports/*         contracts/*
     ▲                 ▲
     │ implements      │ used by
     └── platform/* ───┘
```

## 4. Module map

Each module exposes one public `index.ts`. Other modules and bootstrap import
only that entry point.

| Module | Owns | Does not own |
|---|---|---|
| `webhooks` | Probot event registration and translation for `pull_request`, `issue_comment`, and `installation`. | Ingestion transactions, review execution. |
| `triage` | `issues.opened` use case, model prompt, comment rendering and posting. | Review intake or the review engine. |
| `ingestion` | Durable review intake, idempotency keys, review-state machine, transactional outbox, outbox recovery, incomplete-review reconciliation. | Cloning, AI execution, GitHub publishing. |
| `workspace` | Git clone/checkout/diff, changed files, workspace retention/cleanup, disk quota, credential and redaction helpers, BullMQ processor lifecycle. | Review prompts, finding validation. |
| `review` | Adaptive complexity scoring, review plan/budgets, staged prompts, controlled retrieval, result normalization, engine hook. | Persistence, GitHub output, model transport. |
| `findings` | Finding validation against the workspace, fingerprints, persistence, lifecycle/status updates, finding repository and unit of work. | GitHub comment rendering. |
| `publishing` | Pipeline wiring, stale-commit guard, summary and inline-comment rendering, diff-position mapping, GitHub publisher, publishing repository. | Review reasoning. |
| `admin` | GitHub OAuth, sessions/CSRF, admin HTTP services, server-rendered panel, audit log, rate limiting. | Review queue processing. |
| `execution` | Command policy/allowlist, local and Docker executors, resource limits, audit repository. | Agent tool policy (the review agent has no shell). |
| `knowledge` | Use of the boot-time skill/handbook cache, per-review materialization and snapshot identity, knowledge metrics summary. | Network fetching (`platform/knowledge`). |

### Platform adapters

| Adapter | Implements / provides |
|---|---|
| `platform/agents` | `AgentRuntime` port: `opencode-cli` (default) and `opencode-sdk` (opt-in) behind the runtime registry. |
| `platform/models` | `ModelProvider` port: OpenAI-compatible provider plus the Groq-backed triage provider. |
| `platform/github` | Octokit/publisher client and `GithubOAuthClient`. |
| `platform/config` | `Env` loading/validation, `review.json` loader and boot-time `ReviewConfigStore`. |
| `platform/db` | Prisma client and the evaluation-run repository. |
| `platform/queue` | BullMQ queue factory and Redis connection policy. |
| `platform/knowledge` | GitHub-backed `KnowledgeFetcher`. |
| `platform/observability` | Prometheus metrics, OpenTelemetry tracing, alerts, `/metrics` endpoint. |
| `platform/redis.ts`, `logger.ts`, `health.ts`, `shutdown.ts` | Shared clients and process lifecycle. |

### Ports and contracts

- **Ports** (`src/ports`) are the interfaces modules consume: `AgentRuntime`,
  `ModelProvider`, `ReviewQueue`, `ReviewConfigStore`, `Logger`, `Clock`,
  `GithubPublisher`, `GithubOAuthClient`, `KnowledgeFetcher`, `Observability`,
  `ReviewLogging`.
- **Contracts** (`src/contracts`) own the process/network boundary Zod
  schemas: queue/outbox payloads, admin HTTP bodies/queries/responses, model
  response shapes, agent protocol messages, error codes/envelope, environment
  and review config. One composition-root exception remains:
  `src/bootstrap/http.ts` defines `manualReviewBodySchema` for the
  `POST /api/reviews` body. Follow-up: move it to `src/contracts/admin.ts`.
- **Shared** (`src/shared`) is dependency-free: typed `AppError` family,
  `classifyFailure`/`classifyQueueFailure`, queue payload helper, redaction,
  object-path helpers, model-id parsing.

## 5. Server flow

`src/server.ts` calls `bootstrapServer()` in `src/bootstrap/server.ts`:

1. Load and validate environment (`platform/config/env.ts`) and build the
   logger.
2. Create process clients: Prisma, Redis, BullMQ queue
   (`bootstrap/clients.ts`).
3. Build the config store (boot-time environment snapshot + per-call
   `config/review.json` read), ingestion services/repositories/unit of work,
   webhook services, and triage dependencies.
4. Build the admin API/panel, the manual review handlers, and readiness
   probes; create Probot middleware **only** when `APP_ID` and a private key
   are present (otherwise the HTTP surface still starts degraded).
5. Register health/readiness/metrics, the manual review API, admin API, panel,
   and finally the Probot webhook path at `/`.
6. Register graceful shutdown.

Webhook handlers are intentionally thin: verify the event, apply bot/draft
policy through the ingestion service, then return. The ingestion transaction
writes `Installation`, `Repository`, `PullRequest`, `Review`, `ReviewJob`,
`WebhookDelivery`, and `OutboxEvent` atomically. The delivery id is claimed with
insert-on-conflict inside that transaction, so a concurrent duplicate delivery
serializes on the unique id and loses without leaving any review/job/outbox
rows. Outbox publication to Redis is best-effort on the request path; recovery
owns retries.

The one exception is **issue triage**: `issues.opened` (for non-PR, non-bot
issues) calls the injected `ModelProvider` from `modules/triage` and posts the
rendered analysis as a GitHub comment. It is a short, best-effort inference
inside the server process; a provider or GitHub failure is logged and does not
fail the delivery. Review inference never runs in the server process.

### HTTP surface

| Route | Purpose |
|---|---|
| `POST /api/reviews` | Manual review ingestion (`repository`, `pullRequestNumber`, optional `headSha`, `reviewType`). |
| `GET /api/reviews/:id` | Review status. |
| `GET /healthz` | Liveness. |
| `GET /readyz` | Postgres/Redis readiness. |
| `GET /metrics` | Prometheus exposition. |
| `/api/admin/*` | OAuth, session, configuration, review list/detail/trigger/compare, audit. |
| `/admin`, `/logs` | Server-rendered admin panel; unauthenticated requests redirect to login. |
| `/` | Probot webhook middleware. |

## 6. Worker flow

`src/worker.ts` calls `bootstrapWorker()` in `src/bootstrap/worker.ts`:

1. Load env, logger, Postgres/Redis/queue clients, config store.
2. Build ingestion, review, workspace, knowledge, findings, and publishing
   services from their ports/repositories.
3. Fetch the skill playbook and engineering handbook **once per boot** into the
   knowledge cache (`ensureKnowledgeSources`). A failed source is marked
   unavailable; the worker still starts.
4. Start the BullMQ worker at `queue.concurrency` (default `1`).
5. Start background loops: outbox recovery (30 s), incomplete-review
   reconciliation (60 s), workspace sweep, metrics/alerts.
6. Register phase-ordered graceful shutdown.

A claimed job runs:

1. **Preflight** — load the durable job/review, reject terminal or stale work,
   claim the durable row, move the review forward through the state machine.
2. **Workspace** — shallow clone, checkout the exact head SHA, diff against the
   base, enumerate changed files, verify the PR head is still current.
3. **Knowledge** — for `skill`/`handbook` reviews, copy the review's persisted
   snapshot into its workspace and inject deterministic text under the token
   budget. Missing required knowledge fails the review; there is no fallback.
4. **Review engine** — reject an empty diff, score complexity, build a plan,
   run the staged analysis/investigation/reporting prompts through
   `AgentRuntime`, and normalize the structured JSON result.
5. **Findings** — re-check locations and evidence against the workspace,
   validate confidence/severity, fingerprint, persist, and update lifecycle
   status for prior commits.
6. **Publishing** — re-check the head SHA, then create one GitHub review with a
   summary plus eligible inline comments. Publication is idempotent by
   fingerprint markers and reconciliation with existing reviews.
7. **Completion** — persist metrics/token usage and move the review to a
   terminal state (`completed`, `completed_with_warnings`, `failed`, or
   `superseded`).

Review states: `queued`, `preparing`, `cloning`, `analyzing`, `investigating`,
`validating`, `publishing`, `completed`, `completed_with_warnings`, `failed`,
`cancelled`, `superseded`. Transitions are validated and persisted; a
superseded commit can never publish.

## 7. Queue reliability contract

The system is **at-least-once**; every boundary is idempotent and PostgreSQL is
the source of truth. The full contract is in
[queue-reliability.md](queue-reliability.md). Invariants:

- **Idempotency** — `WebhookDelivery.deliveryId`,
  `(pullRequestId, headSha, reviewMode, reviewType, attempt)`,
  `ReviewJob.id` as the BullMQ job id, `(reviewId, fingerprint)`, and GitHub
  fingerprint markers.
- **Transactional outbox** — ingestion commits the review, durable job, and
  outbox event together. The publisher marks the event `enqueued` before
  adding the BullMQ job; Redis outages leave the event pending and recovery
  republishes it.
- **One retry decision point** — `classifyQueueFailure`
  (`src/shared/retry.ts`) composes the `AppError` retryability classifier and
  the failure-class/backoff policy. BullMQ, the outbox, and the worker do not
  re-implement classification.
- **Worker contract** — a retryable failure throws `ReviewJobRetryError` and
  leaves the durable job claimable; a permanent or exhausted failure marks the
  durable job and review failed and throws `UnrecoverableError`.
- **Recovery** — startup reconciliation and the 60 s loop re-enqueue
  non-terminal `pending_outbox`/`enqueued`/`processing`/failed jobs, using the
  same durable job id. BullMQ stalled-job recovery and Postgres reconciliation
  cover worker crashes.
- **Shutdown** — stop intake → drain the worker → close queue/Redis/Postgres
  → flush logs, bounded by `SHUTDOWN_TIMEOUT_MS` (default 10 s). A job that
  exceeds the deadline is not acknowledged and is recovered.

## 8. Review types and knowledge sources

Three review methodologies run through the same adaptive engine:

| Type | Behavior |
|---|---|
| `standard` | Default engine and instructions. |
| `skill` | Injects a code-review playbook from the review's own knowledge snapshot (`knowledge.skill`). Missing playbook → `SKILL_PLAYBOOK_UNAVAILABLE`. |
| `handbook` | Application-side retrieval ranks cached handbook files against detected technologies and changed paths, then selects whole files under a token budget. Unconfigured → `HANDBOOK_UNCONFIGURED`; unavailable → `HANDBOOK_UNAVAILABLE`. |

Only types with `review.types.<type>.publish = true` post to GitHub. The
shipped config enables and publishes `standard` and `handbook`, and disables
`skill`. Types with `publish = false` persist findings and metrics for
comparison (`GET /api/admin/reviews/compare`) and record `publishSkipped`.

Automatic PR events pass no review type, so ingestion defaults them to
`standard`. The manual paths resolve differently: bare `/review` and
admin-triggered reviews use `github.defaultReviewType` (currently `handbook`),
while `POST /api/reviews` defaults an omitted type to `standard`.

Knowledge is fetched once per worker boot into
`<KNOWLEDGE_CACHE_DIR>/<source>/<sha>/` with a manifest and per-file hashes.
Each review materializes its own copy and persists
`Review.knowledgeSnapshot = { ref, contentHash, files[] }`; injection reads only
that copy. Recovery refuses to substitute a different snapshot
(`KNOWLEDGE_SNAPSHOT_UNAVAILABLE`). The agent has no knowledge tools: the
application performs all retrieval and injects text.

## 9. Agent runtime and model provider

- `AgentRuntime` is a port; adapters are resolved by the runtime registry from
  `agent.runtime.type`.
- `opencode-cli` (default) spawns one `opencode run` process per engine stage
  in the review workspace.
- `opencode-sdk` (opt-in) runs `@opencode/sdk` in a sanitized child Node
  process behind the same contract.
- There is no fallback between adapters and no automatic model switch. Startup
  or execution failures fail closed with a normalized `AgentRuntimeError`.
- The application, not the agent, enforces permissions, timeouts, workspace
  integrity, credential isolation, and read-only retrieval. See
  [agent-runtime-plugins.md](agent-runtime-plugins.md).

The model provider is an OpenAI-compatible adapter behind the `ModelProvider`
port. Endpoint, model id, temperature, and timeout come from
`config/review.json` + environment overrides; secrets stay in environment
variables.

## 10. Configuration

One global `config/review.json` is the behavioral source of truth. It is
validated against Zod contracts (`src/contracts/config.ts`) and loaded by
`src/platform/config/review-loader.ts`. The admin panel and API validate,
save, reload, roll back, and audit configuration versions; an invalid
configuration never replaces the last known-good version.

Environment configuration is read only through `src/platform/config/env.ts`.
The `/review` webhook and admin services receive a boot-time config store from
the composition root; this is deliberately a snapshot of static deployment
environment, and the shipped config resolves identically.

Repository overrides may only change allowlisted sections and can never weaken
application-level security policy.

## 11. Security model

- Repository content, diffs, PR text, and model output are untrusted input.
- The review agent gets a temporary workspace, read-only retrieval tools, and
  no GitHub token, app private key, shell, or outbound network.
- Git credentials are short-lived installation tokens held by the trusted
  workspace layer and never passed to the agent.
- Workspace integrity is verified after agent execution; any modification
  fails the review.
- Command execution is disabled by default (`static-analysis`); the
  `execution` module owns the allowlist, environment filtering, resource
  limits, and sandbox policy when enabled.
- Admin access requires GitHub OAuth, organization membership, a signed
  session, CSRF protection on unsafe methods, and rate limiting. Secrets are
  redacted from logs and never rendered in the panel.
- HTTP errors use the shared envelope `{ code, message, statusCode, details? }`;
  stack traces, SQL, paths, and identifiers never enter it.

## 12. Observability, health, and shutdown

- Structured Pino logs carry review/job ids, repository, PR, SHA, stage,
  duration, and a redacted failure classification.
- Prometheus metrics cover reviews, duration, queue depth, findings, provider
  latency/errors, tokens, workspace disk, and memory; `/metrics` is served by
  the platform adapter.
- OpenTelemetry traces follow webhook → job → worker → clone → agent → model →
  validation → publication.
- `/healthz` is liveness; `/readyz` reports Postgres and Redis independently.
- Alerts cover review failures, queue backlog, provider unavailability, and
  resource pressure.
- Shutdown is phase-ordered and bounded; see [queue-reliability.md](queue-reliability.md).

## 13. Deployment

One Docker Compose project on Dokploy:

```text
probot (HTTP + webhooks + admin)
worker (BullMQ consumer + agent runtime)
postgres
redis
migrate (one-shot, exits 0)
backup (optional profile)
```

`npm run start:probot` and `npm run start:worker` are the process commands in
both local development and the production image. Migrations are applied by the
one-shot `migrate` service and are append-only. PostgreSQL and Redis stay on the
internal network; only `probot` joins the ingress network. The full topology,
secrets, backup/restore evidence, and restart runbook are in
[deployment.md](deployment.md).

## 14. Approved deviations

The product stack intentionally differs from the handbook's web-product stack.
Each deviation has an ADR with context, decision, and consequences:

| Deviation | ADR |
|---|---|
| Probot instead of NestJS for the GitHub App | [0001](adr/0001-keep-probot.md) |
| Prisma instead of Drizzle | [0002](adr/0002-prisma-over-drizzle.md) |
| One npm package instead of pnpm/Turborepo | [0003](adr/0003-single-npm-package.md) |
| Contracts in `src/contracts` instead of a package | [0004](adr/0004-contracts-in-src.md) |
| Module-owned units of work for multi-repository writes | [0005](adr/0005-unit-of-work.md) |
| One `AppError` family + single failure classifier for HTTP/queue/outbox edges | [0006](adr/0006-failure-classification.md) |

## 15. Non-goals

- Multi-organization public SaaS onboarding.
- Horizontal scaling or more than one simultaneous review by default.
- Automatic PR approval or merge.
- Unrestricted shell or network access for the agent.
- Autonomous model switching or multi-agent orchestration.

These can be revisited after the system is measured in production.
