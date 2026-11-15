# ADR 0003 — Stay a single npm package

Status: Accepted · 2026-11-15

## Context

The repository produces one deployable: a Probot server and a BullMQ worker
built from the same source tree and shipped in the same Docker image. There is
no second application, no published library, and no independent release cadence
for any subdirectory.

The handbook assumes a pnpm + Turborepo monorepo with `apps/` and `packages/`.
Adopting that layout for one deployable adds workspace tooling, package
manifests, and build orchestration without a consumer.

## Decision

Stay a **single npm package** with one `package.json`, one
`package-lock.json`, one TypeScript build, and one Docker image.

- Process boundaries (`probot`, `worker`) are entry points, not packages:
  `src/server.ts` and `src/worker.ts` share `src/` and `lib/`.
- Module boundaries are enforced by `eslint-plugin-boundaries`, not by package
  boundaries.
- `src/contracts` is a source directory until a second real consumer exists
  (see [ADR 0004](0004-contracts-in-src.md)).
- `prisma/` and deploy assets stay at the repository root.

## Consequences

- `npm ci`, `npm run build`, `npm test`, and the Docker build remain the only
  toolchain a contributor needs.
- No duplicated manifests, no workspace protocol, no Turborepo cache to
  operate.
- Isolation is logical rather than physical: a bad import is caught by lint,
  not by the package manager. The boundary rules and negative probes in
  [../module-boundaries.md](../module-boundaries.md) are therefore mandatory.
- If the repository later splits into independently deployed apps or a shared
  package with a second consumer, revisit this ADR and add a workspace layout
  in a dedicated PR.

## Alternatives considered

- **pnpm + Turborepo now** — faster incremental builds and package isolation,
  but no second package to isolate and a migration cost during a structural
  refactor.
- **npm workspaces with empty `apps/`/`packages/`** — ceremony with no
  consumer; explicitly rejected in the profile.
- **Separate worker package** — the worker shares nearly all code with the
  server and ships in the same image; splitting would duplicate build and
  dependency management.

## References

- [../architecture.md](../architecture.md) §2
- [../module-boundaries.md](../module-boundaries.md)
- [../typescript-profile.md](../typescript-profile.md)
- `package.json`, `tsconfig.build.json`, `Dockerfile`
