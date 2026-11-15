import { describe, expect, test } from "vitest";
import {
  githubOauthTokenErrorSchema,
  githubOauthTokenSuccessSchema,
  githubOrgMembershipResponseSchema,
  githubUserResponseSchema,
} from "./github.js";

/**
 * Contract tests for the GitHub OAuth identity wire shapes. The adapter's
 * malformed-response behavior is covered in `test/github-oauth-client.test.ts`;
 * these tests pin the schemas themselves.
 */

describe("GitHub OAuth token response contracts", () => {
  test("accepts a success body and ignores fields the adapter does not read", () => {
    const parsed = githubOauthTokenSuccessSchema.parse({
      access_token: "ghu_example",
      token_type: "bearer",
      scope: "read:org",
    });

    expect(parsed.access_token).toBe("ghu_example");
  });

  test("rejects a success body without a usable access token", () => {
    expect(githubOauthTokenSuccessSchema.safeParse({ token_type: "bearer" }).success).toBe(false);
    expect(githubOauthTokenSuccessSchema.safeParse({ access_token: "" }).success).toBe(false);
    expect(githubOauthTokenSuccessSchema.safeParse({ access_token: 42 }).success).toBe(false);
  });

  test("accepts an error body with GitHub's code and description", () => {
    const parsed = githubOauthTokenErrorSchema.parse({
      error: "bad_verification_code",
      error_description: "The code passed is incorrect or expired.",
      error_uri:
        "https://docs.github.com/apps/managing-oauth-apps/troubleshooting-oauth-app-access-token-request-errors",
    });

    expect(parsed).toMatchObject({
      error: "bad_verification_code",
      error_description: "The code passed is incorrect or expired.",
    });
  });

  test("rejects an error body without a usable error code", () => {
    expect(githubOauthTokenErrorSchema.safeParse({ error_description: "expired" }).success).toBe(false);
    expect(githubOauthTokenErrorSchema.safeParse({ error: "" }).success).toBe(false);
    expect(githubOauthTokenErrorSchema.safeParse({ error: 500 }).success).toBe(false);
    expect(githubOauthTokenErrorSchema.safeParse({ error: "bad_code", error_description: 42 }).success).toBe(false);
  });
});

describe("GitHub user response contract", () => {
  test("accepts the identity fields and ignores the rest of the profile", () => {
    const parsed = githubUserResponseSchema.parse({
      login: "octocat",
      id: 583231,
      avatar_url: "https://avatars.githubusercontent.com/u/583231",
      type: "User",
    });

    expect(parsed).toMatchObject({ login: "octocat", id: 583231 });
  });

  test("rejects a payload without the fields the adapter consumes", () => {
    expect(githubUserResponseSchema.safeParse({ id: 583231 }).success).toBe(false);
    expect(githubUserResponseSchema.safeParse({ login: "", id: 583231 }).success).toBe(false);
    expect(githubUserResponseSchema.safeParse({ login: "octocat" }).success).toBe(false);
    expect(githubUserResponseSchema.safeParse({ login: "octocat", id: "583231" }).success).toBe(false);
    expect(githubUserResponseSchema.safeParse({ login: "octocat", id: 1.5 }).success).toBe(false);
  });
});

describe("GitHub organization membership response contract", () => {
  test("accepts an active admin membership and ignores GitHub's extra fields", () => {
    const parsed = githubOrgMembershipResponseSchema.parse({
      role: "admin",
      state: "active",
      url: "https://api.github.com/orgs/octo-org/memberships/octocat",
      organization_url: "https://api.github.com/orgs/octo-org",
    });

    expect(parsed).toMatchObject({ role: "admin", state: "active" });
  });

  test("accepts a pending ordinary membership", () => {
    expect(githubOrgMembershipResponseSchema.parse({ role: "member", state: "pending" })).toEqual({
      role: "member",
      state: "pending",
    });
  });

  test("rejects missing or unknown role and state values", () => {
    expect(githubOrgMembershipResponseSchema.safeParse({ role: "admin" }).success).toBe(false);
    expect(githubOrgMembershipResponseSchema.safeParse({ state: "active" }).success).toBe(false);
    expect(githubOrgMembershipResponseSchema.safeParse({ role: "owner", state: "active" }).success).toBe(false);
    expect(githubOrgMembershipResponseSchema.safeParse({ role: "admin", state: "inactive" }).success).toBe(false);
    expect(githubOrgMembershipResponseSchema.safeParse({ role: 1, state: "active" }).success).toBe(false);
  });
});
