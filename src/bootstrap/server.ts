import type http from "node:http";
import { createNodeMiddleware, createProbot, type Probot } from "probot";
import { createApp } from "../index.js";
import { createAdminApi, createAdminPanel, createPrismaAuditRepository } from "../modules/admin/index.js";
import { loadEnv, readEnv, readProcessEnv, type Env } from "../platform/config/env.js";
import { checkPrisma, disconnectPrisma } from "../platform/db/prisma.js";
import { createGithubOAuthClient } from "../platform/github/oauth-client.js";
import { checkDependencies } from "../platform/health.js";
import { createLogger, type PlatformLogger } from "../platform/logger.js";
import { disconnectRedis } from "../platform/redis.js";
import { registerGracefulShutdown } from "../platform/shutdown.js";
import type { Logger } from "../ports/logger.js";
import {
  createConfigStore,
  createIngestionModule,
  createPlatformClients,
  createTriageDependencies,
} from "./clients.js";
import { createHttpServer } from "./http.js";

/**
 * Server composition root.
 *
 * Builds the complete HTTP graph exactly once:
 *   env → logger → Postgres/Redis/queue clients → repositories → services
 *   → HTTP handlers → server.
 *
 * `bootstrapServer` additionally starts the listener and registers graceful
 * shutdown. `createServerRuntime` is the same graph without listening, used by
 * the bootstrap smoke test.
 */

export interface ServerRuntime {
  server: http.Server;
  logger: PlatformLogger;
  listen(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Decode GITHUB_PRIVATE_KEY_BASE64 (single-line, base64-encoded PEM) when the
 * deployment uses that form. Base64 is the deployment-friendly form: PEMs are
 * multiline and many platforms (e.g. Dokploy env tabs) round-trip single-line
 * values more reliably than quoted multiline ones.
 *
 * The decoded key is passed to Probot as an override; this function never
 * mutates the process environment.
 */
function privateKeyFromBase64(processEnv: NodeJS.ProcessEnv): string | undefined {
  const base64 = processEnv.GITHUB_PRIVATE_KEY_BASE64;
  if (!base64 || processEnv.PRIVATE_KEY || processEnv.PRIVATE_KEY_PATH) {
    return undefined;
  }
  try {
    const pem = Buffer.from(base64.replace(/\s+/g, ""), "base64").toString("utf8");
    return pem.includes("-----BEGIN") ? pem : undefined;
  } catch {
    // Invalid base64 — fall through; the missing-credential warning below
    // surfaces the problem without leaking any key material.
    return undefined;
  }
}

function maybeCreateProbot(
  env: Env,
  logger: Logger,
  processEnv: NodeJS.ProcessEnv,
  privateKeyOverride: string | undefined,
): Probot | undefined {
  // Probot requires APP_ID, PRIVATE_KEY and WEBHOOK_SECRET. When they are
  // absent (e.g. local dev without a GitHub App), run HTTP-only so health
  // and readiness endpoints remain available.
  if (!processEnv.APP_ID || (!processEnv.PRIVATE_KEY && !processEnv.PRIVATE_KEY_PATH && !privateKeyOverride)) {
    logger.warn(
      "APP_ID / PRIVATE_KEY not configured; starting without GitHub webhook processing. " +
        "Health and readiness endpoints remain available.",
    );
    return undefined;
  }
  return createProbot({
    overrides: {
      port: env.PORT,
      host: env.HOST,
      ...(privateKeyOverride ? { privateKey: privateKeyOverride } : {}),
    },
  });
}

export async function createServerRuntime(env: Env = loadEnv()): Promise<ServerRuntime> {
  const processEnv = readProcessEnv();
  const logger = createLogger(env);
  const clients = createPlatformClients(env);
  const config = createConfigStore(env);
  const ingestion = createIngestionModule({
    prisma: clients.prisma,
    queue: clients.reviewQueue,
    config,
    logger,
  });

  // Admin API (ticket 10). The handler reports 503 (in the admin error
  // envelope) when the OAuth app + session secret + org are not configured;
  // the server dispatch below keeps that same envelope without invoking the
  // handler.
  const adminApi = createAdminApi({
    env,
    audit: createPrismaAuditRepository(clients.prisma, logger),
    ingestion: ingestion.services,
    config,
    githubOAuth: createGithubOAuthClient(),
    logger,
  });

  // Server-rendered admin HTML panel (ticket 14). Same session/CSRF
  // primitives as the admin API; dispatched AFTER /api/admin/* so the JSON API
  // keeps precedence for its paths.
  const adminPanel = createAdminPanel({
    env,
    audit: createPrismaAuditRepository(clients.prisma, logger),
    config,
    logger,
    devLoginEnabled:
      env.NODE_ENV === "development" && readEnv("ADMIN_DEV_LOGIN") === "1" && Boolean(env.SESSION_SECRET),
  });

  const privateKeyOverride = privateKeyFromBase64(processEnv);
  const probot = maybeCreateProbot(env, logger, processEnv, privateKeyOverride);
  const appFn = createApp({
    ingestion: ingestion.services,
    ingestionRepositories: ingestion.repositories,
    ingestionUnitOfWork: ingestion.unitOfWork,
    triage: createTriageDependencies(),
    config,
  });
  const probotMiddlewarePromise = probot ? createNodeMiddleware(appFn, { probot, webhooksPath: "/" }) : undefined;

  const server = createHttpServer({
    env,
    logger,
    ingestion: ingestion.services,
    adminApi,
    adminPanel,
    ...(probotMiddlewarePromise ? { probotMiddlewarePromise } : {}),
    checkDependencies: () =>
      checkDependencies({ checkDatabase: () => checkPrisma(clients.prisma), redis: clients.redis }),
  });

  async function close(): Promise<void> {
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await clients.reviewQueue.close();
    await disconnectRedis(clients.redis);
    await disconnectPrisma(clients.prisma);
  }

  return {
    server,
    logger,
    async listen(): Promise<void> {
      await new Promise<void>((resolve) => server.listen(env.PORT, env.HOST, resolve));
      logger.info(
        {
          port: env.PORT,
          host: env.HOST,
          webhooks: Boolean(probotMiddlewarePromise),
        },
        "Probot application started",
      );
    },
    close,
  };
}

export async function bootstrapServer(): Promise<void> {
  const runtime = await createServerRuntime();
  await runtime.listen();

  registerGracefulShutdown(runtime.logger, [
    { name: "http-server", run: runtime.close },
    { name: "logger-flush", run: async () => void runtime.logger.flush?.() },
  ]);
}
