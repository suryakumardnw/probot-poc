import { createPrisma, disconnectPrisma } from "../../src/platform/db/prisma.js";
import { testEnv } from "./env.js";

/**
 * Shared test database client.
 *
 * Tests construct their own Prisma client instead of reaching for a production
 * singleton, and close it in their teardown. Suites that only need environment
 * settings import `testEnv` from `./env.js` instead, so they do not create an
 * unused client.
 */

export const prisma = createPrisma(testEnv);

export async function disconnectDatabase(): Promise<void> {
  await disconnectPrisma(prisma);
}
