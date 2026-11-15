import { randomBytes } from "node:crypto";
import type { Env } from "../../../contracts/config.js";
import type { AdminSession } from "./session.js";

/**
 * Admin GitHub OAuth policy (ticket 10, §14.2).
 *
 * The admin OAuth identity is SEPARATE from the GitHub App installation
 * identity: the platform identity client only ever uses the admin OAuth user
 * access token for identity/membership lookups, never for repository or review
 * operations. Authorization policy, OAuth state and session issuance live
 * here; outbound HTTP lives in `src/platform/github/oauth-client.ts`.
 */

// ---------------------------------------------------------------------------
// Configuration and role policy (§14.2: separate from membership)
// ---------------------------------------------------------------------------

export function isAdminConfigured(env: Env): boolean {
  return Boolean(
    env.ADMIN_OAUTH_CLIENT_ID &&
    env.ADMIN_OAUTH_CLIENT_SECRET &&
    env.ADMIN_OAUTH_CALLBACK_URL &&
    env.SESSION_SECRET &&
    env.ADMIN_GITHUB_ORG,
  );
}

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

/** A session is admin when it would still pass the current allowlist/role policy. */
export function isSessionAdmin(env: Env, session: AdminSession): boolean {
  const allowlist = parseLoginAllowlist(env);
  if (allowlist.length > 0) {
    return session.rolePolicy === "allowlist" && allowlist.includes(session.login);
  }
  return session.rolePolicy === "org-role";
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

export function createOauthState(now: number): string {
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
export function consumeOauthState(state: string | null, now: number): boolean {
  if (!state) {
    return false;
  }
  const pending = oauthStates.get(state);
  oauthStates.delete(state); // single use
  return Boolean(pending && pending.expiresAt > now);
}

// ---------------------------------------------------------------------------
// GitHub OAuth + organization membership client
// ---------------------------------------------------------------------------

const GITHUB_BASE = "https://github.com";

/** Build the GitHub authorize URL for the admin OAuth web flow. */
export function buildAuthorizeUrl(
  env: Pick<Env, "ADMIN_OAUTH_CLIENT_ID" | "ADMIN_OAUTH_CALLBACK_URL">,
  state: string,
): string {
  const clientId = env.ADMIN_OAUTH_CLIENT_ID;
  const callbackUrl = env.ADMIN_OAUTH_CALLBACK_URL;
  if (clientId === undefined || callbackUrl === undefined) {
    // Callers gate this on `isAdminConfigured`; a missing value here is a
    // configuration bug rather than a partially usable authorize URL.
    throw new Error("GitHub OAuth requires ADMIN_OAUTH_CLIENT_ID and ADMIN_OAUTH_CALLBACK_URL");
  }
  const url = new URL("/login/oauth/authorize", GITHUB_BASE);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", callbackUrl);
  url.searchParams.set("scope", "read:org");
  url.searchParams.set("state", state);
  return url.toString();
}
