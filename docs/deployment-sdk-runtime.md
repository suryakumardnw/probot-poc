# Experimental SDK worker deployment (Phase 1 boundary + Phase 2b model egress)

> **Experimental / non-production.** This deployment unit exists to verify a
> container boundary and a single allowlisted model-egress path for the OpenCode
> SDK runtime experiment. It is not wired into the production stack, does not
> consume review jobs, and does not publish anything. The Phase 2b adapter does
> not yet consume the proxy inside the container. Production rollout is not
> authorized.
>
> Architecture decision record: [`docs/architecture-sdk-runtime.md`](architecture-sdk-runtime.md)
> (§7 security, §12 Phase 1, §14 merge rules). Do not edit the ADR from this
> deployment work.

## Why Node 24 only here

`@opencode/sdk@2.2.7` depends on `@opencode/util`, which uses `await using`
syntax. Node 20.18.1 and the current production image runtime (Node 22.14.0,
root `Dockerfile`) cannot parse it — the import fails before any SDK code runs.

Phase 1 therefore uses `node:24.0.0-slim` **only** in the dedicated SDK worker
image (`deploy/sdk/Dockerfile`). The production CLI image and the production
Compose stack are unchanged. This keeps the compatibility requirement inside a
new, isolated deployment unit.

## What this unit is

A separate Compose project, `ai-pr-reviewer-sdk`, with four services:

| Service | Purpose |
| --- | --- |
| `sdk-worker` | Long-running **offline placeholder shell**: creates an OpenCode SDK host with inline config, writes a heartbeat, serves an internal-only health endpoint, closes the host gracefully. Receives the model credential file but makes **no** model call in Phase 2b. |
| `sdk-egress-proxy` | The only service with external connectivity. A deny-by-default HTTP `CONNECT` allowlist proxy for `$MODEL_ALLOWED_HOST:443`. No TLS interception, no credentials. |
| `sdk-isolation-probe` | One-shot adversarial check of the Phase 1 container boundary under the **same** hardening anchor. `probe` profile. |
| `sdk-egress-probe` | One-shot check that the proxy allow/deny path works and that direct egress stays blocked. `probe` profile. |

The image (`deploy/sdk/Dockerfile`, build context `deploy/sdk`) contains only
Node, the pinned SDK/undici dependencies and the worker scripts. It has no
`opencode` CLI, no git, no Docker CLI, no Prisma, no `.env` and no secrets. The
proxy image (`deploy/sdk/proxy/Dockerfile`) contains only Node and two `.mjs`
files; it has no dependencies and no credentials.

Phase 1 made **no model calls** and required **no model credentials**. Phase 2b
adds the egress path and credential file but still makes no model call.

## Validate, build, run, probe, tear down

Run from the repository root.

```bash
# 1. Generate/refresh the lockfile in the small build context
#    (added in this phase; the orchestrator commits it)
cd deploy/sdk
npm install --package-lock-only --ignore-scripts
npm ci --omit=dev --dry-run      # must exit 0
cd ../..

# 2. Static deployment tests + Compose validation
npx vitest run test/deployment-sdk.test.ts
docker compose -f deploy/docker-compose.sdk.yml config
docker compose --profile probe -f deploy/docker-compose.sdk.yml config

# 3. Build the image
docker compose -f deploy/docker-compose.sdk.yml build

# 4. Start the worker and wait for health
docker compose -f deploy/docker-compose.sdk.yml up -d sdk-worker
docker inspect --format '{{.State.Health.Status}}' \
  "$(docker compose -f deploy/docker-compose.sdk.yml ps -q sdk-worker)"

# 5. Run the one-shot isolation probe (waits for service_healthy)
docker compose -f deploy/docker-compose.sdk.yml run --rm sdk-isolation-probe

# 6. Inspect the running boundary
docker inspect --format \
  'user={{.Config.User}} ro={{.HostConfig.ReadonlyRootfs}} capdrop={{json .HostConfig.CapDrop}} sec={{json .HostConfig.SecurityOpt}} ports={{json .HostConfig.PortBindings}} mem={{.HostConfig.Memory}} nanoCpus={{.HostConfig.NanoCpus}} pids={{.HostConfig.PidsLimit}}' \
  "$(docker compose -f deploy/docker-compose.sdk.yml ps -q sdk-worker)"

# 7. Tear down everything, including named volumes.
# --profile probe is required so the probe-only volume is removed too.
docker compose --profile probe -f deploy/docker-compose.sdk.yml down -v --remove-orphans
```

`docker compose ... config` is the interpolation/normalisation check. The probe
prints a JSON report to stdout and a one-line summary to stderr; it exits `0`
only when every check passes.

## Security invariants (verified for this Phase 1 configuration)

Both services share `x-sdk-hardening`:

- `read_only: true`. The precise invariant is: **no writable mount outside
  `/tmp`, `/app/workspaces`, and standard `/proc`/`/sys`/`/dev` interfaces.**
  `/tmp` is a tmpfs (`noexec,nosuid,nodev`); `/app/workspaces` is a named
  volume. `/dev/shm`, `/dev/pts`, `/dev/mqueue` and similar `/dev/*` mounts are
  read-write by Docker default and are standard container interfaces, not
  application storage; they are deliberately not made read-only (Node and the
  container runtime need them).
- `cap_drop: [ALL]`, no `cap_add`, `no-new-privileges:true`, `user: "1000:1000"`.
- Provisional resource guardrails: `cpus: "1.0"`, `memory: 1G`,
  `pids: 256`, `stop_grace_period: 30s`. These are experiment limits, not
  production thresholds.
- One network, `sdk-internal`, with `internal: true`. No host ports anywhere.
  The worker binds `0.0.0.0:8081` **inside the container** and only `expose`s
  that port to containers on `sdk-internal`; it is **not** loopback-only and it
  is **not** published on the host.
- No `env_file`, no Docker socket, no bind mounts, no production coupling.

Compose v5 rejects a top-level `pids_limit` alongside a `deploy.resources.limits`
block (both map to `deploy.resources.limits.pids`), so the PID cap lives in the
`deploy` block. It is applied identically to worker and probe.

### What each probe check proves

| Check | Proves |
| --- | --- |
| `uid-non-root` | Process runs as uid 1000, not root. |
| `rootfs-read-only` | A write to `/` fails (`EROFS`); the image cannot be mutated at runtime. |
| `app-read-only` | A write to `/app` fails; image code is not writable. |
| `workspaces-writable` | The dedicated workspace volume is the intended writable surface (create/read/delete). |
| `tmp-writable` | The tmpfs is usable for transient SDK state. |
| `no-docker-socket` | Neither `/var/run/docker.sock` nor `/run/docker.sock` exists. |
| `no-forbidden-credentials` | No credential-like env keys and no PEM-looking values. The scan covers at least `GITHUB*`, `GH_TOKEN`, `APP_ID`, `WEBHOOK_SECRET`, `PRIVATE_KEY`, `DATABASE_URL`, `POSTGRES*`, `REDIS*`, `AWS_*`, `OPENAI_API_KEY`, `MODEL_API_KEY`, `GLM_API_KEY`, `ZHIPU_API_KEY`, `ANTHROPIC*`, and any key containing `API_KEY` (case-insensitive). This is a guardrail, not an exhaustive credential scanner. Only key **names** would be reported, never values. |
| `capabilities-dropped` | `/proc/self/status` `CapEff` is `0000000000000000`. |
| `no-new-privileges` | `/proc/self/status` `NoNewPrivs` is `1`. |
| `public-egress-blocked` | Public HTTP, raw TCP to `1.1.1.1:443`, and external DNS via `1.1.1.1` all fail/time out. |
| `internal-service-reachable` | `http://sdk-worker:8081/health` returns `ok` while public egress is blocked — internal-only networking works as intended. |
| `writable-mount-surface` | Parsed `/proc/self/mounts` has **no writable mount outside `/tmp`, `/app/workspaces`, and standard `/proc`/`/sys`/`/dev` interfaces** (plus Docker's hosts/hostname/resolv.conf files). `/dev/shm` and the other `/dev/*` mounts are expected rw defaults. |

This is **verified for this Phase 1 configuration**, not a claim that the unit
is universally "secure". Every change to the image, compose file or runtime
requires re-running the probe.

**Phase 1 scope is the container boundary only.** The full ADR §7 model-level
adversarial suite — source/README prompt injection, malicious symlinks,
cross-review workspace access, concurrent session interference, unauthorized
writes/modifications/deletions, and the `git status --porcelain` integrity
guard — is Phase 2 work, once a runtime adapter and model path exist.

### Known informational findings

- `npm ci` reports `31 vulnerabilities (25 moderate, 6 high)` in the transitive
  SDK dependency tree. Recorded, not resolved: root dependencies are out of
  scope for this experiment and the SDK version is pinned.
- `@opentui/core@0.8.1` declares `node >=26.4.0` and produces an `EBADENGINE`
  warning under Node 24.0.0. It is optional UI code; the Phase 0 spike imported
  the same locked version successfully on Node 24 and the worker starts healthy.
  Recorded, not patched, for the same dependency-scope reason.

## Phase 2 model egress (Phase 2b)

Phase 2b keeps the Phase 1 boundary and adds exactly one external path: model
calls may leave the stack **only** through `sdk-egress-proxy`.

```text
sdk-worker (sdk-internal only) ──CONNECT host:443──▶ sdk-egress-proxy
  no direct egress                                  │ sdk-internal + sdk-egress
                                                     ▼
                                        llm.nativewit.app:443 (allowlisted)
```

### Network and allowlist model

- `sdk-internal` is `internal: true`. The worker and both probes are attached to
  it and have **no** direct public connectivity (no HTTP, raw TCP or external
  DNS). This is still asserted by `sdk-isolation-probe`.
- `sdk-egress` is a normal bridge network and **only** `sdk-egress-proxy` is
  attached to it. Both networks carry no published host ports.
- The proxy speaks HTTP `CONNECT` on `3128`. It allows exactly
  `${MODEL_ALLOWED_HOST}:443` (default `llm.nativewit.app`) and rejects every
  other host/port with `403`. It is deny-by-default and compares the host
  exactly, so `evil.llm.nativewit.app` is not allowed.
- **No TLS interception.** After `200 Connection Established` the proxy pipes raw
  bytes in both directions. It never inspects, terminates or logs payloads,
  headers or URLs; its logs contain only `{action, host, port}`.
- Upstream DNS/TCP establishment and the client handshake are time-bounded, and
  the proxy has no auth or open relay because it is reachable only from the
  internal-only network.
- `GET /health` on `3129` returns `{status:"ok", allowedHost}`. No secrets.
- The proxy is **not** a general-purpose network client: it has no route or
  allowlist entry for GitHub, npm, databases or arbitrary hosts, and the worker
  cannot use it as one.

### Why an injected fetch, not proxy env vars

Node 24's built-in `fetch` does **not** honour `HTTPS_PROXY`/`HTTP_PROXY`
(verified). The SDK host accepts an injectable `fetch` (`OpenCode.create({ fetch })`)
and the runtime adapter exposes `fetchImpl`, so the intended integration is a
proxy-aware `undici` `ProxyAgent` passed into the host — not env proxy vars. The
`proxy-smoke.mjs` probe uses that same `ProxyAgent` mechanism to prove the path.

### Credentials

- Model credentials live only in `deploy/sdk/.env`, read only by `sdk-worker`
  via `env_file: [./sdk/.env]`.
- It must contain **only** `MODEL_BASE_URL`, `MODEL_NAME` and `MODEL_API_KEY`.
- Never put GitHub App credentials, tokens, Postgres/Redis URLs, webhook secrets
  or private keys in it. The worker is not allowed to have them, and the config
  test asserts no such keys reach the worker environment.
- The proxy receives **no** `env_file` and only the non-secret
  `MODEL_ALLOWED_HOST` (plus `NODE_ENV`).
- `deploy/sdk/.env` is gitignored (root `.env` rule), excluded from the build
  context (`deploy/sdk/.dockerignore`), and has a value-free template at
  `deploy/sdk/.env.example`.
- The worker health JSON reports only booleans:
  `modelConfigured` and `egressProxyConfigured`. It never returns values and
  still makes no model call in the placeholder.

### Validate, build, run, probe, tear down

Run from the repository root.

```bash
# 0. Create the local credential file (gitignored) from the template.
cp deploy/sdk/.env.example deploy/sdk/.env
# Edit deploy/sdk/.env if you want modelConfigured=true. The Phase 2b probe
# needs no model key: it only exercises proxy reachability/denial.

# 1. Lockfile check in the SDK build context.
cd deploy/sdk
npm ci --omit=dev --dry-run
cd ../..

# 2. Static tests + Compose validation (normal and probe profile).
npx vitest run test/deployment-sdk.test.ts
docker compose -f deploy/docker-compose.sdk.yml config
docker compose --profile probe -f deploy/docker-compose.sdk.yml config

# 3. Build both images (worker and egress proxy).
docker compose -f deploy/docker-compose.sdk.yml build

# 4. Start the proxy first, then the worker; wait for health.
docker compose -f deploy/docker-compose.sdk.yml up -d sdk-egress-proxy sdk-worker
docker inspect --format '{{.State.Health.Status}}' \
  "$(docker compose -f deploy/docker-compose.sdk.yml ps -q sdk-egress-proxy)"
docker inspect --format '{{.State.Health.Status}}' \
  "$(docker compose -f deploy/docker-compose.sdk.yml ps -q sdk-worker)"

# 5. Re-run the Phase 1 boundary probe (must still be 12/12 PASS).
docker compose -f deploy/docker-compose.sdk.yml run --rm sdk-isolation-probe

# 6. Run the egress allow/deny smoke test (JSON report; exit 0 only on PASS).
docker compose -f deploy/docker-compose.sdk.yml run --rm sdk-egress-probe

# 7. Tear everything down, including probe-only volumes.
docker compose --profile probe -f deploy/docker-compose.sdk.yml down -v --remove-orphans
```

`docker compose ... config` is the interpolation/normalisation check. The
egress probe prints `{checks:[...], passed}` to stdout and exits `0` only when
all four checks pass: proxy health, allowlisted CONNECT reachable, denied host
blocked, and direct egress blocked.

### Phase 2b scope and limits

- This task proves the **egress path** and keeps it ready. The Phase 2 runtime
  adapter is **not yet consuming this proxy in the container** — injecting the
  proxy-aware `fetch` into the containerised host is the next integration step.
- A model-host outage or a DNS failure in the proxy is reported as a failed
  `allowlisted-connect` check; the allowlist logic can still be proven with a
  local TLS target if the public host is unreachable, but nothing is faked.
- Re-run **both** probes after any change to the image, compose file or proxy.
- Production readiness is **not** claimed. Resource limits remain provisional,
  and the ADR §7 model-level adversarial suite still must run against a real
  model path.

## Deliberately absent in Phase 1 (and still true in Phase 2b unless noted)

- Model calls: the placeholder worker still makes none. The credential file and
  egress proxy now exist, but the adapter does not consume them in-container.
- GitHub App credentials/tokens, Postgres, Redis, BullMQ queue integration.
- `AgentRuntime` adapter, review logic, custom review tools, verification.
- Publishing, shadow comparison, production config/schema changes.
- Production deployment wiring: the production Compose file does not import
  this stack, and root dependencies are untouched.

## What remains before any real SDK review

1. **Wire the proxy into the adapter inside the container** (the egress path is
   ready but not yet consumed). Inject the proxy-aware `undici` `ProxyAgent`
   `fetch` into the SDK host.
2. A worker-side credential path already exists (`deploy/sdk/.env`, only
   MODEL_*); keep it free of GitHub tokens and database credentials.
3. The SDK runtime adapter behind `agent.sdk.enabled=false`, keeping the CLI
   runtime as the production default.
4. A full re-run of the Phase 1 probe suite plus the ADR §7 adversarial tests
   (prompt injection, symlinks, cross-review access, unauthorized writes) under
   the new egress configuration and a real model.
5. Measured resource baselines before replacing the provisional guardrails.
