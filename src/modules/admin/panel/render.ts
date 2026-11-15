import type { ServerResponse } from "node:http";
import ejs from "ejs";
import type { ReviewConfigStore } from "../../../ports/review-config.js";
import { getPath } from "../../../shared/object-path.js";
import type { AdminSession } from "../auth/session.js";
import { PANEL_FIELDS, PANEL_SECTIONS, SECTION_LABELS, type PanelField, type PanelSection } from "./fields.js";
import {
  AUDIT_TEMPLATE,
  INTERSTITIAL_TEMPLATE,
  LAYOUT_TEMPLATE,
  MESSAGE_TEMPLATE,
  OVERVIEW_TEMPLATE,
  PANEL_CSS,
  SECTION_TEMPLATE,
} from "./templates/index.js";

/**
 * Server-rendered admin panel rendering (ticket 14).
 *
 * Templates are EJS sources kept as strings so the TypeScript build stays a
 * plain `tsc` compile (no asset copying) and runtime has no filesystem
 * dependency. All dynamic values are escaped with `<%= %>` unless the value
 * is pre-escaped HTML produced by this renderer.
 *
 * No secrets are ever interpolated: values rendered into forms come from
 * redactConfiguration output only.
 */

const renderEjs = ejs.render;

export interface PanelVersion {
  schemaVersion: number;
  hash: string;
  fromLastKnownGood: boolean;
}

export interface PageOptions {
  active?: string;
  session?: AdminSession | null;
  version?: PanelVersion | null;
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(body);
}

export function redirect(res: ServerResponse, location: string): void {
  res.statusCode = 303;
  res.setHeader("Location", location);
  res.end();
}

export function displayValue(value: unknown): string {
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
export function parseIssuePaths(message: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const match of message.matchAll(/^ {2}- (?:\(root\)|(.+?)): (.+)$/gm)) {
    map.set(match[1] ?? "(root)", match[2] ?? "invalid value");
  }
  return map;
}

// ---------------------------------------------------------------------------
// Field rendering (inputs are pre-rendered, templates stay dumb)
// ---------------------------------------------------------------------------

export interface RenderedField {
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

export function renderFields(
  section: PanelSection,
  config: unknown,
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
// Page layout and body renderers
// ---------------------------------------------------------------------------

export function noticeText(param: string | null): string {
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

export function currentVersion(config: ReviewConfigStore): PanelVersion | null {
  try {
    const loaded = config.load();
    return {
      schemaVersion: loaded.snapshot.schemaVersion,
      hash: loaded.snapshot.hash,
      fromLastKnownGood: loaded.fromLastKnownGood,
    };
  } catch {
    return null; // overview stays renderable even with a broken config
  }
}

export function page(
  res: ServerResponse,
  status: number,
  title: string,
  body: string,
  options: PageOptions = {},
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

export function messagePage(
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

export function renderOverviewBody(options: { csrfToken: string; notice: string; error: string }): string {
  return renderEjs(OVERVIEW_TEMPLATE, {
    nav: PANEL_SECTIONS.map((section) => ({ href: `/admin/${section}`, label: SECTION_LABELS[section] })),
    csrfToken: options.csrfToken,
    notice: options.notice,
    error: options.error,
  });
}

export function renderSectionBody(options: {
  section: PanelSection;
  config: unknown;
  csrfToken: string;
  fieldErrors: Map<string, string>;
  notice: string;
  error: string | null;
  validationPassed: boolean;
}): string {
  return renderEjs(SECTION_TEMPLATE, {
    section: options.section,
    sectionLabel: SECTION_LABELS[options.section],
    csrfToken: options.csrfToken,
    fields: renderFields(options.section, options.config, options.fieldErrors),
    notice: options.notice,
    error: options.error,
    validationPassed: options.validationPassed,
  });
}

export interface SensitiveChange {
  path: string;
  oldValue: string;
  newValue: string;
}

export function renderInterstitialBody(options: {
  section: PanelSection;
  csrfToken: string;
  changes: SensitiveChange[];
  candidateJson: string;
}): string {
  return renderEjs(INTERSTITIAL_TEMPLATE, {
    section: options.section,
    sectionLabel: SECTION_LABELS[options.section],
    changes: options.changes,
    csrfToken: options.csrfToken,
    candidateJson: options.candidateJson,
  });
}

export function renderAuditBody(options: {
  rows: Array<{ actor: string; action: string; resource: string; createdAt: string; metadata: string }>;
  page: number;
  totalPages: number;
}): string {
  return renderEjs(AUDIT_TEMPLATE, options);
}
