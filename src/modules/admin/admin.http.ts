import type { IncomingMessage, ServerResponse } from "node:http";
import { ERROR_CODES } from "../../contracts/errors.js";
import { toErrorLogPayload } from "../../platform/http/error-mapper.js";
import { ConfigValidationError } from "../../ports/review-config.js";
import {
  AppError,
  AuthError,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  ValidationError,
} from "../../shared/errors/index.js";
import { handleGithubLogin, handleLogout, handleOAuthCallback, handleSession } from "./admin.auth.http.js";
import {
  handleDryRunConfig,
  handleReadConfig,
  handleReloadConfig,
  handleRollbackConfig,
  handleUpdateConfig,
  handleValidateConfig,
} from "./admin.config.http.js";
import {
  BodyTooLargeError,
  InvalidBodyError,
  headerValue,
  sendError,
  sendOperationalError,
} from "./admin.http.helpers.js";
import {
  handleCompareReviews,
  handleListReviews,
  handleReviewDetail,
  handleTriggerReview,
} from "./admin.reviews.http.js";
import { createAdminService } from "./admin.service.js";
import type { AdminApiDeps, AdminRequestContext } from "./admin.types.js";
import { CSRF_HEADER, verifyCsrfToken } from "./auth/csrf.js";
import { GithubOauthError, isAdminConfigured } from "./auth/github-oauth.js";
import { getSessionFromCookie, readSessionCookie } from "./auth/session.js";
import { checkRateLimit, clientIpOf } from "./rate-limit.js";

/**
 * Admin API (ticket 10, §14.2 + §15): GitHub OAuth authentication, membership
 * verification, admin role policy (separate from membership), session/CSRF
 * handling, configuration management endpoints, review status endpoints and
 * audit logging.
 *
 * This module owns the HTTP pipeline and route table only; use cases live in
 * `admin.service.ts`, OAuth/session/CSRF primitives in `auth/`, and each route
 * family in its own handler module.
 */

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function createAdminApi(deps: AdminApiDeps): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const env = deps.env;
  const now = deps.now ?? Date.now;
  const configured = isAdminConfigured(env);
  const service = createAdminService({
    audit: deps.audit,
    ingestion: deps.ingestion,
    config: deps.config,
    logger: deps.logger,
  });
  if (!configured) {
    deps.logger.warn(
      {
        missing: [
          !env.ADMIN_OAUTH_CLIENT_ID && "ADMIN_OAUTH_CLIENT_ID",
          !env.ADMIN_OAUTH_CLIENT_SECRET && "ADMIN_OAUTH_CLIENT_SECRET",
          !env.SESSION_SECRET && "SESSION_SECRET",
          !env.ADMIN_GITHUB_ORG && "ADMIN_GITHUB_ORG",
        ].filter(Boolean),
      },
      "Admin API not configured; /api/admin/* returns 503",
    );
  }

  return async function handleAdminRequest(req, res): Promise<boolean> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (!url.pathname.startsWith("/api/admin")) {
      return false;
    }
    const ctx: AdminRequestContext = { req, res, url, deps, env, ip: clientIpOf(req), now };

    // Rate limiting applies to every admin endpoint (§14.2), including the
    // OAuth endpoints so they cannot be used to brute-force accounts.
    const limit = checkRateLimit(`admin:${ctx.ip}`, { limitPerMinute: env.ADMIN_RATE_LIMIT_PER_MINUTE, now });
    res.setHeader("X-RateLimit-Limit", String(env.ADMIN_RATE_LIMIT_PER_MINUTE));
    res.setHeader("X-RateLimit-Remaining", String(limit.remaining));
    if (!limit.allowed) {
      res.setHeader("Retry-After", String(limit.retryAfterSeconds));
      sendError(
        res,
        new RateLimitError("rate limit exceeded", { details: { retryAfterSeconds: limit.retryAfterSeconds } }),
      );
      return true;
    }

    if (!configured) {
      sendOperationalError(res, 503, ERROR_CODES.ADMIN_NOT_CONFIGURED, "admin API is not configured");
      return true;
    }

    try {
      await route(ctx);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        sendError(
          res,
          new AppError("request body too large", {
            code: ERROR_CODES.ADMIN_BODY_TOO_LARGE,
            statusCode: 413,
          }),
        );
        return true;
      }
      if (error instanceof InvalidBodyError) {
        sendError(res, new ValidationError("request body must be JSON", { code: ERROR_CODES.ADMIN_INVALID_BODY }));
        return true;
      }
      if (error instanceof GithubOauthError) {
        // GitHub's own error descriptions are safe to surface; they never
        // include the client secret.
        sendOperationalError(res, 502, ERROR_CODES.GITHUB_OAUTH_FAILED, "github oauth failure", {
          providerCode: error.code,
          description: error.message,
        });
        return true;
      }
      if (error instanceof ConfigValidationError) {
        sendError(res, new ValidationError(error.message, { code: ERROR_CODES.CONFIG_INVALID }));
        return true;
      }
      // Never log unknown error text or stacks: they can carry SQL, secrets, or
      // filesystem paths. The shared log projection keeps code/status only.
      deps.logger.error(toErrorLogPayload(error, "http"), "Admin API request failed");
      sendError(res, error);
    }
    return true;
  };

  async function route(ctx: AdminRequestContext): Promise<void> {
    const { req, res, url } = ctx;
    const path = url.pathname.replace(/\/+$/, "") || "/";

    // --- Authentication endpoints (no session required) --------------------

    if (req.method === "GET" && path === "/api/admin/auth/github/login") {
      handleGithubLogin(ctx);
      return;
    }

    if (req.method === "GET" && path === "/api/admin/auth/github/callback") {
      await handleOAuthCallback(ctx);
      return;
    }

    // --- Everything below requires a session -------------------------------

    const session = getSessionFromCookie(readSessionCookie(req.headers.cookie), env, now());

    if (req.method === "POST" && path === "/api/admin/auth/logout") {
      await handleLogout(ctx, session);
      return;
    }

    if (req.method === "GET" && path === "/api/admin/session") {
      handleSession(ctx, session);
      return;
    }

    if (!session) {
      sendError(res, new AuthError("authentication required"));
      return;
    }

    // --- CSRF protection on every unsafe method (§14.2) --------------------

    if (UNSAFE_METHODS.has(req.method ?? "") && !verifyCsrfToken(session, headerValue(req.headers[CSRF_HEADER]))) {
      sendError(res, new ForbiddenError("csrf validation failed", { code: ERROR_CODES.ADMIN_CSRF_FAILED }));
      return;
    }

    // --- Configuration management (§11.5, §15) -----------------------------

    if (req.method === "GET" && path === "/api/admin/config") {
      await handleReadConfig(ctx, service);
      return;
    }

    if (req.method === "PUT" && path === "/api/admin/config") {
      await handleUpdateConfig(ctx, service, session);
      return;
    }

    if (req.method === "POST" && path === "/api/admin/config/validate") {
      await handleValidateConfig(ctx, service);
      return;
    }

    if (req.method === "POST" && path === "/api/admin/config/dry-run") {
      await handleDryRunConfig(ctx, service);
      return;
    }

    if (req.method === "POST" && path === "/api/admin/config/reload") {
      await handleReloadConfig(ctx, service, session);
      return;
    }

    if (req.method === "POST" && path === "/api/admin/config/rollback") {
      await handleRollbackConfig(ctx, service, session);
      return;
    }

    // --- Review status (§15) -----------------------------------------------

    if (req.method === "GET" && path === "/api/admin/reviews") {
      await handleListReviews(ctx, service);
      return;
    }

    // --- Review types (§4.1): on-demand triggering + per-type comparison ---

    if (req.method === "POST" && path === "/api/admin/reviews/trigger") {
      await handleTriggerReview(ctx, service, session);
      return;
    }

    if (req.method === "GET" && path === "/api/admin/reviews/compare") {
      await handleCompareReviews(ctx, service);
      return;
    }

    const reviewMatch = /^\/api\/admin\/reviews\/([A-Za-z0-9_-]+)$/.exec(path);
    const reviewId = reviewMatch?.[1];
    if (req.method === "GET" && reviewId !== undefined) {
      await handleReviewDetail(ctx, service, reviewId);
      return;
    }

    sendError(res, new NotFoundError("not found", { code: ERROR_CODES.ADMIN_ROUTE_NOT_FOUND }));
  }
}
