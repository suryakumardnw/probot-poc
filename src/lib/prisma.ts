import { PrismaClient } from "@prisma/client";
import type { Env } from "../config/env.js";

/**
 * PostgreSQL connectivity via Prisma.
 *
 * This module is a factory only: bootstrap constructs exactly one client per
 * process and injects it into repositories and services. Prisma connects
 * lazily on first query, so a missing/unreachable Postgres does NOT crash
 * startup — callers use `checkPrisma()` (readiness endpoint) and handle the
 * failure themselves.
 */

export type PrismaConnection = Pick<Env, "DATABASE_URL">;

export function createPrisma(env: PrismaConnection): PrismaClient {
  return new PrismaClient({
    datasourceUrl: env.DATABASE_URL,
    log: [], // We route errors through our own logger; never log the URL.
  });
}

export type DependencyCheck = {
  status: "ok" | "unavailable";
  latencyMs?: number;
  error?: string;
};

/** Check PostgreSQL connectivity. Never throws. */
export async function checkPrisma(prisma: PrismaClient): Promise<DependencyCheck> {
  const started = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { status: "ok", latencyMs: Date.now() - started };
  } catch (error) {
    return {
      status: "unavailable",
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Disconnect on shutdown. Never throws. */
export async function disconnectPrisma(prisma: PrismaClient): Promise<void> {
  try {
    await prisma.$disconnect();
  } catch {
    // Ignore shutdown errors.
  }
}
