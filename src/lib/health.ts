import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import { checkPrisma } from "./prisma.js";
import { checkRedis } from "./redis.js";

/**
 * Health and readiness logic.
 *
 * - Liveness (/healthz): the process is up and able to serve. Always 200
 *   while the event loop runs.
 * - Readiness (/readyz): reports per-dependency status (Postgres, Redis).
 *   The app starts even when dependencies are down; readiness reports them
 *   as unavailable with HTTP 503 so orchestrators can gate traffic.
 *
 * Clients are injected by the composition root; this module never constructs
 * or looks up a process-wide connection.
 */

export type DependencyStatus = {
  name: "postgres" | "redis";
  status: "ok" | "unavailable";
  latencyMs?: number;
  error?: string;
};

export type ReadinessReport = {
  status: "ok" | "degraded";
  dependencies: DependencyStatus[];
};

export type HealthDependencies = {
  prisma: PrismaClient;
  redis: Redis;
};

export async function checkDependencies(deps: HealthDependencies): Promise<ReadinessReport> {
  const results = await Promise.all([checkPrisma(deps.prisma), checkRedis(deps.redis)]);

  const dependencies: DependencyStatus[] = [
    { name: "postgres", ...results[0] },
    { name: "redis", ...results[1] },
  ];

  const allOk = dependencies.every((dep) => dep.status === "ok");
  return { status: allOk ? "ok" : "degraded", dependencies };
}
