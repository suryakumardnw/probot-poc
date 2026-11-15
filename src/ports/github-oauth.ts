/**
 * GitHub OAuth identity port.
 *
 * The admin module owns authorization policy and sessions; the platform
 * adapter owns the outbound HTTP calls. Tests inject a fake `GithubFetch` or
 * client through the same port.
 */

import type { Env } from "../contracts/config.js";

/** Fetch-compatible function used by the GitHub OAuth adapter. */
export type GithubFetch = typeof fetch;

export interface GithubUser {
  login: string;
  id: number;
}

export interface OrgMembership {
  /** "admin" = organization owner, "member" = ordinary member. */
  role: "admin" | "member";
  state: "active" | "pending";
}

export interface GithubOAuthClient {
  /** Exchange an OAuth authorization code for a user access token. */
  exchangeOAuthCode(
    env: Pick<Env, "ADMIN_OAUTH_CLIENT_ID" | "ADMIN_OAUTH_CLIENT_SECRET">,
    code: string,
  ): Promise<string>;
  /** Fetch the authenticated GitHub user profile. */
  fetchUser(accessToken: string): Promise<GithubUser>;
  /** Fetch org membership; null means not a member (GitHub 404). */
  fetchOrgMembership(org: string, login: string, accessToken: string): Promise<OrgMembership | null>;
}
