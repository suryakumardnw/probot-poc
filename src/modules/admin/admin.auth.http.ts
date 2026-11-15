import {
  loginResponseSchema,
  logoutResponseSchema,
  oauthCallbackQuerySchema,
  sessionResponseSchema,
} from "../../contracts/admin.js";
import { ERROR_CODES } from "../../contracts/errors.js";
import { AuthError, ForbiddenError, ValidationError } from "../../shared/errors/index.js";
import { headerValue, parseQuery, sendError, sendJson } from "./admin.http.helpers.js";
import type { AdminRequestContext } from "./admin.types.js";
import { CSRF_HEADER, verifyCsrfToken } from "./auth/csrf.js";
import {
  authorizeAdmin,
  buildAuthorizeUrl,
  consumeOauthState,
  createOauthState,
  exchangeOAuthCode,
  fetchGithubUser,
  fetchOrgMembership,
} from "./auth/github-oauth.js";
import {
  buildClearCookieHeader,
  buildSetCookieHeader,
  createSession,
  destroySession,
  type AdminSession,
} from "./auth/session.js";

/** GET /api/admin/auth/github/login — redirect to GitHub with a one-time state. */
export function handleGithubLogin(ctx: AdminRequestContext): void {
  const state = createOauthState(ctx.now());
  const authorizeUrl = buildAuthorizeUrl(ctx.env, state);
  ctx.res.statusCode = 302;
  ctx.res.setHeader("Location", authorizeUrl);
  ctx.res.end();
}

/** GET /api/admin/auth/github/callback — exchange the code and mint a session. */
export async function handleOAuthCallback(ctx: AdminRequestContext): Promise<void> {
  const { res } = ctx;
  const query = parseQuery(oauthCallbackQuerySchema, ctx.url);
  const code = query.success ? query.data.code : undefined;
  const state = query.success ? query.data.state : undefined;

  if (!consumeOauthState(state ?? null, ctx.now())) {
    await ctx.deps.audit.record({
      actor: "anonymous",
      action: "admin.login_denied",
      resource: "admin_session",
      metadata: { reason: "invalid or expired oauth state" },
    });
    sendError(res, new ValidationError("invalid or expired oauth state"));
    return;
  }
  if (!code) {
    sendError(res, new ValidationError("missing oauth code"));
    return;
  }

  const accessToken = await exchangeOAuthCode(ctx.env, code);
  const user = await fetchGithubUser(accessToken);
  const membership = await fetchOrgMembership(ctx.env.ADMIN_GITHUB_ORG!, user.login, accessToken);
  const decision = authorizeAdmin(ctx.env, user, membership);

  if (!decision.allowed) {
    await ctx.deps.audit.record({
      actor: user.login,
      action: "admin.login_denied",
      resource: "admin_session",
      metadata: { reason: decision.reason, rolePolicy: decision.rolePolicy },
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
    env: ctx.env,
    now: ctx.now,
  });
  await ctx.deps.audit.record({
    actor: user.login,
    action: "admin.login",
    resource: "admin_session",
    metadata: { rolePolicy: newSession.rolePolicy },
  });
  ctx.deps.logger.info({ login: user.login, rolePolicy: newSession.rolePolicy }, "Admin logged in");
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
    { "Set-Cookie": buildSetCookieHeader(newSession, ctx.env) },
  );
}

/** POST /api/admin/auth/logout — CSRF-protected session destruction. */
export async function handleLogout(ctx: AdminRequestContext, session: AdminSession | null): Promise<void> {
  if (!session) {
    sendError(ctx.res, new AuthError("authentication required"));
    return;
  }
  if (!verifyCsrfToken(session, headerValue(ctx.req.headers[CSRF_HEADER]))) {
    sendError(ctx.res, new ForbiddenError("csrf validation failed", { code: ERROR_CODES.ADMIN_CSRF_FAILED }));
    return;
  }
  destroySession(session.id);
  await ctx.deps.audit.record({
    actor: session.login,
    action: "admin.logout",
    resource: "admin_session",
    metadata: {},
  });
  sendJson(ctx.res, 200, logoutResponseSchema, { ok: true }, { "Set-Cookie": buildClearCookieHeader(ctx.env) });
}

/** GET /api/admin/session — current session identity and CSRF token. */
export function handleSession(ctx: AdminRequestContext, session: AdminSession | null): void {
  if (!session) {
    sendError(ctx.res, new AuthError("authentication required"));
    return;
  }
  sendJson(ctx.res, 200, sessionResponseSchema, {
    authenticated: true,
    user: { login: session.login, id: session.githubUserId },
    rolePolicy: session.rolePolicy,
    csrfToken: session.csrfToken,
    expiresAt: new Date(session.expiresAt).toISOString(),
  });
}
