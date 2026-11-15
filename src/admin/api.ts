import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { z } from "zod";
import type { Env } from "../config/env.js";
import {
  adminErrorEnvelopeSchema,
  compareQuerySchema,
  compareReviewsResponseSchema,
  configDryRunResponseSchema,
  configReadResponseSchema,
  configReloadResponseSchema,
  configRollbackResponseSchema,
  configUpdateBodySchema,
  configUpdateResponseSchema,
  configValidateResponseSchema,
  loginResponseSchema,
  logoutResponseSchema,
  oauthCallbackQuerySchema,
  reviewListQuerySchema,
  reviewListResponseSchema,
  reviewStatusResponseSchema,
  reviewTriggerResponseSchema,
  sessionResponseSchema,
  triggerReviewBodySchema,
  type AdminErrorEnvelope,
} from "../contracts/admin.js";
import { ERROR_CODES } from "../contracts/errors.js";
import {
  ManualIngestionError,
  type IngestionReadService,
  type ReviewComparisonInput,
  type ReviewTypeValue,
} from "../modules/ingestion/index.js";
import { summarizeKnowledgeMetrics, summarizeKnowledgeSnapshot } from "../modules/knowledge/index.js";
import { toErrorLogPayload, toHttpEnvelope } from "../platform/http/error-mapper.js";
import { ConfigValidationError, type ReviewConfigStore } from "../ports/review-config.js";
import {
  AppError,
  AuthError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  ValidationError,
  redactDetails,
  redactSecrets,
} from "../shared/errors/index.js";
import type { AuditAction, AuditMetadata, AuditRepository } from "./audit.repository.js";
import {
  buildAuthorizeUrl,
  exchangeOAuthCode,
  fetchGithubUser,
  fetchOrgMembership,
  GithubOauthError,
} from "./github-client.js";
import { checkRateLimit, clientIpOf } from "./rate-limit.js";
import {
  CSRF_HEADER,
  buildClearCookieHeader,
  buildSetCookieHeader,
  createSession,
  destroySession,
  getSessionFromCookie,
  readSessionCookie,
  verifyCsrfToken,
  type AdminSession,
} from "./session.js";

/**
 * Admin API (ticket 10, §14.2 + §15): GitHub OAuth authentication, membership
 * verification, admin role policy (separate from membership), session/CSRF
 * handling, configuration management endpoints, review status endpoints and
 * audit logging.
 *
 * The GitHub App installation identity is never used here: admin identity is
 * the OAuth user identity only.
 */

export interface AdminApiDeps {
  env: Env;
  audit: AuditRepository;
  /** Ingestion public service: review status, listing, comparison, manual trigger. */
  ingestion: IngestionReadService;
  /** Review config port: read/validate/update happens behind it. */
  config: ReviewConfigStore;
  logger: {
    info: (obj: object, msg: string) => void;
    warn: (obj: object, msg: string) => void;
    error: (obj: object, msg: string) => void;
  };
  now?: () => number;
}

export function isAdminConfigured(env: Env): boolean {
  return Boolean(
    env.ADMIN_OAUTH_CLIENT_ID && env.ADMIN_OAUTH_CLIENT_SECRET && env.SESSION_SECRET && env.ADMIN_GITHUB_ORG,
  );
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function sendJson<T>(
  res: ServerResponse,
  status: number,
  schema: z.ZodType<T>,
  body: T,
  headers: Record<string, string> = {},
): void {
  // Parse before writing anything: a response that violates its own contract
  // must fail the request (and map to the internal envelope) instead of
  // leaking an unvalidated shape.
  const payload = schema.parse(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  for (const [name, value] of Object.entries(headers)) {
    res.setHeader(name, value);
  }
  res.end(JSON.stringify(payload));
}

/** Map any error through the shared HTTP projection and send the envelope. */
function sendError(res: ServerResponse, error: unknown, headers: Record<string, string> = {}): void {
  const envelope = toHttpEnvelope(error);
  sendJson(res, envelope.statusCode, adminErrorEnvelopeSchema, envelope.body, headers);
}

/**
 * A known operational 5xx that must keep its status. The shared mapper
 * intentionally collapses caller-authored 5xx text to a generic 500, so these
 * few envelopes are built from literal, developer-authored messages only.
 */
function sendOperationalError(
  res: ServerResponse,
  statusCode: number,
  code: string,
  message: string,
  details?: AdminErrorEnvelope["details"],
): void {
  const body = adminErrorEnvelopeSchema.parse({
    code: redactSecrets(code),
    message: redactSecrets(message),
    statusCode,
    ...(details === undefined ? {} : { details: redactDetails(details) }),
  });
  sendJson(res, statusCode, adminErrorEnvelopeSchema, body);
}

/** Turn a boundary Zod failure into the standard 400 envelope. */
function sendValidationFailure(res: ServerResponse, error: z.ZodError): void {
  sendError(
    res,
    new ValidationError("invalid request", {
      code: ERROR_CODES.ADMIN_INVALID_REQUEST,
      details: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    }),
  );
}

function parseQuery<T>(schema: z.ZodType<T>, url: URL) {
  return schema.safeParse(Object.fromEntries(url.searchParams));
}

async function readJsonBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
    if (chunks.reduce((n, c) => n + c.length, 0) > maxBytes) {
      throw new BodyTooLargeError();
    }
  }
  const raw = Buffer.concat(chunks).toString("utf8") || "{}";
  try {
    return JSON.parse(raw);
  } catch {
    throw new InvalidBodyError();
  }
}

export class BodyTooLargeError extends Error {
  constructor() {
    super("request body too large");
  }
}
export class InvalidBodyError extends Error {
  constructor() {
    super("request body must be JSON");
  }
}

// ---------------------------------------------------------------------------
// OAuth state store (CSRF protection for the authorize redirect itself)
// ---------------------------------------------------------------------------

interface PendingState {
  expiresAt: number;
}

const oauthStates = new Map<string, PendingState>();
const STATE_TTL_MS = 10 * 60 * 1000;

export function clearOauthStates(): void {
  oauthStates.clear();
}

function createOauthState(now: number): string {
  if (oauthStates.size > 1000) {
    for (const [key, pending] of oauthStates) {
      if (pending.expiresAt <= now) {
        oauthStates.delete(key);
      }
    }
  }
  const state = randomBytes(24).toString("base64url");
  oauthStates.set(state, { expiresAt: now + STATE_TTL_MS });
  return state;
}

/** Consume a state value: valid only once, only within its TTL. */
function consumeOauthState(state: string | null, now: number): boolean {
  if (!state) {
    return false;
  }
  const pending = oauthStates.get(state);
  oauthStates.delete(state); // single use
  return Boolean(pending && pending.expiresAt > now);
}

// ---------------------------------------------------------------------------
// Admin role policy (§14.2: separate from membership)
// ---------------------------------------------------------------------------

function parseLoginAllowlist(env: Env): string[] {
  return env.ADMIN_GITHUB_LOGINS.split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseAdminRoles(env: Env): string[] {
  return env.ADMIN_ORG_ADMIN_ROLES.split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

export interface AdminAuthorization {
  allowed: boolean;
  rolePolicy: "allowlist" | "org-role" | null;
  reason: string;
}

/**
 * Decide admin authorization for an authenticated member. Membership in
 * ADMIN_GITHUB_ORG is the gate; this policy decides WHO among members is an
 * administrator: a configured login allowlist wins, otherwise the
 * organization role must be one of ADMIN_ORG_ADMIN_ROLES.
 */
export function authorizeAdmin(
  env: Env,
  user: { login: string },
  membership: { role: "admin" | "member"; state: "active" | "pending" } | null,
): AdminAuthorization {
  if (!membership) {
    return { allowed: false, rolePolicy: null, reason: "not an organization member" };
  }
  if (membership.state === "pending") {
    return { allowed: false, rolePolicy: null, reason: "organization membership is pending" };
  }
  const allowlist = parseLoginAllowlist(env);
  if (allowlist.length > 0) {
    const allowed = allowlist.includes(user.login);
    return {
      allowed,
      rolePolicy: "allowlist",
      reason: allowed ? "allowlisted administrator" : "not on the admin allowlist",
    };
  }
  const roles = parseAdminRoles(env);
  const allowed = roles.includes(membership.role);
  return {
    allowed,
    rolePolicy: "org-role",
    reason: allowed
      ? `organization role '${membership.role}' grants admin`
      : `organization role '${membership.role}' does not grant admin`,
  };
}

// ---------------------------------------------------------------------------
// Request pipeline
// ---------------------------------------------------------------------------

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

interface AdminRequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  deps: AdminApiDeps;
  env: Env;
  ip: string;
}

export function createAdminApi(deps: AdminApiDeps): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const env = deps.env;
  const now = deps.now ?? Date.now;
  const configured = isAdminConfigured(env);
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
    const ctx: AdminRequestContext = { req, res, url, deps, env, ip: clientIpOf(req as never) };

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

  // -------------------------------------------------------------------------

  async function audit(actor: string, action: AuditAction, resource: string, metadata?: AuditMetadata): Promise<void> {
    await deps.audit.record({ actor, action, resource, metadata });
  }

  async function route(ctx: AdminRequestContext): Promise<void> {
    const { req, res, url } = ctx;
    const path = url.pathname.replace(/\/+$/, "") || "/";

    // --- Authentication endpoints (no session required) --------------------

    if (req.method === "GET" && path === "/api/admin/auth/github/login") {
      const state = createOauthState(now());
      const authorizeUrl = buildAuthorizeUrl(env, state);
      res.statusCode = 302;
      res.setHeader("Location", authorizeUrl);
      res.end();
      return;
    }

    if (req.method === "GET" && path === "/api/admin/auth/github/callback") {
      await handleOAuthCallback(ctx);
      return;
    }

    // --- Everything below requires a session -------------------------------

    const session = getSessionFromCookie(readSessionCookie(req.headers.cookie), env, now());

    if (req.method === "POST" && path === "/api/admin/auth/logout") {
      if (!session) {
        sendError(res, new AuthError("authentication required"));
        return;
      }
      if (!verifyCsrfToken(session, headerValue(req.headers[CSRF_HEADER]))) {
        sendError(res, new ForbiddenError("csrf validation failed", { code: ERROR_CODES.ADMIN_CSRF_FAILED }));
        return;
      }
      destroySession(session.id);
      await audit(session.login, "admin.logout", "admin_session", {});
      sendJson(res, 200, logoutResponseSchema, { ok: true }, { "Set-Cookie": buildClearCookieHeader(env) });
      return;
    }

    if (req.method === "GET" && path === "/api/admin/session") {
      if (!session) {
        sendError(res, new AuthError("authentication required"));
        return;
      }
      sendJson(res, 200, sessionResponseSchema, {
        authenticated: true,
        user: { login: session.login, id: session.githubUserId },
        rolePolicy: session.rolePolicy,
        csrfToken: session.csrfToken,
        expiresAt: new Date(session.expiresAt).toISOString(),
      });
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
      await handleReadConfig(ctx);
      return;
    }

    if (req.method === "PUT" && path === "/api/admin/config") {
      await handleUpdateConfig(ctx, session);
      return;
    }

    if (req.method === "POST" && path === "/api/admin/config/validate") {
      await handleValidateConfig(ctx);
      return;
    }

    if (req.method === "POST" && path === "/api/admin/config/dry-run") {
      await handleDryRunConfig(ctx);
      return;
    }

    if (req.method === "POST" && path === "/api/admin/config/reload") {
      await handleReloadConfig(ctx, session);
      return;
    }

    if (req.method === "POST" && path === "/api/admin/config/rollback") {
      await handleRollbackConfig(ctx, session);
      return;
    }

    // --- Review status (§15) -----------------------------------------------

    if (req.method === "GET" && path === "/api/admin/reviews") {
      await handleListReviews(ctx);
      return;
    }

    // --- Review types (§4.1): on-demand triggering + per-type comparison ---

    if (req.method === "POST" && path === "/api/admin/reviews/trigger") {
      await handleTriggerReview(ctx, session);
      return;
    }

    if (req.method === "GET" && path === "/api/admin/reviews/compare") {
      await handleCompareReviews(ctx);
      return;
    }

    const reviewMatch = /^\/api\/admin\/reviews\/([A-Za-z0-9_-]+)$/.exec(path);
    const reviewId = reviewMatch?.[1];
    if (req.method === "GET" && reviewId !== undefined) {
      await handleReviewDetail(res, reviewId);
      return;
    }

    sendError(res, new NotFoundError("not found", { code: ERROR_CODES.ADMIN_ROUTE_NOT_FOUND }));
  }

  // -------------------------------------------------------------------------
  // OAuth callback
  // -------------------------------------------------------------------------

  async function handleOAuthCallback(ctx: AdminRequestContext): Promise<void> {
    const { res } = ctx;
    const query = parseQuery(oauthCallbackQuerySchema, ctx.url);
    const code = query.success ? query.data.code : undefined;
    const state = query.success ? query.data.state : undefined;

    if (!consumeOauthState(state ?? null, now())) {
      await audit("anonymous", "admin.login_denied", "admin_session", { reason: "invalid or expired oauth state" });
      sendError(res, new ValidationError("invalid or expired oauth state"));
      return;
    }
    if (!code) {
      sendError(res, new ValidationError("missing oauth code"));
      return;
    }

    const accessToken = await exchangeOAuthCode(env, code);
    const user = await fetchGithubUser(accessToken);
    const membership = await fetchOrgMembership(env.ADMIN_GITHUB_ORG!, user.login, accessToken);
    const decision = authorizeAdmin(env, user, membership);

    if (!decision.allowed) {
      await audit(user.login, "admin.login_denied", "admin_session", {
        reason: decision.reason,
        rolePolicy: decision.rolePolicy,
      });
      sendError(
        res,
        new ForbiddenError("admin access denied", {
          code: ERROR_CODES.ADMIN_ACCESS_DENIED,
          details: { reason: decision.reason },
        }),
      );
      return;
    }

    const newSession = createSession(user, decision.rolePolicy === "allowlist" ? "allowlist" : "org-role", {
      env,
      now,
    });
    await audit(user.login, "admin.login", "admin_session", { rolePolicy: newSession.rolePolicy });
    deps.logger.info({ login: user.login, rolePolicy: newSession.rolePolicy }, "Admin logged in");
    sendJson(
      res,
      200,
      loginResponseSchema,
      {
        authenticated: true,
        user: { login: user.login, id: user.id },
        rolePolicy: newSession.rolePolicy,
        csrfToken: newSession.csrfToken,
      },
      { "Set-Cookie": buildSetCookieHeader(newSession, env) },
    );
  }

  // -------------------------------------------------------------------------
  // Configuration endpoints
  // -------------------------------------------------------------------------

  async function handleReadConfig(ctx: AdminRequestContext): Promise<void> {
    const loaded = deps.config.load();
    sendJson(ctx.res, 200, configReadResponseSchema, {
      fromLastKnownGood: loaded.fromLastKnownGood,
      hash: loaded.snapshot.hash,
      schemaVersion: loaded.snapshot.schemaVersion,
      configuration: deps.config.redact(loaded.config),
    });
  }

  async function handleValidateConfig(ctx: AdminRequestContext): Promise<void> {
    const parsed = configUpdateBodySchema.safeParse(await readJsonBody(ctx.req));
    if (!parsed.success) {
      sendValidationFailure(ctx.res, parsed.error);
      return;
    }
    const candidate = parsed.data;
    try {
      const validated = deps.config.validate(candidate);
      sendJson(ctx.res, 200, configValidateResponseSchema, {
        valid: true,
        hash: validated.snapshot.hash,
        configuration: deps.config.redact(validated.config),
      });
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        // Zod/embedded-secret messages name property paths, never secret values.
        sendJson(ctx.res, 200, configValidateResponseSchema, { valid: false, error: error.message });
        return;
      }
      throw error;
    }
  }

  async function handleDryRunConfig(ctx: AdminRequestContext): Promise<void> {
    const parsed = configUpdateBodySchema.safeParse(await readJsonBody(ctx.req));
    if (!parsed.success) {
      sendValidationFailure(ctx.res, parsed.error);
      return;
    }
    const candidate = parsed.data;
    try {
      const validated = deps.config.validate(candidate);
      sendJson(ctx.res, 200, configDryRunResponseSchema, {
        valid: true,
        hash: validated.snapshot.hash,
        schemaVersion: validated.snapshot.schemaVersion,
        configuration: deps.config.redact(validated.config),
        applied: false,
      });
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        sendJson(ctx.res, 200, configDryRunResponseSchema, { valid: false, applied: false, error: error.message });
        return;
      }
      throw error;
    }
  }

  async function handleUpdateConfig(ctx: AdminRequestContext, session: AdminSession): Promise<void> {
    const parsed = configUpdateBodySchema.safeParse(await readJsonBody(ctx.req));
    if (!parsed.success) {
      sendValidationFailure(ctx.res, parsed.error);
      return;
    }
    const candidate = parsed.data;
    try {
      const result = deps.config.update(candidate);
      const resource = "configuration";
      await audit(session.login, "config.update", resource, {
        previousHash: result.previous.snapshot.hash,
        nextHash: result.next.snapshot.hash,
        nextCapturedAt: result.next.snapshot.capturedAt,
      });
      sendJson(ctx.res, 200, configUpdateResponseSchema, {
        updated: true,
        previousHash: result.previous.snapshot.hash,
        hash: result.next.snapshot.hash,
        configuration: deps.config.redact(result.next.config),
      });
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        // Atomic guarantee: the store validated BEFORE any write, so
        // review.json and the last-known-good snapshot are untouched here.
        await audit(session.login, "config.update_rejected", "configuration", { reason: "validation failed" });
        sendError(ctx.res, new ValidationError(error.message, { code: ERROR_CODES.CONFIG_INVALID }));
        return;
      }
      throw error;
    }
  }

  async function handleReloadConfig(ctx: AdminRequestContext, session: AdminSession): Promise<void> {
    // §11.5: re-read from disk, validate before activation, keep the previous
    // configuration available (the store's LKG protection covers the case of
    // a file that no longer validates: it reports fromLastKnownGood=true).
    const loaded = deps.config.load({ updateLastKnownGood: true });
    await audit(session.login, "config.reload", "configuration", {
      fromLastKnownGood: loaded.fromLastKnownGood,
      hash: loaded.snapshot.hash,
    });
    sendJson(ctx.res, 200, configReloadResponseSchema, {
      reloaded: true,
      fromLastKnownGood: loaded.fromLastKnownGood,
      hash: loaded.snapshot.hash,
      configuration: deps.config.redact(loaded.config),
    });
  }

  async function handleRollbackConfig(ctx: AdminRequestContext, session: AdminSession): Promise<void> {
    if (deps.config.lastKnownGoodStatus() !== "available") {
      await audit(session.login, "config.rollback_failed", "configuration", { reason: "no last-known-good snapshot" });
      sendError(
        ctx.res,
        new ConflictError("no last-known-good configuration available", {
          code: ERROR_CODES.CONFIG_ROLLBACK_UNAVAILABLE,
        }),
      );
      return;
    }
    try {
      // Restores from the validated snapshot even when the active file is
      // broken (that is the whole point of rollback), so we must not use
      // update here: it refuses to write over an invalid file.
      const restored = deps.config.restoreLastKnownGood();
      await audit(session.login, "config.rollback", "configuration", {
        restoredHash: restored.snapshot.hash,
      });
      sendJson(ctx.res, 200, configRollbackResponseSchema, {
        rolledBack: true,
        hash: restored.snapshot.hash,
        configuration: deps.config.redact(restored.config),
      });
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        await audit(session.login, "config.rollback_failed", "configuration", {
          reason: "last-known-good snapshot failed validation",
        });
        sendError(
          ctx.res,
          new ConflictError("last-known-good snapshot failed validation", {
            code: ERROR_CODES.CONFIG_ROLLBACK_INVALID,
          }),
        );
        return;
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Review status endpoints
  // -------------------------------------------------------------------------

  async function handleListReviews(ctx: AdminRequestContext): Promise<void> {
    const query = parseQuery(reviewListQuerySchema, ctx.url);
    if (!query.success) {
      sendValidationFailure(ctx.res, query.error);
      return;
    }
    const limit = query.data.limit ?? 20;
    const offset = query.data.offset ?? 0;

    const report = await deps.ingestion.listReviews({
      limit,
      offset,
      ...(query.data.state === undefined ? {} : { state: query.data.state }),
    });

    sendJson(ctx.res, 200, reviewListResponseSchema, {
      total: report.total,
      limit,
      offset,
      reviews: report.reviews.map((row) => ({
        id: row.id,
        state: row.state,
        repository: row.repositoryFullName,
        pullRequestNumber: row.pullRequestNumber,
        pullRequestId: row.pullRequestId,
        headSha: row.headSha,
        reviewMode: row.reviewMode,
        trigger: row.trigger,
        provider: row.provider,
        model: row.model,
        startedAt: row.startedAt?.toISOString() ?? null,
        completedAt: row.completedAt?.toISOString() ?? null,
        errorCode: row.errorCode,
        createdAt: row.createdAt.toISOString(),
      })),
    });
  }

  async function handleReviewDetail(res: ServerResponse, reviewId: string): Promise<void> {
    const report = await deps.ingestion.getReviewStatus(reviewId);
    if (!report) {
      sendError(res, new NotFoundError("review not found", { code: ERROR_CODES.REVIEW_NOT_FOUND }));
      return;
    }
    sendJson(res, 200, reviewStatusResponseSchema, {
      review: {
        ...report.review,
        createdAt: report.review.createdAt.toISOString(),
        completedAt: report.review.completedAt?.toISOString() ?? null,
      },
      job: report.job,
      transitions: report.transitions.map((transition) => ({
        fromState: transition.fromState,
        toState: transition.toState,
        at: transition.at.toISOString(),
      })),
    });
  }

  // -------------------------------------------------------------------------
  // Review types (§4.1): on-demand triggering + comparison
  // -------------------------------------------------------------------------

  /** POST /api/admin/reviews/trigger — manual ingestion for one review type. */
  async function handleTriggerReview(ctx: AdminRequestContext, session: AdminSession): Promise<void> {
    const parsed = triggerReviewBodySchema.safeParse(await readJsonBody(ctx.req));
    if (!parsed.success) {
      sendValidationFailure(ctx.res, parsed.error);
      return;
    }
    // Respect the configured default when no type is supplied, and refuse
    // disabled types with a clear error (§4.1).
    let reviewType: ReviewTypeValue;
    try {
      const { config } = deps.config.load();
      reviewType = parsed.data.reviewType ?? config.github.defaultReviewType;
      const settings = config.review.types[reviewType];
      if (settings && settings.enabled === false) {
        sendError(
          ctx.res,
          new ConflictError(`review type '${reviewType}' is disabled`, { code: ERROR_CODES.REVIEW_TYPE_DISABLED }),
        );
        return;
      }
    } catch (error) {
      deps.logger.warn(
        { err: (error as Error).message },
        "Configuration unavailable for review trigger; defaulting type",
      );
      reviewType = parsed.data.reviewType ?? "standard";
    }
    try {
      const result = await deps.ingestion.ingestManualReview({ ...parsed.data, reviewType });
      await audit(session.login, "review.trigger", "review", {
        repository: parsed.data.repository,
        pullRequestNumber: parsed.data.pullRequestNumber,
        reviewType,
        outcome: result.outcome,
        reviewId: result.reviewId,
      });
      sendJson(ctx.res, result.outcome === "created" ? 202 : 200, reviewTriggerResponseSchema, {
        ...result,
        reviewType,
      });
    } catch (error) {
      if (error instanceof ManualIngestionError) {
        sendError(ctx.res, new NotFoundError(error.message, { code: ERROR_CODES.REVIEW_TARGET_NOT_FOUND }));
        return;
      }
      throw error;
    }
  }

  /**
   * GET /api/admin/reviews/compare?repository=owner/repo&pr=123
   *
   * Per-type comparison rows for one PR (§4.1): review id, type, state,
   * attempt, trigger, timestamps, duration, finding counts by severity,
   * findings unique to this type (fingerprint not present in any other
   * type's review of the same commit) and persisted token usage (null when
   * the run predates token persistence).
   */
  async function handleCompareReviews(ctx: AdminRequestContext): Promise<void> {
    const query = parseQuery(compareQuerySchema, ctx.url);
    if (!query.success) {
      sendValidationFailure(ctx.res, query.error);
      return;
    }
    const repositoryName = query.data.repository;
    const prRaw = query.data.pr;
    const target: ReviewComparisonInput = { repositoryFullName: repositoryName, pullRequestNumber: prRaw };

    const lookup = await deps.ingestion.getReviewComparison(target);
    if (lookup.outcome === "repository_not_found") {
      sendError(
        ctx.res,
        new NotFoundError(`repository '${repositoryName}' is not registered`, {
          code: ERROR_CODES.REPOSITORY_NOT_FOUND,
        }),
      );
      return;
    }
    if (lookup.outcome === "pull_request_not_found") {
      sendError(
        ctx.res,
        new NotFoundError(`pull request #${prRaw} not found on '${repositoryName}'`, {
          code: ERROR_CODES.PULL_REQUEST_NOT_FOUND,
        }),
      );
      return;
    }

    const reviews = lookup.reviews;

    // Fingerprints seen by each review TYPE of the same PR/head SHA — used
    // to compute per-type unique findings (a fingerprint another type did
    // not report). A review's own type never counts against it.
    const fingerprintsByType = new Map<string, Map<string, Set<string>>>();
    for (const review of reviews) {
      let bySha = fingerprintsByType.get(review.reviewType);
      if (!bySha) {
        bySha = new Map<string, Set<string>>();
        fingerprintsByType.set(review.reviewType, bySha);
      }
      let set = bySha.get(review.headSha);
      if (!set) {
        set = new Set<string>();
        bySha.set(review.headSha, set);
      }
      for (const finding of review.findings) {
        set.add(finding.fingerprint);
      }
    }

    const rows = reviews.map((review) => {
      const severityCounts: Record<string, number> = {};
      for (const finding of review.findings) {
        severityCounts[finding.severity] = (severityCounts[finding.severity] ?? 0) + 1;
      }
      const fingerprints = new Set(review.findings.map((f) => f.fingerprint));
      const others = new Set<string>();
      for (const [type, bySha] of fingerprintsByType) {
        if (type === review.reviewType) {
          continue;
        }
        for (const fingerprint of bySha.get(review.headSha) ?? []) {
          others.add(fingerprint);
        }
      }
      let uniqueCount = 0;
      for (const fingerprint of fingerprints) {
        if (!others.has(fingerprint)) {
          uniqueCount += 1;
        }
      }
      const completedAt = review.completedAt ?? null;
      const durationMs = review.startedAt && completedAt ? completedAt.getTime() - review.startedAt.getTime() : null;
      return {
        id: review.id,
        reviewType: review.reviewType,
        reviewMode: review.reviewMode,
        state: review.state,
        attempt: review.attempt,
        trigger: review.trigger,
        headSha: review.headSha,
        createdAt: review.createdAt.toISOString(),
        startedAt: review.startedAt?.toISOString() ?? null,
        completedAt: completedAt?.toISOString() ?? null,
        durationMs,
        publishSkipped: review.publishSkipped,
        findingCount: review.findings.length,
        severityCounts,
        uniqueFindings: uniqueCount,
        inputTokens: review.inputTokens,
        outputTokens: review.outputTokens,
        // Knowledge snapshot identity per review (§4/§16.1, additive): the
        // ref + content hash each type's injection actually ran with, so
        // comparisons can show e.g. "handbook@<sha7>".
        knowledgeSnapshot: summarizeKnowledgeSnapshot(review.knowledgeSnapshot),
        // Injection metrics per review (§16.1, additive): estimated injected
        // tokens + the retrieval funnel (candidates → relevant → selected)
        // and whether the token budget forced truncation. Null when the
        // review predates metrics or ran without knowledge injection.
        knowledgeMetrics: summarizeKnowledgeMetrics(review.knowledgeSnapshot),
        errorCode: review.errorCode,
      };
    });

    sendJson(ctx.res, 200, compareReviewsResponseSchema, {
      repository: repositoryName,
      pullRequestNumber: prRaw,
      headShas: [...new Set(reviews.map((r) => r.headSha))],
      reviews: rows,
    });
  }
}
