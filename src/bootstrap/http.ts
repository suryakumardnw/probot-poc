import http from "node:http";
import { z } from "zod";
import { isAdminConfigured } from "../admin/api.js";
import type { Env } from "../config/env.js";
import { adminErrorEnvelopeSchema } from "../contracts/admin.js";
import { ERROR_CODES } from "../contracts/errors.js";
import { ingestOutcomeSchema } from "../contracts/queue.js";
import type { ReadinessReport } from "../lib/health.js";
import { ManualIngestionError, type IngestionServices } from "../modules/ingestion/index.js";
import { metricsHandler } from "../observability/metrics-endpoint.js";
import { toErrorLogPayload, toHttpEnvelope } from "../platform/http/error-mapper.js";
import type { Logger } from "../ports/logger.js";

/**
 * HTTP surface composition (ARCHITECTURE.md §13, §14.2, §16.2).
 *
 * Mounts webhooks, health/readiness, metrics, the manual ingestion API and the
 * admin API/panel onto one Node server. Every dependency is injected by
 * `bootstrapServer`; this module starts no listeners and constructs no
 * clients.
 */

export type AdminRequestHandler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>;

export interface HttpServerDeps {
  env: Env;
  logger: Logger;
  ingestion: Pick<IngestionServices, "ingestManualReview" | "getReviewStatus">;
  adminApi: AdminRequestHandler;
  adminPanel: AdminRequestHandler;
  /** Probot's Node middleware, when GitHub App credentials are configured. */
  probotMiddlewarePromise?: Promise<(req: http.IncomingMessage, res: http.ServerResponse) => void>;
  /** Readiness probe over the injected Postgres/Redis clients. */
  checkDependencies: () => Promise<ReadinessReport>;
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

export function createHttpServer(deps: HttpServerDeps): http.Server {
  const { env, logger, ingestion, adminApi, adminPanel, probotMiddlewarePromise } = deps;

  async function handleReadiness(res: http.ServerResponse): Promise<void> {
    const report = await deps.checkDependencies();
    const statusCode = report.status === "ok" ? 200 : 503;
    res.statusCode = statusCode;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(report));
    logger.info({ ...report }, "Readiness check");
  }

  async function handleManualIngestion(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
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
      const result = await ingestion.ingestManualReview(parsed.data);
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
      const report = await ingestion.getReviewStatus(reviewId);
      if (!report) {
        return sendJson(res, 404, { error: "review not found" });
      }
      sendJson(res, 200, report);
    } catch (error) {
      logger.error({ err: error }, "Review status lookup failed");
      sendJson(res, 500, { error: "status lookup failed" });
    }
  }

  return http.createServer((req, res) => {
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
}
