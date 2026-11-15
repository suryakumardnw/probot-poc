/**
 * GitHub OAuth identity adapter.
 *
 * Network I/O belongs to the platform layer: this adapter implements the
 * `GithubOAuthClient` port for the admin module. It only ever uses the admin
 * OAuth user access token for identity/membership lookups, never for
 * repository or review operations.
 *
 * `setGithubFetch` is the test seam: application wiring uses the default
 * fetch, tests replace it with a fake. The client reads the current
 * implementation at call time, so a test can set the fake before or after
 * constructing the client.
 */
import type { GithubFetch, GithubOAuthClient, GithubUser, OrgMembership } from "../../ports/github-oauth.js";
import { GithubOauthError } from "../../shared/errors/index.js";

const GITHUB_BASE = "https://github.com";
const GITHUB_API = "https://api.github.com";

let githubFetchImpl: GithubFetch = fetch;

/** Replace the fetch implementation used for GitHub API calls (tests only). */
export function setGithubFetch(impl: GithubFetch): void {
  githubFetchImpl = impl;
}

/** Restore the real fetch implementation. */
export function resetGithubFetch(): void {
  githubFetchImpl = fetch;
}

/**
 * Exchange an OAuth authorization code for a user access token.
 * The client secret is only sent to GitHub and is never logged or returned.
 */
async function exchangeOAuthCode(
  fetcher: GithubFetch,
  clientId: string | undefined,
  clientSecret: string | undefined,
  code: string,
): Promise<string> {
  const response = await fetcher(`${GITHUB_BASE}/login/oauth/access_token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
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
async function fetchGithubUser(fetcher: GithubFetch, accessToken: string): Promise<GithubUser> {
  const response = await fetcher(`${GITHUB_API}/user`, {
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
async function fetchOrgMembership(
  fetcher: GithubFetch,
  org: string,
  login: string,
  accessToken: string,
): Promise<OrgMembership | null> {
  const response = await fetcher(
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

/** Create a GitHub OAuth client bound to the current test/production fetch. */
export function createGithubOAuthClient(fetchImpl?: GithubFetch): GithubOAuthClient {
  const getFetcher = (): GithubFetch => fetchImpl ?? githubFetchImpl;
  return {
    exchangeOAuthCode: (env, code) =>
      exchangeOAuthCode(getFetcher(), env.ADMIN_OAUTH_CLIENT_ID, env.ADMIN_OAUTH_CLIENT_SECRET, code),
    fetchUser: (accessToken) => fetchGithubUser(getFetcher(), accessToken),
    fetchOrgMembership: (org, login, accessToken) => fetchOrgMembership(getFetcher(), org, login, accessToken),
  };
}
