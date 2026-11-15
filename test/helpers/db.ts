import { loadEnv } from "../../src/config/env.js";
import { createPrisma, disconnectPrisma } from "../../src/lib/prisma.js";

/**
 * Shared test database client.
 *
 * Tests construct their own Prisma client instead of reaching for a production
 * singleton, and close it in their teardown. Postgres is expected to be up for
 * the suites that import this module.
 */

export const testEnv = loadEnv();

export const prisma = createPrisma(testEnv);

export async function disconnectDatabase(): Promise<void> {
  await disconnectPrisma(prisma);
}
