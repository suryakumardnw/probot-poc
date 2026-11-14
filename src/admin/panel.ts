import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { parse as parseFormBody } from "node:querystring";
import type { PrismaClient } from "@prisma/client";
import ejs from "ejs";
import type { Env } from "../config/env.js";
import {
  DEFAULT_CONFIG_PATH,
  ConfigValidationError,
  checkForEmbeddedSecrets,
  getPath,
  LAST_KNOWN_GOOD_SUFFIX,
  loadReviewConfig,
  redactConfiguration,
  resolveEnvReferences,
  restoreLastKnownGood,
  setPath,
  updateReviewConfig,
  validateRawConfig,
} from "../config/review-loader.js";
import type { ReviewConfig } from "../config/review-schema.js";
import { toErrorLogPayload } from "../platform/http/error-mapper.js";
import { isAdminConfigured } from "./api.js";
import { recordAuditLog, type AuditAction } from "./audit.js";
import {
  PANEL_FIELDS,
  PANEL_SECTIONS,
  SECTION_LABELS,
  isPanelSection,
  type PanelField,
  type PanelSection,
} from "./panel-fields.js";
import {
  AUDIT_TEMPLATE,
  INTERSTITIAL_TEMPLATE,
  LAYOUT_TEMPLATE,
  MESSAGE_TEMPLATE,
  OVERVIEW_TEMPLATE,
  PANEL_CSS,
  SECTION_TEMPLATE,
} from "./panel-templates.js";
import { checkRateLimit, clientIpOf } from "./rate-limit.js";
import {
  buildSetCookieHeader,
  createSession,
  getSessionFromCookie,
  readSessionCookie,
  verifyCsrfToken,
  type AdminSession,
} from "./session.js";

const renderEjs = ejs.render;

/**
 * Server-rendered admin HTML panel (ticket 14, §14.2).
 *
 * Served by the same node:http server as the admin API, at GET/POST /admin.
 * No SPA and no client framework: plain HTML forms + one inline stylesheet,
 * rendered with EJS. Every write goes through the SAME primitives as
 * PUT /api/admin/config (updateReviewConfig / restoreLastKnownGood), so the
 * atomicity, validation-before-write and last-known-good guarantees are
 * identical.
 *
 * Security model:
 * - Unauthenticated requests are redirected to the admin OAuth login.
 * - Sessions are the ticket-10 admin sessions; a session whose login no
 *   longer satisfies the admin policy is shown a 403 page.
 * - Every POST requires the session CSRF token as a hidden `_csrf` input.
 * - No secret value is ever rendered: form values come from
 *   redactConfiguration output; the provider API key is env-name-only and
 *   read-only.
 * - Sensitive execution-policy changes (execution mode, sandbox, command
 *   allowlist, network policy) require a confirmation interstitial before
 *   they are persisted.
 */

export interface AdminPanelDeps {
  env: Env;
  prisma: PrismaClient;
  logger: {
    info: (obj: unknown, msg: string) => void;
    warn: (obj: unknown, msg: string) => void;
    error: (obj: unknown, msg: string) => void;
  };
  configPath?: string;
}

const AUDIT_PAGE_SIZE = 20;
const MAX_FORM_BYTES = 512 * 1024;

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(body);
}

function redirect(res: ServerResponse, location: string): void {
  res.statusCode = 303;
  res.setHeader("Location", location);
  res.end();
}

function displayValue(value: unknown): string {
  if (value === undefined) {
    return "(unset)";
  }
  if (Array.isArray(value)) {
    return value.join(", ");
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

/** Parse the path-scoped issues out of a ConfigValidationError message. */
function parseIssuePaths(message: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const match of message.matchAll(/^ {2}- (?:\(root\)|(.+?)): (.+)$/gm)) {
    map.set(match[1] ?? "(root)", match[2] ?? "invalid value");
  }
  return map;
}

// ---------------------------------------------------------------------------
// Session-level admin re-check (the login policy may have changed)
// ---------------------------------------------------------------------------

function parseLoginAllowlist(env: Env): string[] {
  return env.ADMIN_GITHUB_LOGINS.split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** A session is admin when it would still pass the current allowlist/role policy. */
export function isSessionAdmin(env: Env, session: AdminSession): boolean {
  const allowlist = parseLoginAllowlist(env);
  if (allowlist.length > 0) {
    return session.rolePolicy === "allowlist" && allowlist.includes(session.login);
  }
  return session.rolePolicy === "org-role";
}

// ---------------------------------------------------------------------------
// Form parsing
// ---------------------------------------------------------------------------

interface FormResult {
  ok: boolean;
  fields: Record<string, string | string[]>;
}

async function readUrlEncodedForm(req: IncomingMessage): Promise<FormResult> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
    if (chunks.reduce((n, c) => n + c.length, 0) > MAX_FORM_BYTES) {
      return { ok: false, fields: {} };
    }
  }
  const raw = parseFormBody(Buffer.concat(chunks).toString("utf8"));
  const fields: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) {
      continue;
    }
    fields[key] = value;
  }
  return { ok: true, fields };
}

function lastValue(fields: Record<string, string | string[]>, key: string): string | undefined {
  const value = fields[key];
  if (value === undefined) {
    return undefined;
  }
  return Array.isArray(value) ? value[value.length - 1] : value;
}

// ---------------------------------------------------------------------------
// Field rendering (inputs are pre-rendered, templates stay dumb)
// ---------------------------------------------------------------------------

interface RenderedField {
  id: string;
  path: string;
  label: string;
  type: PanelField["type"];
  input: string;
  help?: string;
  error?: string;
}

function fieldInputHtml(field: PanelField, value: unknown, id: string): string {
  const name = `f:${field.path}`;
  const readonlyAttr = field.readonly ? " readonly" : "";
  switch (field.type) {
    case "textarea":
      return `<textarea id="${id}" name="${name}" rows="4"${readonlyAttr}>${escapeHtml(displayValue(value) === "(unset)" ? "" : String(value ?? ""))}</textarea>`;
    case "boolean": {
      const checked = value === true ? " checked" : "";
      const disabled = field.readonly ? " disabled" : "";
      return `<input type="hidden" name="${name}" value="false"><label for="${id}"><input type="checkbox" id="${id}" name="${name}" value="true"${checked}${disabled}> ${escapeHtml(field.label)}</label>`;
    }
    case "enum": {
      const options = field.options ?? [];
      const current = typeof value === "string" ? value : "";
      const opts = options
        .map(
          (option) =>
            `<option value="${escapeHtml(option)}"${option === current ? " selected" : ""}>${escapeHtml(option)}</option>`,
        )
        .join("");
      return `<select id="${id}" name="${name}"${readonlyAttr ? " disabled" : ""}>${opts}</select>`;
    }
    case "number":
      return `<input type="number" step="any" id="${id}" name="${name}" value="${value === undefined || value === null ? "" : escapeHtml(String(value))}"${readonlyAttr}>`;
    default: {
      const text = Array.isArray(value) ? value.join(", ") : value === undefined || value === null ? "" : String(value);
      return `<input type="text" id="${id}" name="${name}" value="${escapeHtml(text)}"${readonlyAttr}>`;
    }
  }
}

function renderFields(
  section: PanelSection,
  config: Record<string, unknown>,
  fieldErrors: Map<string, string>,
): RenderedField[] {
  return PANEL_FIELDS[section].map((field, index) => {
    const id = `${section.replace(/-/g, "_")}_${index}`;
    // Values come from the REDACTED configuration only.
    const value = getPath(config, field.path);
    return {
      id,
      path: field.path,
      label: field.label,
      type: field.type,
      input: fieldInputHtml(field, value, id),
      help: field.help,
      error: fieldErrors.get(field.path),
    };
  });
}

// ---------------------------------------------------------------------------
// Candidate construction from form fields
// ---------------------------------------------------------------------------

interface CandidateResult {
  candidate: Record<string, unknown>;
  fieldErrors: Map<string, string>;
  submitted: boolean;
}

function buildCandidate(
  section: PanelSection,
  baseConfig: Record<string, unknown>,
  form: Record<string, string | string[]>,
): CandidateResult {
  const candidate = structuredClone(baseConfig) as Record<string, unknown>;
  const fieldErrors = new Map<string, string>();
  let submitted = false;

  for (const field of PANEL_FIELDS[section]) {
    if (field.readonly) {
      continue;
    } // read-only fields are never written by the panel
    const raw = lastValue(form, `f:${field.path}`);
    if (raw === undefined) {
      continue;
    } // untouched (e.g. interstitial round-trip)
    submitted = true;
    try {
      switch (field.type) {
        case "boolean":
          setPath(candidate, field.path, raw === "true");
          break;
        case "number": {
          if (raw.trim() === "") {
            break;
          } // leave unchanged
          const numeric = Number(raw);
          if (!Number.isFinite(numeric)) {
            fieldErrors.set(field.path, "must be a finite number");
            break;
          }
          setPath(candidate, field.path, numeric);
          break;
        }
        case "list":
          setPath(
            candidate,
            field.path,
            raw
              .split(",")
              .map((entry) => entry.trim())
              .filter((entry) => entry.length > 0),
          );
          break;
        default:
          setPath(candidate, field.path, raw);
      }
    } catch {
      fieldErrors.set(field.path, "cannot be applied");
    }
  }
  return { candidate, fieldErrors, submitted };
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

interface SensitiveChange {
  path: string;
  oldValue: string;
  newValue: string;
}

/** Detect changes to sensitive (execution-policy) fields, redacted for display. */
function sensitiveChanges(
  section: PanelSection,
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): SensitiveChange[] {
  const redactedPrevious = redactConfiguration(previous as unknown as ReviewConfig) as unknown as Record<
    string,
    unknown
  >;
  const redactedNext = redactConfiguration(next as unknown as ReviewConfig) as unknown as Record<string, unknown>;
  const changes: SensitiveChange[] = [];
  for (const field of PANEL_FIELDS[section]) {
    if (!field.sensitive) {
      continue;
    }
    const before = getPath(redactedPrevious, field.path);
    const after = getPath(redactedNext, field.path);
    if (!deepEqual(before, after)) {
      changes.push({
        path: field.path,
        oldValue: displayValue(before),
        newValue: displayValue(after),
      });
    }
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export function createAdminPanel(
  deps: AdminPanelDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const env = deps.env;
  const processEnv = {
    ...process.env,
    ...Object.fromEntries(Object.entries(env).map(([key, value]) => [key, String(value)])),
  } as unknown as NodeJS.ProcessEnv;
  const configPath = deps.configPath ?? DEFAULT_CONFIG_PATH;

  async function audit(
    actor: string,
    action: AuditAction,
    resource: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await recordAuditLog(deps.prisma, { actor, action, resource, metadata }, deps.logger);
  }

  function page(
    res: ServerResponse,
    status: number,
    title: string,
    body: string,
    options: {
      active?: string;
      session?: AdminSession | null;
      version?: { schemaVersion: number; hash: string; fromLastKnownGood: boolean } | null;
    } = {},
  ): void {
    const active = options.active ?? "";
    const nav = [
      { href: "/admin", label: "Overview" },
      ...PANEL_SECTIONS.map((section) => ({ href: `/admin/${section}`, label: SECTION_LABELS[section] })),
      // `/logs` is a Probot-authenticated shortcut that redirects to the
      // Dozzle UI mounted at /dozzle (same domain, like Phoenix at /phoenix).
      // Dozzle itself still requires its users.yml login.
      { href: "/logs", label: "Container logs" },
    ];
    const html = renderEjs(LAYOUT_TEMPLATE, {
      title,
      css: PANEL_CSS,
      user: options.session?.login ?? null,
      nav: nav.map((item) => ({
        ...item,
        active: item.href === `/admin/${active}` || (active === "" && item.href === "/admin"),
      })),
      active,
      version: options.version ?? null,
      body,
    });
    sendHtml(res, status, html);
  }

  function messagePage(
    res: ServerResponse,
    status: number,
    title: string,
    message: string,
    tone: "notice" | "error",
    session?: AdminSession | null,
  ): void {
    const body = renderEjs(MESSAGE_TEMPLATE, { title, message, tone });
    page(res, status, title, body, { session });
  }

  function currentVersion(): { schemaVersion: number; hash: string; fromLastKnownGood: boolean } | null {
    try {
      const loaded = loadReviewConfig(configPath, { env: processEnv, allowLastKnownGoodFallback: true });
      return {
        schemaVersion: loaded.snapshot.schemaVersion,
        hash: loaded.snapshot.hash,
        fromLastKnownGood: loaded.fromLastKnownGood,
      };
    } catch {
      return null; // overview stays renderable even with a broken config
    }
  }

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
    const version = currentVersion();

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
        await handleReload(res, session);
        return;
      }
      if (path === "/admin/config/rollback") {
        await handleRollback(res, session);
        return;
      }
      const sectionMatch = /^\/admin\/([a-z-]+)$/.exec(path);
      const section = sectionMatch?.[1];
      if (section !== undefined && isPanelSection(section)) {
        await handleSectionPost(res, url, section, form.fields, session, version);
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
      const body = renderEjs(OVERVIEW_TEMPLATE, {
        nav: PANEL_SECTIONS.map((section) => ({ href: `/admin/${section}`, label: SECTION_LABELS[section] })),
        csrfToken: session.csrfToken,
        notice: noticeText(url.searchParams.get("notice")),
        error: noticeText(url.searchParams.get("error")),
      });
      page(res, 200, "Overview", body, { active: "", session, version });
      return;
    }

    if (path === "/admin/audit") {
      await handleAuditHistory(res, url, session, version);
      return;
    }

    const sectionMatch = /^\/admin\/([a-z-]+)$/.exec(path);
    const section = sectionMatch?.[1];
    if (section !== undefined && isPanelSection(section)) {
      const loaded = loadReviewConfig(configPath, { env: processEnv, allowLastKnownGoodFallback: true });
      const redacted = redactConfiguration(loaded.config) as unknown as Record<string, unknown>;
      const body = renderEjs(SECTION_TEMPLATE, {
        section,
        sectionLabel: SECTION_LABELS[section],
        csrfToken: session.csrfToken,
        fields: renderFields(section, redacted, new Map()),
        notice: noticeText(url.searchParams.get("notice")),
        error: noticeText(url.searchParams.get("error")),
        validationPassed: false,
      });
      page(res, 200, SECTION_LABELS[section], body, { active: section, session, version });
      return;
    }

    messagePage(res, 404, "Not found", "Unknown admin panel page.", "error", session);
  }

  function noticeText(param: string | null): string {
    switch (param) {
      case "saved":
        return "Configuration saved and validated successfully.";
      case "reloaded":
        return "Configuration reloaded from disk.";
      case "rolledback":
        return "Configuration restored from the last-known-good snapshot.";
      case "no-snapshot":
        return "No last-known-good snapshot is available yet — save a valid configuration first.";
      case "no-changes":
        return "No changes were submitted.";
      default:
        return "";
    }
  }

  // -------------------------------------------------------------------------
  // Reload / rollback (same primitives as the admin API)
  // -------------------------------------------------------------------------

  async function handleReload(res: ServerResponse, session: AdminSession): Promise<void> {
    const loaded = loadReviewConfig(configPath, {
      env: processEnv,
      allowLastKnownGoodFallback: true,
      updateLastKnownGood: true,
    });
    await audit(session.login, "config.reload", "configuration", {
      fromLastKnownGood: loaded.fromLastKnownGood,
      hash: loaded.snapshot.hash,
    });
    deps.logger.info({ login: session.login, hash: loaded.snapshot.hash }, "Admin panel: configuration reloaded");
    redirect(res, "/admin?notice=reloaded");
  }

  async function handleRollback(res: ServerResponse, session: AdminSession): Promise<void> {
    // Existence probe only; restoreLastKnownGood validates the snapshot.
    const lkgExists = existsSync(`${configPath}${LAST_KNOWN_GOOD_SUFFIX}`);
    if (!lkgExists) {
      await audit(session.login, "config.rollback_failed", "configuration", { reason: "no last-known-good snapshot" });
      redirect(res, "/admin?error=no-snapshot");
      return;
    }
    try {
      const restored = restoreLastKnownGood(configPath);
      await audit(session.login, "config.rollback", "configuration", { restoredHash: restored.snapshot.hash });
      deps.logger.info(
        { login: session.login, hash: restored.snapshot.hash },
        "Admin panel: configuration rolled back",
      );
      redirect(res, "/admin?notice=rolledback");
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        await audit(session.login, "config.rollback_failed", "configuration", {
          reason: "last-known-good snapshot failed validation",
        });
        redirect(res, "/admin?error=rollback-failed");
        return;
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Section save / validate
  // -------------------------------------------------------------------------

  async function handleSectionPost(
    res: ServerResponse,
    url: URL,
    section: PanelSection,
    form: Record<string, string | string[]>,
    session: AdminSession,
    version: ReturnType<typeof currentVersion>,
  ): Promise<void> {
    const action = lastValue(form, "action") === "validate" ? "validate" : "save";
    const loaded = loadReviewConfig(configPath, { env: processEnv, allowLastKnownGoodFallback: true });
    const { candidate, fieldErrors, submitted } = buildCandidate(
      section,
      loaded.config as unknown as Record<string, unknown>,
      form,
    );

    if (!submitted && action === "save" && lastValue(form, "confirm") !== "confirmed") {
      redirect(res, `/admin/${section}?error=no-changes`);
      return;
    }

    // Validate the candidate (never persists). Field errors are mapped back to
    // the originating paths so they render beside the fields.
    let validated: Record<string, unknown> | null = null;
    try {
      checkForEmbeddedSecrets(candidate);
      const resolved = resolveEnvReferences(candidate, processEnv);
      validated = validateRawConfig(resolved) as unknown as Record<string, unknown>;
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        for (const [issuePath, message] of parseIssuePaths(error.message)) {
          if (issuePath === "(root)" || !fieldErrors.has(issuePath)) {
            fieldErrors.set(issuePath, message);
          }
        }
      } else {
        throw error;
      }
    }

    if (!validated) {
      if (action === "save") {
        await audit(session.login, "config.update_rejected", "configuration", { reason: "validation failed" });
      }
      renderSection(
        res,
        section,
        loaded,
        fieldErrors,
        action === "save" ? "Validation failed — nothing was saved." : null,
        400,
        session,
        version,
        url,
      );
      return;
    }

    if (action === "validate") {
      // Validate WITHOUT persisting.
      renderSection(res, section, loaded, fieldErrors, null, 200, session, version, url, true);
      return;
    }

    // --- Save flow ---------------------------------------------------------

    const changes = sensitiveChanges(section, loaded.config as unknown as Record<string, unknown>, validated);
    const confirmed = lastValue(form, "confirm") === "confirmed";

    if (changes.length > 0 && !confirmed) {
      // Confirmation interstitial: nothing has been persisted yet.
      const candidateJson = JSON.stringify(validated);
      const body = renderEjs(INTERSTITIAL_TEMPLATE, {
        section,
        sectionLabel: SECTION_LABELS[section],
        changes,
        csrfToken: session.csrfToken,
        candidateJson,
      });
      page(res, 200, `Confirm changes — ${SECTION_LABELS[section]}`, body, { active: section, session, version });
      return;
    }

    const finalCandidate =
      confirmed && typeof lastValue(form, "candidate") === "string"
        ? (JSON.parse(lastValue(form, "candidate")!) as unknown)
        : candidate;

    try {
      const result = updateReviewConfig(configPath, finalCandidate, { env: processEnv });
      await audit(session.login, "config.update", "configuration", {
        previousHash: result.previous.snapshot.hash,
        nextHash: result.next.snapshot.hash,
        nextCapturedAt: result.next.snapshot.capturedAt,
        source: "panel",
        section,
      });
      deps.logger.info(
        { login: session.login, section, hash: result.next.snapshot.hash },
        "Admin panel: configuration saved",
      );
      redirect(res, `/admin/${section}?notice=saved`);
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        // Atomic: updateReviewConfig validates before any write.
        await audit(session.login, "config.update_rejected", "configuration", { reason: "validation failed" });
        const errors = parseIssuePaths(error.message);
        for (const [issuePath, message] of errors) {
          if (!fieldErrors.has(issuePath)) {
            fieldErrors.set(issuePath, message);
          }
        }
        renderSection(
          res,
          section,
          loaded,
          fieldErrors,
          "Validation failed — nothing was saved.",
          400,
          session,
          version,
          url,
        );
        return;
      }
      throw error;
    }
  }

  function renderSection(
    res: ServerResponse,
    section: PanelSection,
    loaded: ReturnType<typeof loadReviewConfig>,
    fieldErrors: Map<string, string>,
    error: string | null,
    status: number,
    session: AdminSession,
    version: ReturnType<typeof currentVersion>,
    url: URL,
    validationPassed = false,
  ): void {
    const redacted = redactConfiguration(loaded.config) as unknown as Record<string, unknown>;
    const body = renderEjs(SECTION_TEMPLATE, {
      section,
      sectionLabel: SECTION_LABELS[section],
      csrfToken: session.csrfToken,
      fields: renderFields(section, redacted, fieldErrors),
      notice: noticeText(url.searchParams.get("notice")),
      error,
      validationPassed,
    });
    page(res, status, SECTION_LABELS[section], body, { active: section, session, version });
  }

  // -------------------------------------------------------------------------
  // Audit history
  // -------------------------------------------------------------------------

  async function handleAuditHistory(
    res: ServerResponse,
    url: URL,
    session: AdminSession,
    version: ReturnType<typeof currentVersion>,
  ): Promise<void> {
    const pageParam = Number(url.searchParams.get("page") ?? "1");
    const currentPage = Number.isFinite(pageParam) ? Math.max(Math.trunc(pageParam), 1) : 1;

    const [total, rows] = await Promise.all([
      deps.prisma.auditLog.count(),
      deps.prisma.auditLog.findMany({
        orderBy: { createdAt: "desc" },
        skip: (currentPage - 1) * AUDIT_PAGE_SIZE,
        take: AUDIT_PAGE_SIZE,
      }),
    ]);
    const totalPages = Math.max(Math.ceil(total / AUDIT_PAGE_SIZE), 1);

    const body = renderEjs(AUDIT_TEMPLATE, {
      rows: rows.map((row) => ({
        actor: row.actor,
        action: row.action,
        resource: row.resource,
        createdAt: row.createdAt.toISOString(),
        metadata: row.metadata ? JSON.stringify(row.metadata) : "",
      })),
      page: currentPage,
      totalPages,
    });
    page(res, 200, "Audit History", body, { active: "audit", session, version });
  }
}
