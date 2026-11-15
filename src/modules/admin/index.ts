/**
 * Admin module public entry point (ARCHITECTURE.md §14.2, §15).
 *
 * Mounts two HTTP surfaces over the same session/CSRF/config primitives:
 * - the JSON API under `/api/admin/*` (`createAdminApi`), and
 * - the server-rendered HTML panel under `/admin` (`createAdminPanel`).
 *
 * Auditing is behind `AuditRepository`; Prisma lives only in the repository
 * adapter. External code imports this barrel, never the module's internals.
 */

export { createAdminApi } from "./admin.http.js";
export { createAdminService, type AdminService, type AdminServiceDeps } from "./admin.service.js";
export type { AdminApiDeps, AdminLogger, AdminPanelDeps, AdminRequestContext } from "./admin.types.js";
export type {
  AuditAction,
  AuditEntry,
  AuditListInput,
  AuditMetadata,
  AuditPage,
  AuditRecord,
  AuditRepository,
} from "./audit.repository.js";
export { createPrismaAuditRepository, type AuditLogger } from "./prisma-audit.repository.js";
export { CSRF_HEADER, verifyCsrfToken } from "./auth/csrf.js";
export {
  authorizeAdmin,
  clearOauthStates,
  isAdminConfigured,
  isSessionAdmin,
  type AdminAuthorization,
} from "./auth/github-oauth.js";
export type { GithubFetch, GithubUser, OrgMembership } from "../../ports/github-oauth.js";
export { GithubOauthError } from "../../shared/errors/index.js";
export {
  SESSION_COOKIE,
  buildClearCookieHeader,
  buildSetCookieHeader,
  clearSessions,
  createSession,
  destroySession,
  getSessionFromCookie,
  readSessionCookie,
  sessionCookieValue,
  type AdminSession,
  type SessionDeps,
} from "./auth/session.js";
export {
  PANEL_FIELDS,
  PANEL_SECTIONS,
  SECTION_LABELS,
  isPanelSection,
  sensitiveFieldsFor,
  type PanelField,
  type PanelFieldType,
  type PanelSection,
} from "./panel/fields.js";
export { createAdminPanel } from "./panel/panel.http.js";
export {
  checkRateLimit,
  clearRateLimitBuckets,
  clientIpOf,
  type RateLimitOptions,
  type RateLimitResult,
} from "./rate-limit.js";
