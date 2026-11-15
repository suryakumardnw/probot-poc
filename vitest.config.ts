import { defineConfig } from "vitest/config";

/**
 * Test tiers, cheapest first.
 *
 * - `unit` runs pure logic and needs no Postgres, Redis or outbound network.
 * - `contract` pins the Zod schemas beside `src/contracts/`; it is separate so
 *   contract drift is visible in CI without running the whole suite.
 * - `integration` exercises real Postgres/Redis (plus Docker for the sandbox
 *   suite) through the module seams.
 * - `characterization` is the black-box behavioural baseline described in
 *   `test/characterization/README.md`; it also needs Postgres/Redis.
 *
 * Integration-style suites share one Postgres/Redis instance, and their
 * `cleanDatabase()` helpers truncate shared tables, so those tiers must run
 * one file at a time. Unit and contract tests keep the default parallelism.
 *
 * Vitest treats `fileParallelism` as a root-only option, so it cannot be set
 * per project. `singleFork` is the project-scoped equivalent: each of the two
 * infrastructure tiers gets exactly one worker, and `npm test` additionally
 * passes `--no-file-parallelism` so the two tiers never overlap each other.
 */
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
    },
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts", "test/*.test.ts", "scripts/**/*.test.ts"],
          exclude: ["src/contracts/**"],
        },
      },
      {
        test: {
          name: "contract",
          include: ["src/contracts/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          poolOptions: { forks: { singleFork: true } },
        },
      },
      {
        test: {
          name: "characterization",
          include: ["test/characterization/**/*.test.ts"],
          poolOptions: { forks: { singleFork: true } },
        },
      },
    ],
  },
});
