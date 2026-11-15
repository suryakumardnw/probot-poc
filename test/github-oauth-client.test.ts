import { describe, expect, test } from "vitest";
import { createGithubOAuthClient } from "../src/platform/github/oauth-client.js";
import type { GithubFetch } from "../src/ports/github-oauth.js";
import { GithubOauthError } from "../src/shared/errors/index.js";
import { instanceOf, rejectionOf } from "./helpers/assert.js";

/**
 * GitHub OAuth adapter boundary tests.
 *
 * Every response body is parsed against `src/contracts/github.ts`; these tests
 * pin that valid payloads keep their existing behavior and that malformed
 * payloads become typed `GithubOauthError`s without leaking the body or token.
 */

const OAUTH_ENV = {
  ADMIN_OAUTH_CLIENT_ID: "test-client",
  ADMIN_OAUTH_CLIENT_SECRET: "test-secret",
} as const;

type Handler = (url: string) => Response | Promise<Response>;

function clientFor(handler: Handler) {
  const fetcher = ((input: string) => handler(String(input))) as unknown as GithubFetch;
  return createGithubOAuthClient(fetcher);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function oauthError(promise: Promise<unknown>): Promise<GithubOauthError> {
  return instanceOf(await rejectionOf(promise), GithubOauthError);
}

describe("token exchange", () => {
  test("returns the access token from a valid success body and ignores extra fields", async () => {
    const client = clientFor(() => json({ access_token: "ghu_valid", token_type: "bearer", scope: "read:org" }));

    await expect(client.exchangeOAuthCode(OAUTH_ENV, "good-code")).resolves.toBe("ghu_valid");
  });

  test("preserves GitHub's error code and description for an OAuth failure body", async () => {
    const client = clientFor(() =>
      json({
        error: "bad_verification_code",
        error_description: "The code passed is incorrect or expired.",
        error_uri: "https://docs.github.com/apps/managing-oauth-apps",
      }),
    );

    const error = await oauthError(client.exchangeOAuthCode(OAUTH_ENV, "bad-code"));
    expect(error.code).toBe("bad_verification_code");
    expect(error.message).toBe("The code passed is incorrect or expired.");
  });

  test("defaults the description when GitHub omits it", async () => {
    const client = clientFor(() => json({ error: "bad_verification_code" }));

    const error = await oauthError(client.exchangeOAuthCode(OAUTH_ENV, "bad-code"));
    expect(error.code).toBe("bad_verification_code");
    expect(error.message).toBe("GitHub did not return an access token");
  });

  test("keeps the status-based failure for a non-2xx token response", async () => {
    const client = clientFor(() => json({ message: "upstream ghu_secret" }, 503));

    const error = await oauthError(client.exchangeOAuthCode(OAUTH_ENV, "code"));
    expect(error.code).toBe("token_exchange_failed");
    expect(error.message).toBe("GitHub token exchange failed (503)");
    expect(error.message).not.toContain("ghu_secret");
  });

  test("rejects a malformed success body without echoing it", async () => {
    const client = clientFor(() => json({ access_token: 42, token: "ghu_secret" }));

    const error = await oauthError(client.exchangeOAuthCode(OAUTH_ENV, "code"));
    expect(error.code).toBe("unexpected_response");
    expect(error.message).toBe("GitHub token exchange response was malformed");
    expect(error.message).not.toContain("ghu_secret");
  });

  test("rejects a non-JSON body without echoing it", async () => {
    const client = clientFor(() => new Response("not-json ghu_secret", { status: 200 }));

    const error = await oauthError(client.exchangeOAuthCode(OAUTH_ENV, "code"));
    expect(error.code).toBe("unexpected_response");
    expect(error.message).toBe("GitHub token exchange response was not valid JSON");
    expect(error.message).not.toContain("ghu_secret");
    expect(error.message).not.toContain("not-json");
  });
});

describe("user lookup", () => {
  test("returns the identity fields from a valid user body", async () => {
    const client = clientFor(() =>
      json({ login: "octocat", id: 583231, avatar_url: "https://avatars.githubusercontent.com/u/583231" }),
    );

    await expect(client.fetchUser("ghu_token")).resolves.toEqual({ login: "octocat", id: 583231 });
  });

  test("maps 401 to invalid_token and other failures to github_unavailable", async () => {
    const rejected = clientFor(() => json({ message: "Bad credentials" }, 401));
    const unavailable = clientFor(() => json({ message: "boom" }, 500));

    const unauthorized = await oauthError(rejected.fetchUser("ghu_token"));
    expect(unauthorized.code).toBe("invalid_token");
    expect(unauthorized.status).toBe(401);

    const failed = await oauthError(unavailable.fetchUser("ghu_token"));
    expect(failed.code).toBe("github_unavailable");
    expect(failed.message).toBe("GitHub user lookup failed (500)");
  });

  test("rejects a payload missing identity fields with the existing safe message", async () => {
    const client = clientFor(() => json({ id: "583231", avatar_url: "ghu_secret" }));

    const error = await oauthError(client.fetchUser("ghu_token"));
    expect(error.code).toBe("unexpected_response");
    expect(error.message).toBe("GitHub user payload was missing expected fields");
    expect(error.message).not.toContain("ghu_secret");
  });

  test("rejects a non-JSON body without echoing it", async () => {
    const client = clientFor(() => new Response("<html>ghu_secret</html>", { status: 200 }));

    const error = await oauthError(client.fetchUser("ghu_token"));
    expect(error.code).toBe("unexpected_response");
    expect(error.message).toBe("GitHub user response was not valid JSON");
    expect(error.message).not.toContain("ghu_secret");
  });
});

describe("organization membership", () => {
  test("returns the parsed role and state", async () => {
    const admin = clientFor(() => json({ role: "admin", state: "active", organization_url: "https://api.github.com" }));
    const pending = clientFor(() => json({ role: "member", state: "pending" }));

    await expect(admin.fetchOrgMembership("octo-org", "octocat", "ghu_token")).resolves.toEqual({
      role: "admin",
      state: "active",
    });
    await expect(pending.fetchOrgMembership("octo-org", "octocat", "ghu_token")).resolves.toEqual({
      role: "member",
      state: "pending",
    });
  });

  test("returns null for a 404 (not a member)", async () => {
    const client = clientFor(() => new Response("", { status: 404 }));

    await expect(client.fetchOrgMembership("octo-org", "outside", "ghu_token")).resolves.toBeNull();
  });

  test("maps 401 to invalid_token and other failures to github_unavailable", async () => {
    const rejected = clientFor(() => json({ message: "Bad credentials" }, 401));
    const unavailable = clientFor(() => json({ message: "boom" }, 502));

    const unauthorized = await oauthError(rejected.fetchOrgMembership("octo-org", "octocat", "ghu_token"));
    expect(unauthorized.code).toBe("invalid_token");
    expect(unauthorized.status).toBe(401);

    const failed = await oauthError(unavailable.fetchOrgMembership("octo-org", "octocat", "ghu_token"));
    expect(failed.code).toBe("github_unavailable");
    expect(failed.message).toBe("GitHub membership lookup failed (502)");
  });

  test("rejects a payload with an unknown role or state instead of guessing", async () => {
    const unknownRole = clientFor(() => json({ role: "owner", state: "active", url: "ghu_secret" }));
    const unknownState = clientFor(() => json({ role: "member", state: "inactive" }));

    for (const client of [unknownRole, unknownState]) {
      const error = await oauthError(client.fetchOrgMembership("octo-org", "octocat", "ghu_token"));
      expect(error.code).toBe("unexpected_response");
      expect(error.message).toBe("GitHub org membership payload was missing expected fields");
      expect(error.message).not.toContain("ghu_secret");
    }
  });

  test("rejects a non-JSON body without echoing it", async () => {
    const client = clientFor(() => new Response("not-json ghu_secret", { status: 200 }));

    const error = await oauthError(client.fetchOrgMembership("octo-org", "octocat", "ghu_token"));
    expect(error.code).toBe("unexpected_response");
    expect(error.message).toBe("GitHub org membership response was not valid JSON");
    expect(error.message).not.toContain("ghu_secret");
  });

  test("encodes the organization and login in the request path", async () => {
    const requests: string[] = [];
    const client = clientFor((url) => {
      requests.push(url);
      return json({ role: "member", state: "active" });
    });

    await client.fetchOrgMembership("octo org", "octo/cat", "ghu_token");

    expect(requests).toEqual(["https://api.github.com/orgs/octo%20org/memberships/octo%2Fcat"]);
  });
});
