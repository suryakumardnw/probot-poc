import "dotenv/config";
import http from "node:http";
import { createNodeMiddleware, createProbot, type Probot } from "probot";
import { z } from "zod";
import { createAdminApi, isAdminConfigured } from "./admin/api.js";
import { createAdminPanel } from "./admin/panel.js";
import { loadEnv } from "./config/env.js";
import { adminErrorEnvelopeSchema } from "./contracts/admin.js";
import { ERROR_CODES } from "./contracts/errors.js";
import { ingestOutcomeSchema } from "./contracts/queue.js";
import { getReviewStatus, ingestManualReview, ManualIngestionError } from "./ingestion/orchestrator.js";
import { checkDependencies } from "./lib/health.js";
import { createLogger } from "./lib/logger.js";
import { getPrisma, disconnectPrisma } from "./lib/prisma.js";
import { disconnectRedis, getRedis } from "./lib/redis.js";
import { registerGracefulShutdown } from "./lib/shutdown.js";
import { metricsHandler } from "./observability/metrics-endpoint.js";
import { toErrorLogPayload, toHttpEnvelope } from "./platform/http/error-mapper.js";
import appFn from "./index.js";

/**
 * Probot application entry point.
 *
 * Responsibilities:
 * - Serve GitHub webhooks through Probot's middleware.
 * - Serve /healthz (liveness) and /readyz (readiness) endpoints.
 * - Serve the manual review ingestion API (POST /api/reviews) and review
 *   status (GET /api/reviews/:id). This milestone intentionally ships the
 *   ingestion API without authentication (development/PoC only; see §15 for
 *   the hardening backlog — auth is a later ticket).
 * - Degrade gracefully when GitHub App credentials or dependencies are
 *   unavailable: the process starts, health passes, readiness reports the
 *   state of each dependency.
 */

const env = loadEnv();
const logger = createLogger(env);

// Touch Prisma/Redis clients early so connections begin immediately.
getPrisma(env);
getRedis(env);

/**
 * Decode GITHUB_PRIVATE_KEY_BASE64 (single-line, base64-encoded PEM) into
 * PRIVATE_KEY. Base64 is the deployment-friendly form: PEMs are multiline and
 * many platforms (e.g. Dokploy env tabs) round-trip single-line values more
 * reliably than quoted multiline ones.
 */
function materializePrivateKeyFromBase64(): void {
  const base64 = process.env.GITHUB_PRIVATE_KEY_BASE64;
  if (!base64 || process.env.PRIVATE_KEY || process.env.PRIVATE_KEY_PATH) {
    return;
  }
  try {
    const pem = Buffer.from(base64.replace(/\s+/g, ""), "base64").toString("utf8");
    if (pem.includes("-----BEGIN")) {
      process.env.PRIVATE_KEY = pem;
    }
  } catch {
    // Invalid base64 — fall through; the missing-credential warning below
    // surfaces the problem without leaking any key material.
  }
}
materializePrivateKeyFromBase64();

function maybeCreateProbot(): Probot | undefined {
  // Probot requires APP_ID, PRIVATE_KEY and WEBHOOK_SECRET. When they are
  // absent (e.g. local dev without a GitHub App), run HTTP-only so health
  // and readiness endpoints remain available.
  if (!process.env.APP_ID || (!process.env.PRIVATE_KEY && !process.env.PRIVATE_KEY_PATH)) {
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
    },
  });
}

const probot = maybeCreateProbot();

// Admin API (ticket 10). The handler reports 503 (in the admin error envelope)
// when the OAuth app + session secret + org are not configured; the server
// dispatch below keeps that same envelope without invoking the handler.
const adminApi = createAdminApi({
  env,
  prisma: getPrisma(env),
  logger,
});

// Server-rendered admin HTML panel (ticket 14). Same session/CSRF primitives
// as the admin API; dispatched AFTER /api/admin/* so the JSON API keeps
// precedence for its paths.
const adminPanel = createAdminPanel({
  env,
  prisma: getPrisma(env),
  logger,
});
const probotMiddlewarePromise = probot ? createNodeMiddleware(appFn, { probot, webhooksPath: "/" }) : undefined;

async function handleReadiness(res: http.ServerResponse): Promise<void> {
  const report = await checkDependencies();
  const statusCode = report.status === "ok" ? 200 : 503;
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(report));
  logger.info({ ...report }, "Readiness check");
}

const manualReviewBodySchema = z.object({
  repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/, "must be 'owner/repo'"),
  pullRequestNumber: z.number().int().min(1).max(1_000_000),
  headSha: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/i, "must be a git SHA (7-40 hex chars)")
    .optional(),
  /** Review type (§4.1); omitted → github.defaultReviewType (handbook). */
  reviewType: z.enum(["standard", "skill", "handbook"]).optional(),
});

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

async function handleManualIngestion(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
    if (chunks.reduce((n, c) => n + c.length, 0) > 64 * 1024) {
      return sendJson(res, 413, { error: "request body too large" });
    }
  }
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return sendJson(res, 400, { error: "request body must be JSON" });
  }

  const parsed = manualReviewBodySchema.safeParse(raw);
  if (!parsed.success) {
    return sendJson(res, 400, {
      error: "invalid request",
      details: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  try {
    const result = await ingestManualReview(parsed.data);
    // The outcome crosses the HTTP boundary: parse it against the queue
    // contract instead of trusting the in-process value's type alone.
    const outcome = ingestOutcomeSchema.parse(result.outcome);
    const status = outcome === "created" ? 202 : 200;
    sendJson(res, status, { ...result, outcome });
  } catch (error) {
    if (error instanceof ManualIngestionError) {
      return sendJson(res, 404, { error: error.message });
    }
    logger.error({ err: error }, "Manual review ingestion failed");
    sendJson(res, 500, { error: "manual ingestion failed" });
  }
}

async function handleReviewStatus(res: http.ServerResponse, reviewId: string): Promise<void> {
  try {
    const report = await getReviewStatus(reviewId);
    if (!report) {
      return sendJson(res, 404, { error: "review not found" });
    }
    sendJson(res, 200, report);
  } catch (error) {
    logger.error({ err: error }, "Review status lookup failed");
    sendJson(res, 500, { error: "status lookup failed" });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (url.pathname === "/healthz") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (url.pathname === "/readyz") {
    void handleReadiness(res);
    return;
  }

  // Ticket 12 §16.2: Prometheus metrics exposition.
  if (url.pathname === "/metrics") {
    metricsHandler(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/reviews") {
    void handleManualIngestion(req, res);
    return;
  }

  const reviewStatusMatch = /^\/api\/reviews\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
  const reviewId = reviewStatusMatch?.[1];
  if (req.method === "GET" && reviewId !== undefined) {
    void handleReviewStatus(res, reviewId);
    return;
  }

  // Admin API (ticket 10, §14.2 + §15): OAuth, sessions, CSRF, config
  // management, review status. Handles every /api/admin/* path; falls through
  // to other handlers otherwise.
  if (url.pathname.startsWith("/api/admin")) {
    if (isAdminConfigured(env)) {
      void adminApi(req, res).catch((error) => {
        const envelope = toHttpEnvelope(error);
        logger.error(toErrorLogPayload(error, "http"), "Admin API handler crashed");
        if (!res.headersSent) {
          res.statusCode = envelope.statusCode;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(envelope.body));
        } else if (!res.writableEnded) {
          res.end();
        }
      });
    } else {
      const envelope = adminErrorEnvelopeSchema.parse({
        code: ERROR_CODES.ADMIN_NOT_CONFIGURED,
        message: "admin API is not configured",
        statusCode: 503,
      });
      res.statusCode = envelope.statusCode;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(envelope));
    }
    return;
  }

  // Admin HTML panel (ticket 14): GET/POST /admin and /admin/:section, plus
  // the authenticated /logs shortcut to the Dozzle UI.
  // Dispatched after the admin API so /api/admin/* keeps precedence.
  if (
    url.pathname === "/admin" ||
    url.pathname.startsWith("/admin/") ||
    url.pathname === "/logs" ||
    url.pathname === "/logs/"
  ) {
    void adminPanel(req, res).catch((error) => {
      logger.error({ err: error }, "Admin panel handler crashed");
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Internal server error");
    });
    return;
  }

  if (probotMiddlewarePromise) {
    void probotMiddlewarePromise
      .then((middleware) => {
        middleware(req, res);
      })
      .catch((error) => {
        logger.error({ err: error }, "Probot middleware failed to initialize");
        res.statusCode = 500;
        res.end("Internal server error");
      });
    return;
  }

  res.statusCode = 503;
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({
      status: "unavailable",
      error: "GitHub App not configured",
    }),
  );
});

server.listen(env.PORT, env.HOST, () => {
  logger.info(
    {
      port: env.PORT,
      host: env.HOST,
      webhooks: Boolean(probotMiddlewarePromise),
    },
    "Probot application started",
  );
});

registerGracefulShutdown(logger, [
  { name: "http-server", run: () => new Promise<void>((resolve) => server.close(() => resolve())) },
  { name: "redis", run: disconnectRedis },
  { name: "postgres", run: disconnectPrisma },
  { name: "logger-flush", run: async () => void logger.flush?.() },
]);
