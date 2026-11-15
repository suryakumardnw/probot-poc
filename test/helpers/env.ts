import { loadEnv } from "../../src/config/env.js";

/**
 * Validated environment for tests.
 *
 * Kept separate from the database client so suites that only need connection
 * settings (for example to build a queue or a bootstrap runtime) do not
 * construct an unused Prisma client.
 */

export const testEnv = loadEnv();
