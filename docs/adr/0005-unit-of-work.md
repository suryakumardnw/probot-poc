# ADR 0005 — Module-owned units of work for atomic writes

Status: Accepted · 2026-11-15

## Context

Several use cases must write multiple aggregates atomically:

- Review intake: installation, repository, pull request, review, review job,
  webhook delivery, and outbox event.
- Finding persistence: findings, lifecycle updates, and review state.

The refactor requires Prisma to stay inside repository adapters, so a service
cannot receive a Prisma transaction client or call `$transaction` itself. At the
same time, opening one transaction per repository method would destroy
atomicity.

## Decision

Use **module-owned unit-of-work (UoW) ports** for multi-repository atomic
operations.

```ts
interface IngestionUnitOfWork {
  run<T>(work: (repositories: IngestionRepositories) => Promise<T>): Promise<T>;
}
```

- The UoW interface and its transaction-scoped repository bundle live in the
  module that owns the use case.
- The Prisma implementation owns `$transaction` and constructs the bundle from
  the transaction client; the vendor client never crosses the adapter boundary.
- **Single-write operations use repository methods directly.** There is no
  transaction ceremony for one aggregate.
- Services receive the UoW (and ordinary repositories) by injection from the
  composition root. Unit tests use an in-memory/fake UoW.
- The same pattern is used by ingestion and findings where a multi-write
  boundary exists. Publication keeps its guarded repository writes and
  state-transition service; it has no multi-aggregate UoW.

## Consequences

- Transaction boundaries are explicit in the module that needs them and visible
  in its tests.
- Prisma remains an implementation detail; swapping the database later means
  replacing the UoW/repository adapters only.
- A UoW callback must not perform network I/O or long-running work inside the
  transaction. The intake path respects this: it commits durable rows and then
  publishes the outbox event after the transaction.
- Repository bundles grow with the use case; each bundle is module-local, so
  unrelated modules do not share a god interface.

## Alternatives considered

- **Per-repository transactions** — cannot make multi-aggregate writes atomic,
  which is required for idempotent intake and publication.
- **Pass Prisma's transaction client into services** — leaks the vendor type and
  violates the repository boundary.
- **A global UoW for every aggregate** — creates a god interface and lets any
  module write any table; rejected in favor of module-owned bundles.
- **Eventual consistency with compensating writes** — more failure modes and
  operator burden than one local PostgreSQL transaction.

## References

- [../architecture.md](../architecture.md) §3, §6, §7
- [../module-boundaries.md](../module-boundaries.md)
- [../queue-reliability.md](../queue-reliability.md)
- `src/modules/ingestion/ingestion.unit-of-work.ts`,
  `src/modules/findings/findings.unit-of-work.ts`
