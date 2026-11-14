# Pull request

## What changes for the user

<!-- Describe the observable change. Write "No user-visible change" for
tooling, refactor, and test-only PRs. -->

## What could break

<!-- Name the behavior, boundary, or dependency most likely to break and how a
reviewer can spot it. Include migration or configuration steps. -->

## How it was verified

<!-- List the exact commands you ran and their result, for example:
`npm run format:check && npm run lint && npm run typecheck && npm test && npm run build` - passed.
Add manual checks, screenshots, or links to CI runs when relevant. -->

## Quality metrics before/after

<!-- Run `npm run metrics:quality` on the base branch and this branch, then
paste the relevant counts. Write "Not applicable" when no `src/` or `test/`
TypeScript changed. -->

| Metric                                                         | Before | After |
| -------------------------------------------------------------- | -----: | ----: |
| `any` type positions (`src`)                                   |        |       |
| Non-null assertions (`src`)                                    |        |       |
| `as unknown as` (`src`)                                        |        |       |
| Boundary `JSON.parse(...) as` (`src`)                          |        |       |
| Prisma imports outside repositories                            |        |       |
| `process.env` outside platform config                          |        |       |
| Cross-module internal imports                                  |        |       |
| Test files requiring Postgres/Redis outside `test/integration` |        |       |

## Rollback plan

<!-- How to revert safely: revert this commit, roll back a migration, toggle a
feature flag, or restore configuration. State whether data changes are
involved. -->

## Checklist

- [ ] Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) and the rules in `CONTRIBUTING.md`.
- [ ] `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm run metrics:quality`, `npm test`, `npm run build`, and `npm run security:audit` pass locally.
- [ ] No new `any`, non-null assertion (`!`), or unsafe `as` was introduced.
- [ ] Tests cover the change, and any new infrastructure dependency is explicit.
- [ ] This PR is one intent; refactors and behavior changes are separate.
- [ ] Any disabled lint rule is documented with a TODO and a follow-up PR.
- [ ] Branch protection requires the `Quality`, `Test`, `Commitlint`, and `Security` checks before merge.
