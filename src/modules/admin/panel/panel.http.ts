import type { IncomingMessage, ServerResponse } from "node:http";
import { toErrorLogPayload } from "../../../platform/http/error-mapper.js";
import type { AdminPanelDeps } from "../admin.types.js";
import { verifyCsrfToken } from "../auth/csrf.js";
import { isAdminConfigured, isSessionAdmin } from "../auth/github-oauth.js";
import {
  buildSetCookieHeader,
  createSession,
  getSessionFromCookie,
  readSessionCookie,
  type AdminSession,
} from "../auth/session.js";
import { checkRateLimit, clientIpOf } from "../rate-limit.js";
import { isPanelSection, SECTION_LABELS } from "./fields.js";
import { lastValue, readUrlEncodedForm } from "./forms.js";
import { createPanelActions } from "./panel.actions.js";
import {
  currentVersion,
  messagePage,
  noticeText,
  page,
  redirect,
  renderOverviewBody,
  renderSectionBody,
} from "./render.js";
import { PANEL_CSS } from "./templates/index.js";

/**
 * Server-rendered admin HTML panel (ticket 14, §14.2).
 *
 * Served by the same node:http server as the admin API, at GET/POST /admin.
 * No SPA and no client framework: plain HTML forms + one inline stylesheet,
 * rendered with EJS. Every write goes through the SAME primitives as
 * PUT /api/admin/config (`ReviewConfigStore.update` / `restoreLastKnownGood`), so the
 * atomicity, validation-before-write and last-known-good guarantees are
 * identical.
 *
 * Security model:
 * - Unauthenticated requests are redirected to the admin OAuth login.
 * - Sessions are the ticket-10 admin sessions; a session whose login no
 *   longer satisfies the admin policy is shown a 403 page.
 * - Every POST requires the session CSRF token as a hidden `_csrf` input.
 * - No secret value is ever rendered: form values come from
 *   secret-safe store redaction; the provider API key is env-name-only and
 *   read-only.
 * - Sensitive execution-policy changes (execution mode, sandbox, command
 *   allowlist, network policy) require a confirmation interstitial before
 *   they are persisted.
 */

export function createAdminPanel(
  deps: AdminPanelDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const env = deps.env;
  const actions = createPanelActions(deps);

  return async function handlePanelRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (path !== "/admin" && !path.startsWith("/admin/") && path !== "/logs") {
      return false;
    }

    // Local development convenience (ticket 14 verification): a dev-only login
    // that mints a real admin session without GitHub OAuth. It is active ONLY
    // when ALL of the following hold:
    //   - NODE_ENV === "development"
    //   - ADMIN_DEV_LOGIN === "1" (explicit opt-in)
    //   - SESSION_SECRET is configured
    // It is unreachable in production and absent from test/prod defaults.
    const devLoginEnabled =
      env.NODE_ENV === "development" && process.env.ADMIN_DEV_LOGIN === "1" && Boolean(env.SESSION_SECRET);

    // Rate limit the panel like every other admin surface.
    const limit = checkRateLimit(`panel:${clientIpOf(req)}`, { limitPerMinute: env.ADMIN_RATE_LIMIT_PER_MINUTE });
    if (!limit.allowed) {
      res.setHeader("Retry-After", String(limit.retryAfterSeconds));
      messagePage(res, 429, "Too many requests", "Rate limit exceeded. Try again shortly.", "error");
      return true;
    }

    if (devLoginEnabled && req.method === "GET" && path === "/admin/dev-login") {
      const login = (url.searchParams.get("login") ?? "dev-admin").slice(0, 64);
      const session = createSession({ login, id: 0 }, "org-role", { env });
      res.setHeader("Set-Cookie", buildSetCookieHeader(session, env));
      redirect(res, "/admin");
      return true;
    }

    if (!devLoginEnabled && !isAdminConfigured(env)) {
      messagePage(res, 503, "Admin panel unavailable", "The admin panel is not configured.", "error");
      return true;
    }

    const session = getSessionFromCookie(readSessionCookie(req.headers.cookie), env);

    // Unauthenticated → OAuth login redirect (or the dev login when enabled).
    if (!session) {
      redirect(res, devLoginEnabled ? "/admin/dev-login" : "/api/admin/auth/github/login");
      return true;
    }

    // Authenticated but no longer an administrator → 403 page.
    if (!isSessionAdmin(env, session)) {
      messagePage(res, 403, "Access denied", "You are not an administrator of this organization.", "error", session);
      return true;
    }

    try {
      await dispatch(req, res, url, path, session);
    } catch (error) {
      // Panel failures stay HTML, but the log projection still suppresses
      // stacks, SQL, paths, and caller-controlled 5xx text.
      deps.logger.error(toErrorLogPayload(error, "http"), "Admin panel request failed");
      messagePage(res, 500, "Internal error", "The admin panel could not complete the request.", "error", session);
    }
    return true;
  };

  async function dispatch(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    path: string,
    session: AdminSession,
  ): Promise<void> {
    const version = currentVersion(deps.config);

    // --- Container logs shortcut ------------------------------------------

    // `/logs` is a Probot-authenticated entry point. Traefik routes `/dozzle/*`
    // directly to the Dozzle container (see deploy/docker-compose.dozzle.yml),
    // so Probot cannot gate that path itself; Dozzle's own users.yml login is
    // the gate there. This redirect is a convenience for admins already signed
    // in to the panel.
    if (req.method === "GET" && path === "/logs") {
      res.statusCode = 302;
      res.setHeader("Location", "/dozzle/");
      res.end();
      return;
    }

    // --- Stylesheet -------------------------------------------------------

    if (req.method === "GET" && path === "/admin/styles.css") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/css; charset=utf-8");
      res.end(PANEL_CSS);
      return;
    }

    // --- POST endpoints (CSRF-protected) -----------------------------------

    if (req.method === "POST") {
      const form = await readUrlEncodedForm(req);
      if (!form.ok) {
        messagePage(res, 413, "Request too large", "The submitted form was too large.", "error", session);
        return;
      }
      const csrf = lastValue(form.fields, "_csrf");
      if (!verifyCsrfToken(session, csrf)) {
        messagePage(
          res,
          403,
          "Request blocked",
          "Missing or invalid CSRF token. Go back, reload the form and try again.",
          "error",
          session,
        );
        return;
      }

      if (path === "/admin/config/reload") {
        await actions.handleReload(res, session);
        return;
      }
      if (path === "/admin/config/rollback") {
        await actions.handleRollback(res, session);
        return;
      }
      const sectionMatch = /^\/admin\/([a-z-]+)$/.exec(path);
      const section = sectionMatch?.[1];
      if (section !== undefined && isPanelSection(section)) {
        await actions.handleSectionPost(res, url, section, form.fields, session, version);
        return;
      }
      messagePage(res, 404, "Not found", "Unknown admin panel action.", "error", session);
      return;
    }

    if (req.method !== "GET") {
      messagePage(res, 405, "Method not allowed", "Only GET and POST are supported.", "error", session);
      return;
    }

    // --- GET endpoints ------------------------------------------------------

    if (path === "/admin") {
      const body = renderOverviewBody({
        csrfToken: session.csrfToken,
        notice: noticeText(url.searchParams.get("notice")),
        error: noticeText(url.searchParams.get("error")),
      });
      page(res, 200, "Overview", body, { active: "", session, version });
      return;
    }

    if (path === "/admin/audit") {
      await actions.handleAuditHistory(res, url, session, version);
      return;
    }

    const sectionMatch = /^\/admin\/([a-z-]+)$/.exec(path);
    const section = sectionMatch?.[1];
    if (section !== undefined && isPanelSection(section)) {
      const loaded = deps.config.load();
      const redacted = deps.config.redact(loaded.config);
      const body = renderSectionBody({
        section,
        config: redacted,
        csrfToken: session.csrfToken,
        fieldErrors: new Map(),
        notice: noticeText(url.searchParams.get("notice")),
        error: noticeText(url.searchParams.get("error")),
        validationPassed: false,
      });
      page(res, 200, SECTION_LABELS[section], body, { active: section, session, version });
      return;
    }

    messagePage(res, 404, "Not found", "Unknown admin panel page.", "error", session);
  }
}
