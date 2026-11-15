# ADRs

Architecture Decision Records for probot-poc. Each ADR records one approved
deviation or structural decision: context, decision, consequences, and the
alternatives that were rejected. The profile
([../typescript-profile.md](../typescript-profile.md)) summarizes how the
Nativewit TypeScript guidelines apply to this repository; an undocumented
deviation is treated as a defect in review.

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-keep-probot.md) | Keep Probot for the GitHub App | Accepted |
| [0002](0002-prisma-over-drizzle.md) | Keep Prisma over Drizzle | Accepted |
| [0003](0003-single-npm-package.md) | Stay a single npm package | Accepted |
| [0004](0004-contracts-in-src.md) | Keep contracts in `src/contracts` | Accepted |
| [0005](0005-unit-of-work.md) | Module-owned units of work for atomic multi-repository writes | Accepted |
| [0006](0006-failure-classification.md) | One `AppError` family and one failure classifier | Accepted |

## Format

Every ADR uses the same headings:

1. **Status** — proposed, accepted, superseded, or deprecated.
2. **Context** — the forces and constraints that require a decision.
3. **Decision** — what the repository does.
4. **Consequences** — what becomes easier, what becomes harder, and what is
   deliberately deferred.
5. **Alternatives considered** — rejected options and why.
6. **References** — code, docs, and related decisions.

Add a new ADR rather than rewriting an accepted one. If a decision changes,
mark the old ADR `Superseded by ADR-NNNN` and link both.
