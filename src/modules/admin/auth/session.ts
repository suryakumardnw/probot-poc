import { createHmac, randomBytes } from "node:crypto";
import type { Env } from "../../../config/env.js";
import { safeEqual } from "./csrf.js";

/**
 * Admin session management (ticket 10, §14.2).
 *
 * - Opaque session IDs (32 random bytes) signed with SESSION_SECRET (HMAC-SHA256).
 *   The cookie value is `id.signature`; a forged or truncated value is rejected
 *   without touching the store.
 * - Sessions expire (absolute TTL, default 8h) and are stored in-process.
 *   Multi-replica deployments need a shared store (Redis) — noted as a
 *   limitation for ticket 13.
 * - Cookie flags: HttpOnly, SameSite=Lax, Secure in production, Path=/
 *   (widened in ticket 14 so the server-rendered panel at /admin shares the
 *   session with the /api/admin endpoints).
 * - Each session carries a CSRF token that must be echoed in the
 *   `X-CSRF-Token` header on every unsafe request (see `auth/csrf.ts`).
 */

export const SESSION_COOKIE = "admin_session";

export interface AdminSession {
  id: string;
  csrfToken: string;
  login: string;
  githubUserId: number;
  /** How authorization was decided: "allowlist" or "org-role". */
  rolePolicy: "allowlist" | "org-role";
  createdAt: number;
  expiresAt: number;
}

const sessions = new Map<string, AdminSession>();

export function clearSessions(): void {
  sessions.clear();
}

function sign(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

export interface SessionDeps {
  env: Env;
  now?: () => number;
}

export function createSession(
  user: { login: string; id: number },
  rolePolicy: AdminSession["rolePolicy"],
  deps: SessionDeps,
): AdminSession {
  const now = (deps.now ?? Date.now)();
  const session: AdminSession = {
    id: randomBytes(32).toString("base64url"),
    csrfToken: randomBytes(24).toString("base64url"),
    login: user.login,
    githubUserId: user.id,
    rolePolicy,
    createdAt: now,
    expiresAt: now + deps.env.SESSION_TTL_SECONDS * 1000,
  };
  sessions.set(session.id, session);
  return session;
}

/** Signed cookie value for a session. */
export function sessionCookieValue(session: AdminSession, secret: string): string {
  return `${session.id}.${sign(session.id, secret)}`;
}

export function buildSetCookieHeader(session: AdminSession, env: Env): string {
  const parts = [
    `${SESSION_COOKIE}=${sessionCookieValue(session, env.SESSION_SECRET!)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (env.NODE_ENV === "production") {
    parts.push("Secure");
  }
  parts.push(`Expires=${new Date(session.expiresAt).toUTCString()}`);
  return parts.join("; ");
}

export function buildClearCookieHeader(env: Env): string {
  const parts = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (env.NODE_ENV === "production") {
    parts.push("Secure");
  }
  return parts.join("; ");
}

/** Parse the Cookie header and extract the admin session cookie value. */
export function readSessionCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) {
    return undefined;
  }
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) {
      return rest.join("=");
    }
  }
  return undefined;
}

/**
 * Resolve a valid, unexpired session from the request cookie. Verifies the
 * HMAC signature before any lookup and prunes expired entries.
 */
export function getSessionFromCookie(
  cookieValue: string | undefined,
  env: Env,
  now: number = Date.now(),
): AdminSession | null {
  if (!cookieValue || !env.SESSION_SECRET) {
    return null;
  }
  const dot = cookieValue.lastIndexOf(".");
  if (dot <= 0) {
    return null;
  }
  const id = cookieValue.slice(0, dot);
  const signature = cookieValue.slice(dot + 1);
  if (!safeEqual(signature, sign(id, env.SESSION_SECRET))) {
    return null;
  }
  const session = sessions.get(id);
  if (!session) {
    return null;
  }
  if (session.expiresAt <= now) {
    sessions.delete(id);
    return null;
  }
  return session;
}

export function destroySession(sessionId: string): void {
  sessions.delete(sessionId);
}
