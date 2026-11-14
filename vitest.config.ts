import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Contract and error tests are co-located with the modules they pin.
    include: ["test/**/*.test.ts", "src/**/*.test.ts", "scripts/**/*.test.ts"],
    // Integration suites share one Postgres/Redis instance; running files
    // concurrently lets one suite's cleanDatabase() wipe another's fixtures.
    fileParallelism: false,
    coverage: {
      provider: "v8",
    },
  },
});
