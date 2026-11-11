# SDK worker image (Phase 1, non-production)

Experimental build context for the dedicated OpenCode SDK worker image. This is
**not** part of the production stack and is not referenced by
`deploy/docker-compose.yml` or the repository root `Dockerfile`.

- Base image: `node:24.0.0-slim` — Node 24 is required only here because
  `@opencode/sdk@2.2.7` imports `@opencode/util`, which uses `await using`.
  The production CLI image stays on Node 22.14.0.
- Dependency: `@opencode/sdk@2.2.7` (exact), installed with `npm ci --omit=dev`.
- Worker: `worker/placeholder-worker.mjs` creates an **offline** SDK host,
  refreshes `/tmp/sdk-worker/heartbeat`, serves `GET /health` and `GET /ready`
  on `0.0.0.0:8081` (internal-only container network; no host port is
  published), and closes the host in a single `finally` on SIGTERM/SIGINT.
- Filesystem invariant: no writable mount outside `/tmp`, `/app/workspaces`,
  and standard `/proc`/`/sys`/`/dev` interfaces. `/dev/shm` and other `/dev/*`
  mounts are rw Docker defaults, not application storage.
- No model calls, no model credentials, no GitHub/DB/Redis, no queue, no
  review adapter, no publishing. Phase 1 verifies the container boundary only;
  the ADR §7 model-level adversarial suite is Phase 2.
- `package-lock.json` was added in this phase. `npm ci` reports 31 transitive
  advisories and `@opentui/core` emits an `EBADENGINE` warning under Node 24;
  both are recorded and intentionally not resolved because root dependency
  changes are out of scope for the experiment.

The compose stack and full operating instructions live in
[`docs/deployment-sdk-runtime.md`](../../docs/deployment-sdk-runtime.md).
Architecture rationale: [`docs/architecture-sdk-runtime.md`](../../docs/architecture-sdk-runtime.md).
