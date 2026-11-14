import type { Env } from "../config/env.js";

/**
 * GitHub OAuth + organization membership client (ticket 10, §14.2).
 *
 * The admin OAuth identity is SEPARATE from the GitHub App installation
 * identity: this client only ever uses the admin OAuth user access token for
 * identity/membership lookups, never for repository or review operations.
 *
 * All network access goes through an injectable fetch seam so tests can mock
 * GitHub's OAuth and org-membership endpoints without real HTTP.
 */

export type GithubFetch = typeof fetch;

let githubFetchImpl: GithubFetch = fetch;

/** Replace the fetch implementation used for GitHub API calls (tests only). */
export function setGithubFetch(impl: GithubFetch): void {
  githubFetchImpl = impl;
}

/** Restore the real fetch implementation. */
export function resetGithubFetch(): void {
  githubFetchImpl = fetch;
}

export class GithubOauthError extends Error {
  readonly code: string;
  readonly status?: number;
  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = "GithubOauthError";
    this.code = code;
    this.status = status;
  }
}

export interface GithubUser {
  login: string;
  id: number;
}

export interface OrgMembership {
  /** "admin" = organization owner, "member" = ordinary member. */
  role: "admin" | "member";
  state: "active" | "pending";
}

const GITHUB_BASE = "https://github.com";
const GITHUB_API = "https://api.github.com";

/** Build the GitHub authorize URL for the admin OAuth web flow. */
export function buildAuthorizeUrl(
  env: Pick<Env, "ADMIN_OAUTH_CLIENT_ID" | "ADMIN_OAUTH_CALLBACK_URL">,
  state: string,
): string {
  const url = new URL("/login/oauth/authorize", GITHUB_BASE);
  url.searchParams.set("client_id", env.ADMIN_OAUTH_CLIENT_ID!);
  url.searchParams.set("redirect_uri", env.ADMIN_OAUTH_CALLBACK_URL!);
  url.searchParams.set("scope", "read:org");
  url.searchParams.set("state", state);
  return url.toString();
}

/**
 * Exchange an OAuth authorization code for a user access token.
 * The client secret is only sent to GitHub and is never logged or returned.
 */
export async function exchangeOAuthCode(
  env: Pick<Env, "ADMIN_OAUTH_CLIENT_ID" | "ADMIN_OAUTH_CLIENT_SECRET">,
  code: string,
): Promise<string> {
  const response = await githubFetchImpl(`${GITHUB_BASE}/login/oauth/access_token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: env.ADMIN_OAUTH_CLIENT_ID,
      client_secret: env.ADMIN_OAUTH_CLIENT_SECRET,
      code,
    }),
  });
  if (!response.ok) {
    throw new GithubOauthError("token_exchange_failed", `GitHub token exchange failed (${response.status})`);
  }
  const body = (await response.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!body.access_token) {
    // GitHub reports failures with error codes; the description is GitHub's
    // own message about the code — it never contains the client secret.
    throw new GithubOauthError(
      body.error ?? "token_exchange_failed",
      body.error_description ?? "GitHub did not return an access token",
    );
  }
  return body.access_token;
}

/** Fetch the authenticated GitHub user profile. */
export async function fetchGithubUser(accessToken: string): Promise<GithubUser> {
  const response = await githubFetchImpl(`${GITHUB_API}/user`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (response.status === 401) {
    throw new GithubOauthError("invalid_token", "GitHub rejected the admin access token", 401);
  }
  if (!response.ok) {
    throw new GithubOauthError("github_unavailable", `GitHub user lookup failed (${response.status})`);
  }
  const body = (await response.json()) as { login?: string; id?: number };
  if (!body.login || typeof body.id !== "number") {
    throw new GithubOauthError("unexpected_response", "GitHub user payload was missing expected fields");
  }
  return { login: body.login, id: body.id };
}

/**
 * Verify the user's membership in the configured organization and report the
 * org role. Returns null when the user is NOT a member (404 from GitHub).
 */
export async function fetchOrgMembership(
  org: string,
  login: string,
  accessToken: string,
): Promise<OrgMembership | null> {
  const response = await githubFetchImpl(
    `${GITHUB_API}/orgs/${encodeURIComponent(org)}/memberships/${encodeURIComponent(login)}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (response.status === 404) {
    return null; // Not a member of the organization.
  }
  if (response.status === 401) {
    throw new GithubOauthError("invalid_token", "GitHub rejected the admin access token", 401);
  }
  if (!response.ok) {
    throw new GithubOauthError("github_unavailable", `GitHub membership lookup failed (${response.status})`);
  }
  const body = (await response.json()) as { role?: string; state?: string };
  const role = body.role === "admin" ? "admin" : "member";
  const state = body.state === "pending" ? "pending" : "active";
  return { role, state };
}
