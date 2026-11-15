# ADR 0002 — Keep Prisma over Drizzle

Status: Accepted · 2026-11-15

## Context

The service has a mature PostgreSQL schema, twelve applied migrations, and
Prisma-generated types used by production code. Review intake, publishing,
findings, admin audit, knowledge snapshots, and workspace bookkeeping all rely
on transactional writes.

The handbook's default data layer is Drizzle. Switching ORMs would rewrite the
schema, migrations, and every query, with no change to the domain model or
user-visible behavior.

## Decision

Keep **PostgreSQL + Prisma 6**.

- `prisma/schema.prisma` and `prisma/migrations/` remain the schema source of
  truth; migrations stay append-only.
- Services never import `@prisma/client`. Each module owns repository
  interfaces and a `*.repository.ts` Prisma adapter that maps rows/enums to
  contract or domain types.
- Multi-repository atomic writes go through module-owned unit-of-work ports
  (see [ADR 0005](0005-unit-of-work.md)), so the Prisma transaction client
  never appears in a service signature.
- `src/platform/db/**` is the only non-repository production owner of the
  vendor client (client factory and the evaluation-run repository).

ESLint enforces the import boundary; the test-tier exception is documented in
[../module-boundaries.md](../module-boundaries.md).

## Consequences

- No data migration and no rewrite of mature, tested persistence paths.
- Prisma remains a vendor dependency behind repositories, so domain code is
  testable with fakes and can move to another ORM later without touching
  services.
- Repository adapters carry localized vendor input/read casts where Prisma's
  JSON types require them. These are documented vendor-boundary adaptations,
  not domain casts.
- Type-level Prisma shapes do not leak into modules; contracts own boundary
  shapes.
- Query performance and migration tooling stay as already operated in
  production.

## Alternatives considered

- **Rewrite on Drizzle** — a full data-layer rewrite with no domain benefit and
  a high regression risk during a behavior-preserving refactor.
- **Raw SQL / a query builder** — loses generated types and migration tooling
  that the repository already depends on.
- **Keep Prisma but let services use it directly** — the original gap:
  domain/application code cannot be tested without Postgres and the vendor
  model becomes the domain model. Rejected; repositories are the seam.

## References

- [../architecture.md](../architecture.md) §2, §3
- [../module-boundaries.md](../module-boundaries.md)
- [../typescript-profile.md](../typescript-profile.md)
- `prisma/schema.prisma`, `src/platform/db/`
