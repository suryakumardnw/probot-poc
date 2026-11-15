import { Redis } from "ioredis";
import type { Env } from "./config/env.js";
import type { DependencyCheck } from "./db/prisma.js";

/**
 * Redis connectivity via ioredis.
 *
 * This module is a factory only: bootstrap constructs exactly one shared
 * client per process and injects it wherever readiness is checked. Connections
 * must degrade gracefully: the client is created with offline tolerance so a
 * missing Redis does not crash the process, and `checkRedis()` reports status
 * for the readiness endpoint.
 */

export type RedisConnection = Pick<Env, "REDIS_URL">;

/** The concrete Redis client, so callers never import the vendor type. */
export type RedisClient = Redis;

export function createRedis(env: RedisConnection): RedisClient {
  const client = new Redis(env.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    // Bounded retry loop; the readiness endpoint surfaces the failure.
    retryStrategy: (times: number) => Math.min(times * 500, 5000),
    enableOfflineQueue: false,
  });
  client.on("error", () => {
    // ioredis emits 'error' on connection failures; swallow here so the
    // process never crashes on an unreachable Redis. Callers observe
    // state via checkRedis().
  });
  void client.connect().catch(() => {
    // Handled via checkRedis(); never crash the process here.
  });
  return client;
}

/**
 * Wait up to `timeoutMs` for the initial Redis connection. Resolves even if
 * the connection never succeeds (graceful degradation); callers observe the
 * actual state via checkRedis().
 */
export async function waitRedisReady(client: Redis, timeoutMs = 5000): Promise<void> {
  if (client.status === "ready") {
    return;
  }
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      client.off("ready", onReady);
      resolve();
    };
    const onReady = () => finish();
    const timer = setTimeout(finish, timeoutMs);
    timer.unref();
    client.once("ready", onReady);
  });
}

/** Check Redis connectivity. Never throws. */
export async function checkRedis(client: Redis): Promise<DependencyCheck> {
  const started = Date.now();
  try {
    const pong = await client.ping();
    if (pong !== "PONG") {
      throw new Error(`unexpected PING response: ${pong}`);
    }
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
export async function disconnectRedis(client: Redis): Promise<void> {
  try {
    await client.quit();
  } catch {
    // Connection may already be closed.
  }
}
