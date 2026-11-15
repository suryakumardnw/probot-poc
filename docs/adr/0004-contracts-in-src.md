# ADR 0004 — Keep contracts in `src/contracts`

Status: Accepted · 2026-11-15

## Context

The handbook shares boundary schemas through a `@nativewit/contracts` package.
This repository has one consumer: the application itself. Contracts are used by
modules, platform adapters, bootstrap, scripts, and tests from the same build.

Publishing a package would require versioning, a build step, and a release
process for code that changes in lockstep with the application.

## Decision

Keep the boundary Zod schemas and inferred types in **`src/contracts`**,
exported through `src/contracts/index.ts`.

- Contracts are the place hand-written boundary shapes live: queue/outbox
  payloads, admin HTTP request/response/query shapes, model responses, agent
  protocol messages, error codes/envelope, environment and review config.
- One composition-root exception remains: `src/bootstrap/http.ts` defines
  `manualReviewBodySchema` for the `POST /api/reviews` body. It is validated at
  the HTTP edge but has not moved yet. Follow-up: move it to
  `src/contracts/admin.ts` and import it from the composition root.
- Types are derived with `z.infer`; there is no duplicated hand-written shape.
- `contracts` may import **only `zod`** (plus its own internals). ESLint
  enforces this and test-category files are exempt.
- Vendor boundaries that already provide trusted types (Probot webhook
  payloads, Octokit responses) use those types instead of re-declaring them.
  Raw JSON parsed outside a typed SDK gets a schema.

## Consequences

- Schema changes and their consumers land in one commit and one review.
- No package version skew, publish step, or workspace resolution to debug.
- `src/contracts` is a dependency leaf: modules, platform, ports, shared,
  bootstrap, and tests can import it without cycles.
- The `POST /api/reviews` body schema is the one schema still defined in a
  composition root. It is a small, tracked follow-up rather than an untracked
  exception.
- If a second real consumer appears (another deployable or an external client),
  extract the directory into a package then; the import path changes, not the
  schemas.

## Alternatives considered

- **Publish `@nativewit/contracts` now** — versioning and release overhead for a
  single consumer, with a risk of drift between package and app.
- **Keep schemas beside each module** — duplicates shapes across modules and
  makes cross-boundary payloads inconsistent.
- **Hand-written TypeScript interfaces** — reintroduces cast-based parsing at
  the boundary, which this refactor removed.

## References

- [../architecture.md](../architecture.md) §3, §4
- [../module-boundaries.md](../module-boundaries.md)
- [../typescript-profile.md](../typescript-profile.md)
- `src/contracts/`
