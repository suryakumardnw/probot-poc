# Production Deployment (Ticket 13)

This document describes the production deployment of the AI PR Reviewer via
Docker Compose, and how to run the same stack on [Dokploy](https://dokploy.com).
It covers architecture, prerequisites, secrets, first deployment, upgrades,
backup/restore (tested — evidence below), restart recovery, an optional
Dozzle log-viewer stack, and the validation runbook in §10.4 of this document.

Related: `docs/architecture.md` §13 (deployment), §12 (observability, health,
and shutdown), and §14 (approved deviations).

---

## 1. Stack topology

A single compose project (`deploy/docker-compose.yml`) defines six services
(`backup` is optional and off by default):

| Service   | Image                       | Role                                            | Ports (host) |
|-----------|-----------------------------|-------------------------------------------------|--------------|
| `probot`  | `ai-pr-reviewer/app:prod`   | Probot webhook app + admin API                  | `3000` (container, Traefik ingress) |
| `worker`  | `ai-pr-reviewer/app:prod`   | Review worker (polls Redis queue, runs opencode) | none |
| `migrate` | `ai-pr-reviewer/app:prod`   | One-shot `prisma migrate deploy`                | none (exits 0) |
| `postgres`| `postgres:17.6-alpine`      | Relational store                                | none |
| `redis`   | `redis:7.4-alpine`          | Queue + rate limits + AOF persistence           | none |
| `backup`  | `ai-pr-reviewer/backup:prod`| Optional daily `pg_dump -Fc` + retention + healthcheck (`backup` profile, off by default) | none |

Key properties (enforced by the compose file and asserted by
`test/deployment-compose.test.ts`):

- **Named volumes** (`postgres-data`, `redis-data`, `review-workspaces`,
  `pg-backups`) — never bind mounts. Postgres and Redis data survive
  container recreation and `compose down` (not `down -v`).
- **No host ports published at all.** Traefik (Dokploy) reaches `probot` on
  container port `3000` over the external `dokploy-network` — publishing a
  host port would claim `0.0.0.0:3000` and collide with Dokploy gateway
  endpoints. Local smoke runs use `deploy/docker-compose.local.yml`, which
  maps `127.0.0.1:3000` only.
- **Healthchecks** on postgres, redis, probot, worker, backup. `probot` and
  `worker` start only after `migrate` completes successfully and postgres and
  redis are healthy.
- **Resource limits** on every service (`deploy.resources.limits`).
- **Graceful shutdown**: PID 1 is `node` (SIGTERM reaches it); the worker
  drains in-flight reviews and reconciles incomplete reviews on restart
  (`test/integration/recovery.test.ts`).
- **No Docker socket mounted anywhere.** The worker talks to the sandbox
  daemon via `SANDBOX_DOCKER_HOST` (remote endpoint over TCP/SSH) — see §5.
- **Secrets** come from `deploy/.env` (gitignored) and
  `deploy/secrets/*` (gitignored); compose defines them via `env_file` and
  `secrets:` file entries.

## 2. Prerequisites

- Docker Engine ≥ 24 with Compose v2 (`docker compose version`).
- ~4 GB RAM minimum for the primary stack; **8 GB recommended** for the
  full deployment with Phoenix and Dozzle. The configured container ceilings
  total ~2.5 GiB (primary) and ~3.2 GiB (everything):

  | Service | Memory limit |
  |---|---|
  | `worker` | 1536M |
  | `probot` | 256M |
  | `postgres` | 384M |
  | `redis` | 256M |
  | `backup` | 128M |
  | `phoenix` (optional) | 512M |
  | `dozzle` + `dozzle-tunnel` (optional) | 128M + 64M |

  These are **ceilings, not reservations**. The workload is idle most of the
  time; memory rises while a PR review runs (worker + `opencode` + git) and
  should fall back afterwards. Measure actual peaks during a real review
  (`docker stats --no-stream`, or the worker's `worker_memory_usage_bytes`
  metric) and re-tune before treating these limits as final. The worker raises
  `worker_resource_exhaustion` above 1.125 GiB RSS — 75% of its limit;
  override with `ALERT_MEMORY_LIMIT_BYTES`.
  The OpenCode SDK runtime adds a child Node process per active SDK review on
  top of the worker. Keep `queue.concurrency` at `1` unless you have measured
  a higher value against the 1536M worker limit.
- ~10 GB disk for the stack plus workspace headroom.
- A GitHub App with the private key PEM file (tickets 01/02).
- A model-provider account (worker uses `MODEL_BASE_URL` / `MODEL_NAME`).
- On Dokploy: Dokploy ≥ v0.21 (creates the external `dokploy-network`).

### Runtime selection

`agent.runtime.type` in `config/review.json` selects a registered runtime
plugin:

| Type | Meaning |
|---|---|
| `opencode-cli` | Default. Spawns the `opencode` CLI (`opencode run --format json`). |
| `opencode-sdk` | Opt-in. Runs `@opencode/sdk` in a sanitized child Node process. |
| `opencode-server` | Reserved; no plugin is registered. |
| `custom` | Reserved; no plugin is registered. |

```json
{
  "agent": {
    "runtime": {
      "type": "opencode-sdk",
      "sessionStrategy": "per-review",
      "timeoutMs": 900000
    }
  }
}
```

Selection fails closed. A reserved or unknown type throws
`AgentRuntimeError("config", ...)` when the worker constructs the runtime; it
does not fall back to the CLI. Runtime failures (spawn, crash, timeout,
provider unavailability, invalid output, workspace modification) fail the
review, also without fallback. See
[`docs/agent-runtime-plugins.md`](agent-runtime-plugins.md).

The production image is `node:24.22.3-slim` in both Dockerfile stages because
the SDK runtime requires Node >= 24 (`engines.node` is `>=24`). The SDK is a
production dependency, `@opencode/sdk@2.3.0`, installed by
`npm ci --omit=dev`. `effect@4.1.0` is also pinned at the root because the SDK
packages peer-depend on Effect 4.1 while Prisma uses Effect 3.21; the root pin
keeps the SDK peer slot consistent. Verify both with:

```sh
docker compose exec worker npm ls @opencode/sdk effect --omit=dev
```

The CLI binary stays in the image because `opencode-cli` remains the default
and the rollback path.

## 3. Secrets and environment

1. Copy the template and fill in real values:

   ```sh
   cp deploy/.env.prod.example deploy/.env
   chmod 600 deploy/.env
   ```

2. GitHub App private key — set **one** of these in `deploy/.env`:
   - `GITHUB_PRIVATE_KEY_BASE64`: the PEM encoded as single-line base64
     (`base64 -i github-app.private-key.pem | tr -d '\n'`) — the
     deployment-friendly form for platform env tabs (Dokploy etc.);
   - `GITHUB_PRIVATE_KEY`: the raw PEM (multiline — quote it if your env
     file round-trips quoted values);
   - `GITHUB_PRIVATE_KEY_PATH`: path to a PEM file available in the
     container.
3. `deploy/.env` is used **both** for compose variable interpolation and as
   `env_file` for `probot`, `worker` and `migrate`. Never commit it.
4. Required variables are declared with `:?` in the compose file, so
   `docker compose config` fails fast when something is missing.

### Agent tracing (optional — Phoenix/OpenTelemetry)

Agent-level tracing (prompts, model generations, tool calls, retries, errors,
token usage) is delegated to the
[OpenCode OpenTelemetry plugin](https://github.com/DEVtheOPS/opencode-plugin-otel)
and exported to a self-hosted [Arize Phoenix](https://arize.com/docs/phoenix)
instance by default. The worker only:

1. enables the pinned plugin in the generated per-session
   `$XDG_CONFIG_HOME/opencode/opencode.json` when
   `observability.agentTracing.enabled` is `true` (config/review.json), and
2. forwards the plugin options and tracing credentials to the isolated
   OpenCode child process.

The configuration is deliberately plugin-shaped: swapping backends (for
example Langfuse) is a plugin/options change, not an application code change.

```json
"observability": {
  "agentTracing": {
    "enabled": true,
    "plugin": "@devtheops/opencode-plugin-otel@2.1.0",
    "options": {
      "endpoint": "${PHOENIX_ENDPOINT:-http://phoenix:6006}",
      "protocol": "http/protobuf",
      "logsEnabled": false,
      "metricsInterval": 86400000,
      "resourceAttributes": "service.name=ai-pr-reviewer"
    }
  }
}
```

`endpoint` is the Phoenix OTLP/HTTP base URL; the plugin appends `/v1/traces`.
Override it with `PHOENIX_ENDPOINT` (e.g. `http://localhost:6006` when the
worker runs outside Compose). Phoenix ingests traces only — `logsEnabled:
false` suppresses OTLP logs, and the checked-in config also lists every metric
suffix in `disabledMetrics` (plus a long `metricsInterval`) so Phoenix never
receives `/v1/metrics` or `/v1/logs` exports. `options` accepts scalars and
string lists only — never credentials.

> Migrating from the old `observability.langfuse` block? Rename it to
> `agentTracing`, point `plugin` at the OpenTelemetry package, and move
> endpoint/protocol settings into `options`. The old key is rejected at
> validation time so a stale config cannot silently disable tracing.

> OpenCode 2 resolves its global config from
> `$XDG_CONFIG_HOME/opencode/opencode.json`. A file at
> `$XDG_CONFIG_HOME/opencode.json` is ignored **without any error**, so the
> plugin (and the custom model provider) silently never load. Keep the extra
> `opencode/` directory level.

Set these in `deploy/.env` (or the Dokploy environment tab):

```sh
# Only needed when Phoenix authentication is enabled.
OPENCODE_OTLP_HEADERS=authorization=Bearer <phoenix-system-api-key>
# Optional OTel resource tags (never secrets):
# OPENCODE_RESOURCE_ATTRIBUTES=deployment.environment=production
```

Correlation: the worker passes secret-free trace attributes —
`review.id=<reviewId>`, `repository=<owner/name>` and `pr.number=<number>` —
as OTel `spanAttributes` plugin options (`tags` is still emitted for the
Langfuse plugin option shape). The same review id, PR and repository appear in
the worker's structured (Pino) logs, so a trace and its worker logs can be
matched directly. Correlation values are metadata only and never enter the
prompt or model request. Only credentials for the selected plugin are
forwarded; they are passed only via the child environment — never written to
`opencode.json`, and child processes receive nothing outside their allowlist.

> **Privacy:** the plugin can capture prompts, model responses, reasoning
> exposed by OpenCode, and tool inputs/outputs, which may include proprietary
> source code. Enable it first on a restricted repository, and agree on
> redaction, access control and retention **before** enabling it
> production-wide. Hidden chain-of-thought is not captured by this
> application, and secrets must never be placed in `config/review.json`.

The runtime passes `--print-logs` and promotes plugin/tracing lines to
`event_type: "tracing"` at info level, so `loading plugin`,
`telemetry disabled` and export failures are visible in the worker log.
Tracing export failures must never be treated as review failures, but a
misconfigured/absent plugin package should be caught in a staging review
before production rollout.

Tracing requires **OpenCode ≥ 2.2.6**: v2.2.5 silently ignores the configured
`plugins` in `opencode run` mode (no error, no traces). The `Dockerfile` pins
2.2.6 for this reason — do not downgrade it.

The plugin package is **pre-installed at image build time**
(`opencode plugin add` in the `Dockerfile`). This is required: `opencode run`
does not install a missing package plugin by itself, and every review uses an
isolated per-session `XDG_CONFIG_HOME`/`XDG_DATA_HOME`; only a long-running
OpenCode server installs missing plugins (in the background). The package is
cached under the worker user's `$HOME/.cache/opencode`. If you change the
pinned plugin version, rebuild the image so the cache matches.

#### Running Phoenix

Phoenix is an optional separate Compose project. The app compose owns the
shared `ai-pr-reviewer_observability` bridge network, so start the app stack
first (it creates the network), then the trace stack:

```sh
docker compose \
  -f deploy/docker-compose.yml \
  -f deploy/docker-compose.local.yml \
  up -d

cp deploy/observability/.env.example deploy/observability/.env
# edit secrets if PHOENIX_ENABLE_AUTH=true
docker compose -f deploy/observability/docker-compose.yml up -d
```

The Phoenix UI is served at `https://probot.nativewit.app/phoenix` through
Dokploy/Traefik and is published on `127.0.0.1:6006` only. For a direct
loopback smoke test without a path-stripping proxy, override the public path
(and set `PHOENIX_HOST_PORT` in `deploy/observability/.env` if the host port is
taken), then use an SSH tunnel. Trace retention defaults to 30 days
(`PHOENIX_RETENTION_DAYS`; `0` keeps traces forever).

```sh
PHOENIX_ROOT_URL=http://localhost:6006 PHOENIX_HOST_ROOT_PATH= \
  docker compose -f deploy/observability/docker-compose.yml up -d

ssh -L 6006:127.0.0.1:6006 user@your-server
# then open http://localhost:6006
```

For the Dokploy/Traefik domain, use the optional edge override and configure
the domain for the `phoenix` service as Host `probot.nativewit.app`, Path
`/phoenix`, **Strip Path enabled**, Container Port `6006`. Enable Phoenix auth
first:

```sh
docker compose \
  -f deploy/observability/docker-compose.yml \
  -f deploy/observability/docker-compose.dokploy.yml \
  up -d
```

> **Do not expose Phoenix without auth.** Traces may contain source code.
> Set `PHOENIX_ENABLE_AUTH=true`, `PHOENIX_SECRET` and
> `PHOENIX_DEFAULT_ADMIN_INITIAL_PASSWORD` in `deploy/observability/.env`,
> then create a system API key in Phoenix and put it in
> `OPENCODE_OTLP_HEADERS` in `deploy/.env` for the worker.

Troubleshooting a missing trace:

1. Confirm the tracing env vars are in the **worker container** (not only in
   your shell): `docker compose exec worker env | grep -c '^OPENCODE_'`
   (`OPENCODE_OTLP_HEADERS` is expected only when auth is enabled).
2. Confirm the plugin cache exists in the container (do **not** rely on
   `opencode plugin list`, which queries a server and may print
   "No plugins found" even when the cache is present):
   ```sh
   docker compose exec worker sh -lc 'ls ~/.cache/opencode/npm/@devtheops'
   ```
   Expect `opencode-plugin-otel@2.1.0`.
3. Confirm the worker log shows `agentTracing` with the pinned package and an
   `agentTracingStatus` endpoint/protocol in `agent_session_created`.
4. Confirm the plugin actually loaded: the worker log should contain an
   `agent tracing output` line with `loading plugin id=@devtheops/...`. If
   neither line appears, verify the generated config is at
   `.../config/opencode/opencode.json` (see above).
5. Confirm Phoenix is healthy and reachable from the worker:
   ```sh
   docker compose -f deploy/observability/docker-compose.yml exec phoenix \
     python3 -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:6006/healthz').status)"
   docker compose exec worker node -e "fetch('http://phoenix:6006/healthz').then(r=>console.log(r.status)).catch(console.error)"
   ```

## 4. First deployment

```sh
# Validate configuration (requires deploy/.env + the key file)
docker compose -f deploy/docker-compose.yml config -q

# Build
docker compose -f deploy/docker-compose.yml build

# Start (migrate runs first as a one-shot; probot/worker wait for it).
# The local override maps 127.0.0.1:3000 -> probot:3000 (the production
# compose publishes no host ports; Dokploy Traefik handles ingress).
docker compose \
  -f deploy/docker-compose.yml \
  -f deploy/docker-compose.local.yml \
  up -d

# Verify
docker compose \
  -f deploy/docker-compose.yml \
  -f deploy/docker-compose.local.yml \
  ps                                       # all healthy, migrate Exited(0)
curl -fsS http://localhost:3000/healthz    # 200
```

Notes from the validated smoke run (2026-11-06, local Docker):

- `migrate` runs `npx prisma migrate deploy` and exits 0 in ~20 s; the app
  containers are gated on `service_completed_successfully`.
- `worker` requires `METRICS_PORT=9100` (set in compose) — its healthcheck
  fetches `http://127.0.0.1:9100/metrics`.
- Without GitHub App credentials `probot` still starts healthy but logs a
  warning and does not process webhooks (`APP_ID / PRIVATE_KEY not
  configured`). Admin API returns 503 until OAuth variables are set.
- The compose file references the external network `dokploy-network`
  (override name with `DOKPLOY_NETWORK`). Locally create it once:
  `docker network create dokploy-network`. On Dokploy it already exists.

## 5. Sandbox isolation model

> **Current runtime:** the CLI and SDK adapters do not run agent work in
> per-review containers. Both use logical/child-process isolation: a sanitized
> environment, deny-by-default permissions, workspace integrity checks and
> per-session directories (see
> [`docs/agent-runtime-plugins.md`](agent-runtime-plugins.md) §5). The
> per-review sandbox containers described below are the planned ticket-11
> kernel-sandbox model and are future work.

- The review worker creates per-review sandbox containers that run the
  `opencode` CLI against untrusted PR diffs. They are **not** spawned via a
  mounted Docker socket — no socket mount exists anywhere in the compose
  file (asserted by tests).
- `SANDBOX_DOCKER_HOST` points the worker at a remote/sidecar Docker
  endpoint (e.g. a socket-proxy or a dedicated daemon). On Dokploy, point it
  at a locked-down docker socket proxy container or the host API endpoint
  over TLS.
- `sandbox-egress` is an internal-only compose network. If you add an
  egress-proxy sidecar, attach the sandbox containers to it so they can only
  reach approved destinations (git remotes, the model API).

## 6. Upgrades and rollbacks

```sh
git pull
docker compose -f deploy/docker-compose.yml build
docker compose -f deploy/docker-compose.yml up -d          # re-runs migrate if needed
docker compose -f deploy/docker-compose.yml logs -f worker # watch reconciliation
```

Rollback: redeploy the previous image tag / commit. Migrations are append
only (`prisma migrate deploy` never down-migrates); take a fresh backup
before upgrading (§7) so a bad release can be restored.

If you are upgrading an existing deployment that already ran the optional
services, stop them explicitly — adding a Compose profile does not stop a
container that is already running:

```sh
docker compose -f deploy/docker-compose.yml stop backup
docker compose -f deploy/docker-compose.dozzle.yml stop dozzle-tunnel
```

PostgreSQL data stays in the `postgres-data` volume; stopping `backup` never
touches it.

## 7. Backup and restore — TESTED

### 7.1 How it works

> **Disabled by default in the lean deployment.** The `backup` service is in
> the `backup` Compose profile, so a normal `docker compose up -d` does not
> start it. PostgreSQL data always lives in the `postgres-data` named volume;
> stopping the backup container never affects it. Enable scheduled backups
> with `docker compose -f deploy/docker-compose.yml --profile backup up -d backup`.
> Before production, take at least one manual dump:
>
> ```sh
> docker compose -f deploy/docker-compose.yml --profile backup run --rm \
>   --entrypoint sh backup -c \
>   'pg_dump --no-owner --no-privileges -Fc \
>      -f /backups/reviewer-manual-$(date -u +%Y%m%d-%H%M%S).dump'
> ```

- `backup` runs an interval loop (`BACKUP_INTERVAL_HOURS`, default 24) and
  writes `pg_dump -Fc` archives named `reviewer-YYYYmmdd-HHMMSS.dump` to the
  `pg-backups` volume, plus a `.last-backup` epoch stamp.
- Retention: archives older than `BACKUP_RETENTION_DAYS` (default 14) are
  pruned by filename timestamp.
- Healthcheck (`backup-health.sh`): fails when the newest backup is older
  than `BACKUP_MAX_AGE_HOURS` (default 26) — surfaces stale backups in
  `docker compose ps`.
- The image is built from `postgres:17.6-alpine` so `pg_dump`/`pg_restore`
  always match the server major version. Bump both together.

### 7.2 Restore procedures

**Offline (rebuild the data directory — the recovery path for a lost
cluster):**

```sh
docker compose -f deploy/docker-compose.yml stop postgres
docker run --rm --entrypoint /usr/local/bin/restore.sh \
  -v ai-pr-reviewer_pg-backups:/backups:ro \
  -v ai-pr-reviewer_postgres-data:/target \
  ai-pr-reviewer/backup:prod
docker compose -f deploy/docker-compose.yml start postgres
```

(The image ENTRYPOINT is `backup.sh`, so restore always needs
`--entrypoint /usr/local/bin/restore.sh`.)

**Online (restore into the running server, e.g. bad-data rollback):**

```sh
set -a; . deploy/.env; set +a
docker run --rm --entrypoint /usr/local/bin/restore.sh \
  --network ai-pr-reviewer_internal \
  -v ai-pr-reviewer_pg-backups:/backups:ro \
  -e PGHOST=postgres -e PGDATABASE=reviewer -e PGUSER=reviewer \
  -e PGPASSWORD="$POSTGRES_PASSWORD" \
  ai-pr-reviewer/backup:prod --online
```

### 7.3 Test evidence (2026-11-06, throwaway containers)

- **Online restore**: dump `reviewer-20261106-063738.dump` restored with
  `restore.sh --online` into a scratch `postgres:17.6-alpine` container;
  marker row inserted pre-backup read back intact after restore
  (`SELECT * FROM smoke_marker` → `ticket13-restore-evidence`).
- **Offline restore**: `restore.sh` (offline mode) rebuilt a scratch target
  volume from the same archive; booting `postgres:17.6-alpine` on that
  volume showed all 8 `_prisma_migrations` rows and the full schema
  (`audit_logs`, `finding_status_transitions`, …) — identical to the live
  database (8/8 migrations).
- **Scheduled backup**: the compose `backup` service produced
  `reviewer-20261106-063324.dump` (46 KB) on start and flipped healthy.

### 7.4 Off-host replication (operational requirement)

The `pg-backups` volume protects against container/data-directory loss but
is **not** a backup against host loss. Copy archives off-host (e.g. nightly
`rclone`/`aws s3 cp` of the volume, or Dokploy volume backup feature).

## 8. Restart recovery — verified

- `docker compose restart` (full stack): postgres, redis, probot, worker all
  returned healthy; data intact (8/8 migrations after restart).
- Redis restart alone: worker reconnected (`postgres ok, redis ok — Review
  worker ready`); AOF persistence (`redis-data` volume) preserves queued
  work.
- Worker crash recovery is covered by unit/integration tests
  (`test/integration/recovery.test.ts`): on startup the worker reconciles incomplete
  reviews (marks orphaned reviews failed and re-enqueues where appropriate),
  so a killed worker never loses review state.

## 9. Deployment on Dokploy

1. **Create the project** in Dokploy and add a *Compose* service pointing at
   this repository (or paste `deploy/docker-compose.yml`). Dokploy creates
   the external `dokploy-network` — the compose file attaches `probot` to it
   for ingress.
2. **Environment**: paste the contents of `deploy/.env` into the service's
   environment settings. Supply the GitHub App private key inline as
   `GITHUB_PRIVATE_KEY_BASE64` (single-line base64 of the PEM —
   `base64 -i github-app.private-key.pem | tr -d '\n'`) — this avoids file
   mounts entirely, which is required on Dokploy since redeploys re-clone the
   repo and any PEM placed in the checkout would be wiped.
3. **Domain / HTTPS**: in the Dokploy UI, attach a domain to the `probot`
   service on **Container Port `3000`**; Dokploy's Traefik terminates TLS,
   adds Traefik labels at deploy time, and routes traffic to the container
   over `dokploy-network` — no host port is published (which avoids host
   port collisions with Dokploy gateway endpoints). Use **Preview Compose**
   to verify the injected labels. Webhook URL is
   `https://<your-domain>/api/github/webhooks`.
4. **Deploy**, then follow §4 verification. Do not expose postgres/redis —
   they have no published ports and remain on the internal network.
5. **Backups**: disabled by default in the lean deployment. Take a manual
   dump before production (§7.1) and enable the `backup` profile when you want
   the daily schedule; replicate the `pg-backups` volume off-host (§7.4).

## 10. Dozzle — live container log viewer (operations stack)

[Dozzle](https://dozzle.dev) gives a real-time web UI over `docker logs` for
every container on the host. It is **deliberately a separate Compose project**
(`deploy/docker-compose.dozzle.yml`, project name `ai-pr-reviewer-logs`) — an
operations tool, not an application dependency:

- The app stack's §10.4 invariant "never mount the Docker socket in the app
  stack" and its no-published-ports rule stay untouched; the socket mount
  lives only in the Dozzle project. `test/deployment-compose.test.ts` enforces
  the app-stack invariants; `test/deployment-dozzle.test.ts` pins this file's
  structure (base path, auth, profiles and networks).
- **Same daemon requirement**: Dozzle sees the containers of the host whose
  socket it reads. Deploy it on the Dokploy host itself (a second *Compose*
  service in the same Dokploy project) — not in another container, VM or
  server.

### 10.1 Deploy on Dokploy

Add a **second Compose service** in the same Dokploy project and point it at
exactly this file (do **not** include the local override):

| Setting | Value |
|---|---|
| Compose file | `deploy/docker-compose.dozzle.yml` |
| Service | `dozzle` |
| Host | your existing Probot domain (e.g. `probot.nativewit.app`) |
| Path | `/dozzle` |
| **Strip Path** | **OFF** — Dozzle needs the prefix (`DOZZLE_BASE=/dozzle`) |
| Container Port | `8080` |
| Environment | `DOZZLE_ADMIN_PASSWORD` (required) |

This is the same ingress pattern as Phoenix at `/phoenix`, with one
difference: Phoenix uses **Strip Path ON**, Dozzle uses **Strip Path OFF**.
Dozzle rewrites its assets to `/dozzle/*` and expects to receive that prefix.

The file declares the project name `ai-pr-reviewer-logs`, joins the external
`dokploy-network`, and publishes no host ports. It contains three services:

- `dozzle-init` — a one-shot that generates `/data/users.yml` (bcrypt) from
  environment variables into the `dozzle-data` volume and exits.
- `dozzle` — starts only after the init succeeds; the UI is served at
  `https://<probot-domain>/dozzle/`.
- `dozzle-tunnel` — an optional outbound Cloudflare quick tunnel for hosts
  that cannot accept inbound connections (see §10.2). It is behind the
  `tunnel` profile, so a normal deploy never opens a public tunnel.

**No host-side file creation or shell access is needed** — everything is
driven from Compose environment variables, so it works from the Dokploy UI.

1. **Set environment variables** on the Compose service:

   | Variable | Required | Meaning |
   |---|---|---|
   | `DOZZLE_ADMIN_PASSWORD` | yes | password for the `admin` login |
   | `DOZZLE_ADMIN_EMAIL` | no | default `admin@localhost` (avatar only) |
   | `DOZZLE_ADMIN_NAME` | no | default `Admin` |
   | `DOZZLE_FORCE_USERS` | no | `1` = regenerate `users.yml` on next deploy |

   Dozzle v11 uses the `simple` auth provider reading `/data/users.yml`; the
   old `DOZZLE_USER_*` env vars no longer exist. Without a users file, login
   fails closed: there is no anonymous access.

2. **Deploy**: create the service pointing at
   `deploy/docker-compose.dozzle.yml` and add the `/dozzle` path to the same
   host that already routes to `probot` (§10.2). The init container runs first
   and writes the credentials into the `dozzle-data` named volume (which
   survives redeploys).
3. **Log in**: browse to `https://<probot-domain>/dozzle/` (local:
   `http://127.0.0.1:8080/dozzle/`). Dozzle redirects to its login page;
   sign in with username **`admin`** and the password from
   `DOZZLE_ADMIN_PASSWORD`. The admin panel also links here as
   **Container logs** (`/logs`, authenticated by Probot, then redirects to
   `/dozzle/`).
4. **Verify**: after logging in, confirm the `ai-pr-reviewer-*` containers
   appear in the list.

`users.yml` stores only bcrypt hashes. Changing `DOZZLE_ADMIN_PASSWORD` alone
does **not** update an existing file (the init leaves an existing
`users.yml` untouched). To rotate the password, set
`DOZZLE_FORCE_USERS=1`, redeploy, then unset it again.

Local smoke run without Dokploy/Traefik (localhost-only binding, Compose
creates a local network):

```sh
DOZZLE_ADMIN_PASSWORD='change-me' \
docker compose \
  -f deploy/docker-compose.dozzle.yml \
  -f deploy/docker-compose.dozzle.local.yml \
  up -d   # http://127.0.0.1:8080/dozzle/
```

### 10.2 Path router on the existing domain

Dozzle reuses the hostname that already serves Probot — no separate DNS name
or certificate is needed. In the Dozzle Compose service → **Domains**, add a
path entry:

- **Host**: the same hostname as Probot (e.g. `probot.nativewit.app`)
- **Path**: `/dozzle`
- **Strip Path**: **OFF** (Dozzle serves under `DOZZLE_BASE=/dozzle`)
- **Container Port**: `8080`
- **HTTPS**: enabled (the existing Let's Encrypt certificate is reused)

Traefik chooses the longest matching path, so `/dozzle/*` goes to Dozzle and
every other path continues to Probot. Do **not** add Traefik labels manually —
Dokploy injects them at deploy time. The Dozzle stack publishes no host port.

Verify from anywhere:

```sh
curl -I https://<probot-domain>/dozzle/   # 200 or 302 to /dozzle/login
curl -I https://<probot-domain>/          # still the Probot webhook app
```

`/dozzle` (no trailing slash) redirects to `/dozzle/`. If assets 404, the
path router is stripping the prefix — turn Strip Path **off**.

#### Behind CGNAT (no public IPv4 on the router)

Many ISPs put the router behind carrier-grade NAT: the router's WAN address is
private (e.g. `10.x.x.x` / `100.64.x.x`), while the internet sees a shared
public IP. Port forwarding cannot cross that second NAT, so no domain —
`sslip.io` or custom — can reach the stack. Confirm it by checking the router's
WAN IP in its admin UI and comparing it with `curl https://api.ipify.org`; if
they differ, you are behind CGNAT.

Use the bundled outbound tunnel instead (opt-in via the `tunnel` profile).
`dozzle-tunnel` dials Cloudflare (TCP/UDP 7844 outbound), so it needs no port
forwarding. The tunnel is **not** started by a normal deploy:

```sh
docker compose -f deploy/docker-compose.dozzle.yml --profile tunnel up -d
docker logs ai-pr-reviewer-logs-dozzle-tunnel-1 2>&1 | grep -i trycloudflare
# https://<random-words>.trycloudflare.com
```

With `DOZZLE_BASE=/dozzle`, open
`https://<random-words>.trycloudflare.com/dozzle/` and log in with `admin` /
`DOZZLE_ADMIN_PASSWORD`. The hostname is random and changes whenever the
tunnel container is recreated; it is meant for demos/operations, not a stable
production endpoint. Leave the `tunnel` profile disabled when you have a
public IP. Alternatively ask the ISP for a public/static IPv4, or use a named
Cloudflare tunnel with a domain you own for a stable hostname.

Local smoke run without Dokploy/Traefik (localhost-only binding, Compose
creates a local network):

```sh
docker compose \
  -f deploy/docker-compose.dozzle.yml \
  -f deploy/docker-compose.dozzle.local.yml \
  up -d   # http://127.0.0.1:8080/dozzle/
```

### 10.3 Security posture and caveats

- **The Docker socket is root-equivalent on the host.** A read-only mount
  (`:ro`) restricts the file on disk, **not** the Docker API — the container
  can still exec into other containers, read their filesystems via mounts,
  etc. Treat Dozzle as privileged infrastructure.
- Mitigations in place: authentication required, `DOZZLE_ENABLE_ACTIONS`
  / `DOZZLE_ENABLE_SHELL` / `DOZZLE_ENABLE_MCP` all disabled, pinned image
  (`v11.4.1`), resource limits, socket mounted read-only.
- **The Probot admin login does not protect `/dozzle` directly.** The
  `/dozzle` path is routed by Traefik to the Dozzle container, not through
  Probot. Dozzle's own `users.yml` login is the gate there. `/logs` is a
  Probot-authenticated shortcut that redirects signed-in admins to `/dozzle/`;
  it is a convenience, not the security boundary. Keep both the admin OAuth
  settings and `DOZZLE_ADMIN_PASSWORD` configured.
- **Restrict `/dozzle` to admin IPs or a VPN** (firewall rule, Dokploy
  Traefik IP-allow middleware, or your edge firewall) where practical —
  auth alone should not be the only gate.
- If you want to hard-limit the API itself, front the socket with a
  read-only proxy ([tecnativa/docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy))
  and point Dozzle at `DOCKER_HOST=tcp://socket-proxy:2375` instead of
  mounting the socket directly.

### 10.4 Troubleshooting

- **`No users.yaml or users.yml file found.`** — `dozzle-init` did not create
  the file, usually because `DOZZLE_ADMIN_PASSWORD` was not set on the
  service (the init exits with `DOZZLE_ADMIN_PASSWORD must be set`). Check:

  ```sh
  docker logs ai-pr-reviewer-logs-dozzle-init-1
  docker volume inspect ai-pr-reviewer-logs_dozzle-data
  ```

  Then set the variable on the Dokploy Compose service and redeploy.
- **Login rejected after changing `DOZZLE_ADMIN_PASSWORD`** — the init leaves
  an existing `users.yml` untouched. Set `DOZZLE_FORCE_USERS=1`, redeploy,
  then unset it.
- **Blank page or assets 404 under `/dozzle/`** — the Dokploy path entry has
  **Strip Path ON**. Dozzle needs the prefix (`DOZZLE_BASE=/dozzle`); set
  Strip Path **off** and redeploy.
- **`/dozzle/` returns the Probot app or a 404 instead of Dozzle** — the path
  router is missing or attached to the wrong service. Confirm the Dozzle
  Compose service has a Domains entry with Path `/dozzle`, Container Port
  `8080`, and that `dozzle` is attached to `dokploy-network`.
- **`read /data/users.yml: is a directory`** — this came from bind-mounting a
  single file that did not exist. The stack now uses the `dozzle-data` named
  volume instead; if you customised the mounts, mount a directory (or the
  named volume), never a single `users.yml` path.

Credentials are generated into the named volume, so they persist across
redeploys and are never committed to git.

## 11. Validation runbook

Scenarios from architecture §10.4, with local verification status:

1. **Clean deploy** — verified: `up -d` from scratch; migrate Exited(0);
   all services healthy; no host ports published (local override adds
   127.0.0.1:3000).
2. **GitHub App install + real PR review** — *user-environment step*: needs
   real app credentials and a live webhook URL (Dokploy). Locally probot
   starts degraded (no webhooks) by design; see probot warning log.
3. **Container restart** — verified: `compose restart` → all healthy, data
   intact.
4. **Backup + restore** — verified (§7.3): online and offline restore both
   exercised on throwaway containers.
5. **Redis restart** — verified: worker reconnects; queue persisted (AOF).
6. **Provider outage** — worker retries with backoff and marks reviews
   failed after max attempts (unit tests); alerts surface via metrics
   (`worker_failures_total`). *Live outage drill is user-environment.*
7. **Worker failure** — verified: worker container exits non-zero on config
   error and Docker restarts it (`unless-stopped`); restart reconciliation
   covered by `test/integration/recovery.test.ts`.
8. **Config rollback** — `config/review.json` is baked into the image;
   validate with the schema (`config/schemas`) before deploy; rollback =
   redeploy previous image. *Rollback drill is user-environment.*
9. **Dozzle smoke (local override)** — verified: container `healthy`,
   `/healthcheck` returns 200, unauthenticated `/` redirects to `/login`,
   login with generated credentials returns 200 (wrong password 401), and
   `down` leaves no containers or networks behind. *The env-driven
   `dozzle-init` credential flow and Dokploy/Traefik ingress are
   user-environment steps (§10).*
