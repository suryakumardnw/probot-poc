# Test tiers

Vitest projects are defined in `vitest.config.ts`; each tier is runnable on its
own.

| Tier             | Command                         | Infrastructure                   | Location                                           |
| ---------------- | ------------------------------- | -------------------------------- | -------------------------------------------------- |
| Unit             | `npm run test:unit`             | None (no Postgres/Redis/network) | `src/**/*.test.ts`, `test/*.test.ts`, `scripts/**` |
| Contract         | `npm run test:contract`         | None                             | `src/contracts/**/*.test.ts`                       |
| Integration      | `npm run test:integration`      | Postgres, Redis, Docker          | `test/integration/**/*.test.ts`                    |
| Characterization | `npm run test:characterization` | Postgres, Redis                  | `test/characterization/**/*.test.ts`               |

`npm test` runs all four tiers. It passes `--no-file-parallelism` so the
integration and characterization tiers never overlap: both share one
Postgres/Redis instance and truncate tables between tests.

The integration tier also contains the Docker sandbox suite and the Redis
outage suite, so it needs a Docker daemon and the local compose dependencies.
The characterization suite has its own coverage map in
`test/characterization/README.md`.

Test-only helpers live in `test/helpers/`:

- `assert.ts` — narrowing helpers (`defined`, `first`, `at`, `rejectionOf`,
  `instanceOf`). They replace non-null assertions and ad-hoc casts.
- `db.ts`, `env.ts`, `ingestion.ts`, `triage.ts` — Postgres/Redis fixtures.
- `events.ts` — a structural view of `Probot.receive` for partial webhook
  fixtures; delivery still goes through the real receiver.
