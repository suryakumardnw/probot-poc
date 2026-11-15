import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { checkDependencies } from "../src/platform/health.js";
import { createRedis, disconnectRedis } from "../src/platform/redis.js";
import { prisma, disconnectDatabase } from "./helpers/db.js";
import { testEnv } from "./helpers/env.js";

/**
 * These tests run against localhost where Postgres/Redis are typically not
 * running; they assert the degraded path: every dependency is reported as
 * "unavailable" without the check throwing.
 */

const healthRedis = createRedis(testEnv);

afterAll(async () => {
  await disconnectRedis(healthRedis);
  await disconnectDatabase();
});

describe("checkDependencies (degraded path)", () => {
  let result: Awaited<ReturnType<typeof checkDependencies>>;

  beforeEach(async () => {
    result = await checkDependencies({ prisma, redis: healthRedis });
  });

  test("reports both dependencies with a status", () => {
    const names = result.dependencies.map((dep) => dep.name).sort();
    expect(names).toEqual(["postgres", "redis"]);
    for (const dep of result.dependencies) {
      expect(["ok", "unavailable"]).toContain(dep.status);
    }
  });

  test("does not throw even when dependencies are down", () => {
    // Reaching here without throwing is the assertion.
    expect(result).toBeDefined();
    expect(result.status).toBeDefined();
  });

  test("reports status degraded when at least one dependency is unavailable", () => {
    const unavailable = result.dependencies.some((dep) => dep.status === "unavailable");
    if (unavailable) {
      expect(result.status).toBe("degraded");
    } else {
      expect(result.status).toBe("ok");
    }
  });

  test("unavailable dependencies include an error message without leaking credentials", () => {
    for (const dep of result.dependencies) {
      if (dep.status === "unavailable") {
        expect(typeof dep.error).toBe("string");
        // Connection strings with credentials must never appear in errors.
        expect(dep.error).not.toMatch(/postgres:\/\/[^:]+:[^@]+@/);
        expect(dep.error).not.toMatch(/redis:\/\/[^:]+:[^@]+@/);
      }
    }
  });
});
