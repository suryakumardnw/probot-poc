## Contributing

[fork]: /fork
[pr]: /compare
[code-of-conduct]: CODE_OF_CONDUCT.md

Hi there! We're thrilled that you'd like to contribute to this project. Your help is essential for keeping it great.

Please note that this project is released with a [Contributor Code of Conduct][code-of-conduct]. By participating in this project you agree to abide by its terms.

## Issues and PRs

If you have suggestions for how this project could be improved, or want to report a bug, open an issue! We'd love all and any contributions. If you have questions, too, we'd love to hear them.

We'd also love PRs. If you're thinking of a large PR, we advise opening up an issue first to talk about it, though! Look at the links below if you're not sure how to open a PR.

## Development setup

Prerequisites:

- Node.js 24 (see `engines` in `package.json`).
- npm, using the committed `package-lock.json`.
- PostgreSQL and Redis for the integration suites. The tests default to
  `postgres://postgres:postgres@localhost:5432/reviewer` and
  `redis://localhost:6379`; override them with `DATABASE_URL` and `REDIS_URL`.
- Docker for the sandbox tests in `test/integration/execution-security.test.ts`.

```bash
npm ci
npm run db:generate      # generate the Prisma client
cp .env.example .env        # optional for local runs; tests set their own defaults
npx prisma migrate deploy   # only needed for a fresh database
npm run build
npm test
```

## Commands

Run the same commands locally that CI runs. Everything must pass before review.

| Command                                | Purpose                                                   |
| -------------------------------------- | --------------------------------------------------------- |
| `npm run format`                       | Write Prettier formatting.                                |
| `npm run format:check`                 | Verify formatting without writing.                        |
| `npm run lint`                         | Run ESLint over the repository.                           |
| `npm run lint:fix`                     | Apply ESLint autofixes (import order, type imports).      |
| `npm run typecheck`                    | Run `tsc --noEmit`.                                       |
| `npm run typecheck:tests`              | Typecheck `src/`, `test/`, and `scripts/` tests.          |
| `npm run test:unit`                    | Pure tests; no Postgres, Redis, or network.               |
| `npm run test:contract`                | Zod contract tests in `src/contracts/`.                   |
| `npm run test:integration`             | Postgres/Redis/Docker integration tests.                  |
| `npm run test:characterization`        | Behavioural baseline; needs Postgres and Redis.           |
| `npm test`                             | Run every Vitest tier; needs Postgres, Redis, and Docker. |
| `npm run build`                        | Compile `src/` to `lib/`.                                 |
| `npm run security:audit`               | Fail on new high/critical dependency advisories.          |
| `npm run metrics:quality`              | Print quality metrics (informational; CI runs this too).  |
| `npm run metrics:quality -- --details` | List every metric match site.                             |
| `npm run db:generate`                  | Regenerate the Prisma client.                             |
| `npm run db:migrate`                   | Apply migrations (`prisma migrate deploy`).               |
| `npm run db:migrate:dev`               | Create and apply a migration during development.          |

The full local gate is:

```bash
npm run format:check && npm run lint && npm run typecheck && npm run typecheck:tests && npm run metrics:quality && npm test && npm run build && npm run security:audit
```

`metrics:quality` is informational for this phase: it records the refactor
counts and fails only if the metrics script itself errors. No metric thresholds
are enforced yet. CI runs the same command.

## Commit messages

This repository uses [Conventional Commits](https://www.conventionalcommits.org/).
Commitlint checks pull request titles and every commit in the branch.

```text
<type>(<optional scope>): <lowercase imperative subject>
```

- Allowed types: `feat`, `fix`, `refactor`, `test`, `docs`, `perf`, `chore`, `ci`.
- The scope is optional and lowercase, for example `fix(worker): ...`.
- The subject is imperative, lowercase, and has no trailing period.
- Keep the header under 100 characters.
- One intent per commit and per pull request. Do not mix a refactor with a
  behavior change in the same PR.

Examples:

```text
feat(review): add handbook guideline selection
fix(worker): release lock after shutdown timeout
chore(tooling): add eslint prettier commitlint and ci
```

The `commitlint` CI job validates the PR title (used by squash merges) and the
commit range. A non-conventional commit or PR title fails the check.

## Refactor rules

The TypeScript refactor is governed by `docs/typescript-profile.md`, the
[design](docs/specs/2026-11-14-typescript-refactor-design.md), and the
[implementation plan](docs/plans/2026-11-15-typescript-refactor-implementation.md).
These rules apply to every PR:

- **No behavior change in refactor PRs.** Move or reshape code first; change
  behavior in a separate PR with tests.
- **No new `any` in a type position, no `!` non-null assertions, and no unsafe
  `as` casts.** Parse unknown data at the boundary with Zod; do not assert a
  shape into existence.
- **Prisma stays behind repositories.** Do not import `@prisma/client` outside
  `src/**/*.repository.ts` and `src/platform/db/**`.
- **Environment reads stay in `src/platform/config/**`.** Do not add
  `process.env` reads in domain code.
- **Modules have public entry points.** Import another module through its
  `index.ts`; do not reach into its internals.
- **Tests fake at seams.** Unit tests must not require Postgres, Redis, or the
  network. Integration tests that need infrastructure are explicit and live
  under `test/integration/` once that tier exists.
- **Do not weaken the lint configuration.** New `eslint-disable` comments need
  an inline reason. Temporary rule overrides must carry a `TODO` naming the
  PR that removes them. Currently the test suite turns off
  `@typescript-eslint/no-explicit-any` and
  `@typescript-eslint/no-non-null-assertion` until PR 4.2, and a fixed list of
  source files has `no-non-null-assertion` disabled until the same PR; see
  `eslint.config.mjs`.
- **Lint exceptions are explicit.** `deploy/inspect-key.js` is a one-off
  diagnostic copied into the worker container and runs as CommonJS outside the
  package, so `eslint.config.mjs` permits `console` and `require` for that file
  only. It is not application code.
- **Report metrics for structural PRs.** Include `npm run metrics:quality`
  before/after counts in the PR description.
- **Keep dependencies still.** New dependencies need a justification; tooling
  dependencies are not product dependencies.
- **No generated files in review.** `lib/`, `coverage/`, and
  `tsconfig.tsbuildinfo` are build output and are ignored.

## Submitting a pull request

1. [Fork][fork] and clone the repository.
1. Configure and install the dependencies: `npm ci`.
1. Create a new branch: `git checkout -b my-branch-name`.
1. Make your change, add tests, and run the full local gate above.
1. Fill in every section of the pull request template, including the
   before/after quality metrics when applicable.
1. Push to your fork and [submit a pull request][pr].
1. Pat yourself on the back and wait for your pull request to be reviewed and
   merged.

Here are a few things you can do that will increase the likelihood of your pull request being accepted:

- Write and update tests.
- Keep your changes as focused as possible. If there are multiple changes you would like to make that are not dependent upon each other, consider submitting them as separate pull requests.
- Write a [good commit message](http://tbaggery.com/2008/04/19/a-note-about-git-commit-messages.html).

Work in Progress pull requests are also welcome to get feedback early on, or if there is something blocked you.

## Continuous integration

GitHub Actions runs four jobs on every pull request:

- `Quality`: `format:check`, `lint`, `typecheck`, and `metrics:quality`.
- `Test`: Postgres 16 and Redis 7 service containers, migrations, `npm test`,
  and `npm run build`.
- `Commitlint`: the PR title and every commit in the branch.
- `Security`: `npm run security:audit` and a gitleaks secret scan.
  `security:audit` runs `npm audit --audit-level=high` and fails on any
  high/critical advisory that is not in
  [`scripts/npm-audit-allowlist.json`](scripts/npm-audit-allowlist.json). The
  four current exceptions and their follow-ups are listed in
  [docs/security-audit-follow-ups.md](docs/security-audit-follow-ups.md).

`Quality`, `Test`, `Commitlint`, and `Security` must pass before merge.
Repository administrators must configure branch protection to require those
checks; the workflow cannot enforce that setting itself.

## Resources

- [How to Contribute to Open Source](https://opensource.guide/how-to-contribute/)
- [Using Pull Requests](https://help.github.com/articles/about-pull-requests/)
- [GitHub Help](https://help.github.com)
- [Conventional Commits](https://www.conventionalcommits.org/)
