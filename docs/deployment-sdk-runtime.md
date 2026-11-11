# Experimental SDK worker deployment (Phase 1)

> **Experimental / non-production.** This deployment unit exists to verify a
> container boundary for the OpenCode SDK runtime experiment. It is not wired
> into the production stack, does not consume review jobs, does not call a
> model, and does not publish anything. Production rollout is not authorized.
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

A separate Compose project, `ai-pr-reviewer-sdk`, with two services:

| Service | Purpose |
| --- | --- |
| `sdk-worker` | Long-running **offline placeholder shell**: creates an OpenCode SDK host with inline config, writes a heartbeat, serves an internal-only health endpoint, closes the host gracefully. |
| `sdk-isolation-probe` | One-shot adversarial check under the **same** hardening anchor. Runs only with the `probe` profile. |

The image (`deploy/sdk/Dockerfile`, build context `deploy/sdk`) contains only
Node, the pinned SDK dependency and the three worker scripts. It has no
`opencode` CLI, no git, no Docker CLI, no Prisma, no `.env` and no secrets.

Phase 1 makes **no model calls** and requires **no model credentials**.

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

## Deliberately absent in Phase 1

- Model credentials and model egress (no provider config, no API key).
- GitHub App credentials/tokens, Postgres, Redis, BullMQ queue integration.
- `AgentRuntime` adapter, review logic, custom review tools, verification.
- Publishing, shadow comparison, production config/schema changes.
- Production deployment wiring: the production Compose file does not import
  this stack, and root dependencies are untouched.

## What Phase 2 must add before any real SDK review

1. An egress proxy/allowlist sidecar (or equivalent) for the model provider.
   The current stack has **no** public egress; Phase 2 credentials must not
   reintroduce unrestricted egress.
2. A worker-side credential path that receives only the model credentials it
   needs — never GitHub tokens or database credentials.
3. The SDK runtime adapter behind `agent.sdk.enabled=false`, keeping the CLI
   runtime as the production default.
4. A full re-run of the Phase 1 probe suite, plus the ADR §7 adversarial tests
   (prompt injection, symlinks, cross-review access, unauthorized writes) under
   the new egress configuration.
5. Measured resource baselines before replacing the provisional guardrails.
