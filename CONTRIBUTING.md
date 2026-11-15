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
cp .env.example .env     # provides DATABASE_URL/REDIS_URL defaults for Prisma CLI
npx prisma migrate deploy   # only needed for a fresh database
npm run build
npm test
```

### Local Postgres and Redis

The integration and characterization tiers expect Postgres on
`localhost:5432` and Redis on `localhost:6379` by default. Start throwaway
containers with the same commands on every machine (the defaults match the
values in `.env.example`):

```bash
docker run -d --name probot-postgres \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=reviewer \
  -p 5432:5432 postgres:16

docker run -d --name probot-redis -p 6379:6379 redis:7

# Apply the schema once, and again after pulling new migrations. Prisma CLI
# reads DATABASE_URL from .env or from the command environment.
DATABASE_URL=postgres://postgres:postgres@localhost:5432/reviewer \
  npx prisma migrate deploy
```

If the ports are taken or you use a shared database, point the suites at it
with `DATABASE_URL` and `REDIS_URL`. The test process reads those variables
directly, so the same commands work locally and in CI:

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/reviewer \
REDIS_URL=redis://localhost:6379 \
npm run test:integration
```

Stop and remove the containers with:

```bash
docker rm -f probot-postgres probot-redis
```

Run the tiers in the same order as CI — cheapest first, so a unit failure
fails fast without touching the database:

```bash
npm run test:unit
npm run test:contract
DATABASE_URL=postgres://postgres:postgres@localhost:5432/reviewer \
  npx prisma migrate deploy
npm run test:integration
npm run test:characterization
npm run build
```

CI runs the first two commands in the service-free `Unit` job. The `Test` job
waits for both `Quality` and `Unit` before it starts migrations and the
infrastructure tiers.

`npm test` runs every tier in one Vitest process. The sandbox integration
suite in `test/integration/execution-security.test.ts` also needs Docker; the
remaining integration tests only need Postgres and Redis. On macOS, Docker
volume mounts must share a `TMPDIR` with the daemon; run the sandbox tier as
`TMPDIR=/Users/surya/tmp npm run test:integration` (or use any shared temp
directory).

## Docker Compose smoke test

`scripts/smoke/docker-smoke.sh` builds the production image and starts the real
Compose stack — Postgres, Redis, the one-shot migration, the Probot server, and
the worker — from `deploy/docker-compose.yml`, `deploy/docker-compose.local.yml`,
and `scripts/smoke/docker-compose.smoke.yml`. It then:

- polls `GET /healthz` and `GET /readyz` on the published loopback port;
- asserts the server reached its degraded start path (no GitHub App
  credentials configured);
- waits for the worker to log readiness with Postgres and Redis `ok` and for a
  BullMQ consumer to connect to the review queue.

No GitHub App or model-provider credentials are required, and no review runs.
The script uses a unique Compose project name, publishes the server on
`127.0.0.1` only, and always removes the containers, volumes, and network it
created:

```bash
bash scripts/smoke/docker-smoke.sh
```

Requirements: Docker with Compose v2.24+ (the smoke override uses `!reset`) and
Node (used to pick a free host port). Override `PROBOT_PORT`, `SMOKE_TIMEOUT`,
or `SMOKE_LOG_DIR` when needed. On failure the script prints the container logs
and writes them to `test-results/docker-smoke/`.

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
[design](docs/specs/2026-11-14-typescript-refactor-design.md), the
[implementation plan](docs/plans/2026-11-15-typescript-refactor-implementation.md),
and the [architecture](docs/architecture.md). The enforced boundaries are in
`docs/module-boundaries.md`; approved deviations are recorded in
`docs/adr/`. These rules apply to every PR:

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
  under `test/integration/`; characterization tests live under
  `test/characterization/`.
- **Do not weaken the lint configuration.** New `eslint-disable` comments need
  an inline reason. Temporary rule overrides must carry a `TODO` naming the
  PR that removes them. The only remaining allowance is scoped to the frozen
  characterization suite (`test/characterization/**`), which turns off
  `@typescript-eslint/no-explicit-any` and
  `@typescript-eslint/no-non-null-assertion` because its assertions are the
  black-box behavioural baseline. Unit, contract, integration, and helper code
  are fully checked.
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

GitHub Actions runs six jobs on every pull request:

- `Quality`: `format:check`, `lint`, `typecheck`, `typecheck:tests`, and
  `metrics:quality`.
- `Unit`: `test:unit` and `test:contract` in a service-free job with no
  Postgres/Redis service containers or dependency URLs. It uploads
  `test-results/` as the `unit-test-logs` artifact on failure.
- `Test`: waits for `Quality` and `Unit`, then uses Postgres 16 and Redis 7
  service containers to run `prisma migrate deploy`, `test:integration`,
  `test:characterization`, and `build`. On failure the job uploads the
  captured Vitest, migration, and build logs as the `test-logs` artifact.
- `Docker smoke`: waits for `Quality` and `Unit`, builds the production image,
  and runs `scripts/smoke/docker-smoke.sh` against the Compose stack.
  GitHub-hosted runners provide Docker; local runs need Docker with Compose
  v2.24+.
- `Commitlint`: the PR title and every commit in the branch.
- `Security`: `npm run security:audit` and a gitleaks secret scan.
  `security:audit` runs `npm audit --audit-level=high` and fails on any
  high/critical advisory that is not in
  [`scripts/npm-audit-allowlist.json`](scripts/npm-audit-allowlist.json). The
  four current exceptions and their follow-ups are listed in
  [docs/security-audit-follow-ups.md](docs/security-audit-follow-ups.md).

`Quality`, `Unit`, `Test`, `Docker smoke`, `Commitlint`, and `Security` must
pass before merge. Repository administrators must configure branch protection
to require those checks; the workflow cannot enforce that setting itself.

## Resources

- [How to Contribute to Open Source](https://opensource.guide/how-to-contribute/)
- [Using Pull Requests](https://help.github.com/articles/about-pull-requests/)
- [GitHub Help](https://help.github.com)
- [Conventional Commits](https://www.conventionalcommits.org/)
