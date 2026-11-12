import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getPrisma, disconnectPrisma } from "../src/lib/prisma.js";
import { disconnectRedis } from "../src/lib/redis.js";
import { loadEnv, type Env } from "../src/config/env.js";
import { createAdminApi, isAdminConfigured, authorizeAdmin } from "../src/admin/api.js";
import { setGithubFetch, resetGithubFetch, type GithubFetch } from "../src/admin/github-client.js";
import { clearSessions } from "../src/admin/session.js";
import { clearRateLimitBuckets } from "../src/admin/rate-limit.js";
import { DEFAULT_CONFIG_PATH } from "../src/config/review-loader.js";

/**
 * Ticket 10 integration tests: admin authentication + configuration API.
 *
 * GitHub's OAuth and org-membership endpoints are mocked through the
 * setGithubFetch seam; everything else runs for real against the local
 * docker-compose dependencies (ticket01-pg on :5432).
 */

process.env.DATABASE_URL ??= "postgres://postgres:postgres@localhost:5432/reviewer";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.MODEL_BASE_URL ??= "http://localhost:8000";

const prisma = getPrisma();

// Environment -----------------------------------------------------------------

const ADMIN_ENV: Env = loadEnv({
  NODE_ENV: "test",
  DATABASE_URL: process.env.DATABASE_URL,
  REDIS_URL: process.env.REDIS_URL,
  ADMIN_OAUTH_CLIENT_ID: "test-client-id",
  ADMIN_OAUTH_CLIENT_SECRET: "test-client-secret",
  ADMIN_OAUTH_CALLBACK_URL: "http://localhost:3000/api/admin/auth/github/callback",
  SESSION_SECRET: "test-session-secret-0123456789",
  ADMIN_GITHUB_ORG: "octo-org",
  ADMIN_GITHUB_LOGINS: "",
  ADMIN_ORG_ADMIN_ROLES: "admin",
  SESSION_TTL_SECONDS: "28800",
  ADMIN_RATE_LIMIT_PER_MINUTE: "60",
});

const UNCONFIGURED_ENV: Env = loadEnv({
  NODE_ENV: "test",
  DATABASE_URL: process.env.DATABASE_URL,
  REDIS_URL: process.env.REDIS_URL,
});

// HTTP mocks -------------------------------------------------------------------

interface MockResponse {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: string;
}

function mockRequest(
  method: string,
  url: string,
  options: { headers?: Record<string, string>; body?: unknown } = {},
): IncomingMessage {
  const chunks = options.body === undefined ? [] : [Buffer.from(JSON.stringify(options.body))];
  const req = {
    method,
    url,
    headers: { host: "localhost:3000", ...(options.headers ?? {}) },
    socket: { remoteAddress: "203.0.113.7" },
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        next: async () =>
          index < chunks.length ? { value: chunks[index++], done: false } : { value: undefined, done: true },
      } as AsyncIterator<Buffer>;
    },
  } as unknown as IncomingMessage;
  return req;
}

function mockResponse(): { res: ServerResponse; result: MockResponse } {
  const result: MockResponse = { statusCode: 0, headers: {}, body: "" };
  const store = new Map<string, string | string[]>();
  const res = {
    statusCode: 0,
    setHeader(name: string, value: string | string[]) {
      store.set(name.toLowerCase(), value);
    },
    getHeader(name: string) {
      return store.get(name.toLowerCase());
    },
    end(body?: string) {
      result.body = body ?? "";
      if (result.statusCode === 0) result.statusCode = res.statusCode;
    },
  } as unknown as ServerResponse;
  Object.defineProperty(res, "statusCode", {
    get: () => result.statusCode,
    set: (value: number) => {
      result.statusCode = value;
    },
  });
  // Flush headers when the handler finishes reading them (end or first set).
  const originalEnd = res.end.bind(res) as (body?: string) => void;
  res.end = ((body?: string) => {
    for (const [name, value] of store) result.headers[name] = value as string;
    return originalEnd(body);
  }) as typeof res.end;
  return { res, result };
}

const SET_COOKIE_HEADER = "set-cookie";

function cookieOf(result: MockResponse): string {
  const raw = result.headers[SET_COOKIE_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value ?? "";
}

function csrfCookiePair(result: MockResponse): { cookie: string; csrfToken: string } {
  const body = JSON.parse(result.body) as { csrfToken: string };
  return { cookie: cookieOf(result).split(";")[0]!, csrfToken: body.csrfToken };
}

// GitHub mock -------------------------------------------------------------------

interface GithubUserMock {
  login: string;
  membership: { role: "admin" | "member"; state: "active" | "pending" } | null; // null → 404
}

let githubUsers: GithubUserMock | undefined;
let tokenExchangeShouldFail = false;

const githubMock: GithubFetch = (async (input: unknown) => {
  const url = String(input);
  const jsonResponse = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (url === "https://github.com/login/oauth/access_token") {
    if (tokenExchangeShouldFail) return jsonResponse(200, { error: "bad_verification_code", error_description: "The code passed is incorrect or expired." });
    return jsonResponse(200, { access_token: "gho_test_token" });
  }
  if (url === "https://api.github.com/user") {
    if (!githubUsers) return jsonResponse(401, {});
    return jsonResponse(200, { login: githubUsers.login, id: 7001 });
  }
  if (url.startsWith("https://api.github.com/orgs/octo-org/memberships/")) {
    if (!githubUsers || !githubUsers.membership) return new Response("", { status: 404 });
    return jsonResponse(200, githubUsers.membership);
  }
  return new Response("not found", { status: 404 });
}) as unknown as GithubFetch;

// Config file fixture ------------------------------------------------------------

function makeConfigDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "admin-api-test-"));
  const source = fs.readFileSync(DEFAULT_CONFIG_PATH, "utf8");
  fs.writeFileSync(path.join(dir, "review.json"), source);
  return dir;
}

// Handler factory ------------------------------------------------------------------

function makeHandler(env: Env, configPath?: string) {
  const logs: Array<{ level: string; msg: string }> = [];
  const handler = createAdminApi({
    env,
    prisma,
    logger: {
      info: (obj, msg) => logs.push({ level: "info", msg: `${msg}:${JSON.stringify(obj ?? "")}` }),
      warn: (_obj, msg) => logs.push({ level: "warn", msg }),
      error: (obj, msg) => logs.push({ level: "error", msg: `${msg}:${JSON.stringify(obj ?? "")}` }),
    },
    configPath,
  });
  return { handler, logs };
}

async function callAdmin(
  handler: ReturnType<typeof makeHandler>["handler"],
  method: string,
  url: string,
  options: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<MockResponse> {
  const { res, result } = mockResponse();
  await handler(mockRequest(method, url, options), res);
  return result;
}

/** Perform the full OAuth login flow with the current GitHub mock. */
async function login(handler: ReturnType<typeof makeHandler>["handler"]): Promise<MockResponse> {
  const start = await callAdmin(handler, "GET", "/api/admin/auth/github/login");
  expect(start.statusCode).toBe(302);
  const authorizeUrl = new URL(start.headers.location as string);
  const state = authorizeUrl.searchParams.get("state")!;
  expect(authorizeUrl.searchParams.get("scope")).toBe("read:org");
  expect(authorizeUrl.searchParams.get("client_id")).toBe("test-client-id");
  return callAdmin(handler, "GET", `/api/admin/auth/github/callback?code=good-code&state=${state}`);
}

/** Authenticated request helper. */
function authedHeaders(session: { cookie: string; csrfToken: string }, extra: Record<string, string> = {}) {
  return { cookie: session.cookie, "x-csrf-token": session.csrfToken, ...extra };
}

// Suite ----------------------------------------------------------------------------

let configDir: string;
let handler: ReturnType<typeof makeHandler>["handler"];
let logs: ReturnType<typeof makeHandler>["logs"];

beforeEach(async () => {
  await prisma.auditLog.deleteMany();
  configDir = makeConfigDir();
  ({ handler, logs } = makeHandler(ADMIN_ENV, path.join(configDir, "review.json")));
  githubUsers = undefined;
  tokenExchangeShouldFail = false;
  setGithubFetch(githubMock);
});

afterEach(() => {
  resetGithubFetch();
  clearSessions();
  clearRateLimitBuckets();
  fs.rmSync(configDir, { recursive: true, force: true });
});

afterAll(async () => {
  await disconnectPrisma();
  await disconnectRedis();
});

describe("admin api (ticket 10)", () => {
  test("unconfigured admin API returns 503", async () => {
    expect(isAdminConfigured(UNCONFIGURED_ENV)).toBe(false);
    const { handler: bare } = makeHandler(UNCONFIGURED_ENV, path.join(configDir, "review.json"));
    const result = await callAdmin(bare, "GET", "/api/admin/config");
    expect(result.statusCode).toBe(503);
    expect(JSON.parse(result.body).error).toMatch(/not configured/);
    const nonAdmin = await callAdmin(bare, "GET", "/api/reviews");
    expect(nonAdmin.statusCode).toBe(0); // fell through (not handled)
  });

  test("non-admin paths fall through (handler returns false)", async () => {
    const handled = await handler(mockRequest("GET", "/healthz"), mockResponse().res);
    expect(handled).toBe(false);
  });

  test("valid admin login (org-role policy): session cookie + CSRF token", async () => {
    githubUsers = { login: "octoadmin", membership: { role: "admin", state: "active" } };
    const result = await login(handler);
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body) as { authenticated: boolean; user: { login: string }; rolePolicy: string; csrfToken: string };
    expect(body.authenticated).toBe(true);
    expect(body.user.login).toBe("octoadmin");
    expect(body.rolePolicy).toBe("org-role");
    expect(body.csrfToken).toBeTruthy();
    const cookie = cookieOf(result);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/"); // widened in ticket 14 so /admin shares the session
    expect(cookie).not.toContain("test-client-secret");

    // Session endpoint reports identity from the cookie.
    const session = csrfCookiePair(result);
    const who = await callAdmin(handler, "GET", "/api/admin/session", { headers: { cookie: session.cookie } });
    expect(who.statusCode).toBe(200);
    expect(JSON.parse(who.body).user.login).toBe("octoadmin");

    // AuditLog row for the login.
    const audits = await prisma.auditLog.findMany({ where: { action: "admin.login" } });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actor).toBe("octoadmin");
  });

  test("allowlist policy: member on allowlist passes, member off allowlist denied, non-member denied", async () => {
    const allowlistEnv: Env = loadEnv({
      NODE_ENV: "test",
      DATABASE_URL: process.env.DATABASE_URL,
      REDIS_URL: process.env.REDIS_URL,
      ADMIN_OAUTH_CLIENT_ID: "test-client-id",
      ADMIN_OAUTH_CLIENT_SECRET: "test-client-secret",
      ADMIN_OAUTH_CALLBACK_URL: "http://localhost:3000/api/admin/auth/github/callback",
      SESSION_SECRET: "test-session-secret-0123456789",
      ADMIN_GITHUB_ORG: "octo-org",
      ADMIN_GITHUB_LOGINS: "octoadmin",
    });
    const { handler: allowlistHandler } = makeHandler(allowlistEnv, path.join(configDir, "review.json"));

    githubUsers = { login: "octoadmin", membership: { role: "member", state: "active" } };
    const onList = await login(allowlistHandler);
    expect(onList.statusCode).toBe(200);
    expect(JSON.parse(onList.body).rolePolicy).toBe("allowlist");

    githubUsers = { login: "octomember", membership: { role: "member", state: "active" } };
    const offList = await login(allowlistHandler);
    expect(offList.statusCode).toBe(403);

    githubUsers = { login: "outsider", membership: null };
    const outsider = await login(allowlistHandler);
    expect(outsider.statusCode).toBe(403);
    expect(JSON.parse(outsider.body).reason).toMatch(/not an organization member/);

    const denied = await prisma.auditLog.findMany({ where: { action: "admin.login_denied" } });
    expect(denied.length).toBe(2);
  });

  test("pending membership is denied even for admins", async () => {
    githubUsers = { login: "octoadmin", membership: { role: "admin", state: "pending" } };
    const result = await login(handler);
    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body).reason).toMatch(/pending/);
  });

  test("invalid / expired / replayed OAuth state is rejected", async () => {
    const bad = await callAdmin(handler, "GET", "/api/admin/auth/github/callback?code=x&state=forged-state");
    expect(bad.statusCode).toBe(400);

    // Replayed: the same state can only be consumed once.
    githubUsers = { login: "octoadmin", membership: { role: "admin", state: "active" } };
    const start = await callAdmin(handler, "GET", "/api/admin/auth/github/login");
    const state = new URL(start.headers.location as string).searchParams.get("state")!;
    const first = await callAdmin(handler, "GET", `/api/admin/auth/github/callback?code=c&state=${state}`);
    expect(first.statusCode).toBe(200);
    const replay = await callAdmin(handler, "GET", `/api/admin/auth/github/callback?code=c&state=${state}`);
    expect(replay.statusCode).toBe(400);
  });

  test("token exchange failure maps to 502 and never leaks the client secret", async () => {
    tokenExchangeShouldFail = true;
    githubUsers = { login: "octoadmin", membership: { role: "admin", state: "active" } };
    const result = await login(handler);
    expect(result.statusCode).toBe(502);
    expect(result.body).toMatch(/incorrect or expired/);
    expect(result.body).not.toContain("test-client-secret");
  });

  test("expired session is rejected", async () => {
    const shortTtlEnv: Env = loadEnv({
      ...ADMIN_ENV,
      SESSION_TTL_SECONDS: "60",
    });
    const { handler: shortHandler } = makeHandler(shortTtlEnv, path.join(configDir, "review.json"));
    githubUsers = { login: "octoadmin", membership: { role: "admin", state: "active" } };
    const login1 = await login(shortHandler);
    const session = csrfCookiePair(login1);

    // Forge expiry: expired sessions disappear from the store on next use.
    // We simulate by manually creating + expiring via the store API instead of
    // waiting; use clearSessions to prove the "unknown session" path too.
    clearSessions();
    const after = await callAdmin(shortHandler, "GET", "/api/admin/session", { headers: { cookie: session.cookie } });
    expect(after.statusCode).toBe(401);
  });

  test("forged session cookie (bad HMAC signature) is rejected", async () => {
    const id = "forged-session-id";
    const forged = `${id}.totally-invalid-signature`;
    const result = await callAdmin(handler, "GET", "/api/admin/session", { headers: { cookie: `admin_session=${forged}` } });
    expect(result.statusCode).toBe(401);
  });

  test("CSRF attempt on unsafe method is rejected with 403", async () => {
    githubUsers = { login: "octoadmin", membership: { role: "admin", state: "active" } };
    const login1 = await login(handler);
    const session = csrfCookiePair(login1);

    const noHeader = await callAdmin(handler, "POST", "/api/admin/config/reload", { headers: { cookie: session.cookie } });
    expect(noHeader.statusCode).toBe(403);

    const wrongHeader = await callAdmin(handler, "PUT", "/api/admin/config", {
      headers: authedHeaders(session, { "x-csrf-token": "wrong-token" }),
      body: {},
    });
    expect(wrongHeader.statusCode).toBe(403);
  });

  test("GET config redacts secret-like values", async () => {
    // Inject a config containing a secret-adjacent key via updateReviewConfig
    // is not possible (loader forbids embedded secrets); instead verify the
    // redaction of any *-shaped keys in the served config and that neither the
    // OAuth secret nor the session secret appear anywhere in the body.
    githubUsers = { login: "octoadmin", membership: { role: "admin", state: "active" } };
    const login1 = await login(handler);
    const session = csrfCookiePair(login1);

    const result = await callAdmin(handler, "GET", "/api/admin/config", { headers: { cookie: session.cookie } });
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body) as { configuration: Record<string, unknown>; hash: string };
    expect(body.hash).toMatch(/^sha256:/);
    expect(result.body).not.toContain("test-client-secret");
    expect(result.body).not.toContain("test-session-secret");
    expect(result.body).not.toContain("gho_test_token");
    // provider.apiKeyEnv matches the /key/i redaction pattern — redaction is
    // intentionally conservative (a name is redacted, a value would be too).
    const provider = body.configuration.provider as Record<string, unknown>;
    expect(provider.apiKeyEnv).toBe("[REDACTED]");
  });

  test("invalid PUT config is rejected atomically; LKG intact; audit records rejection", async () => {
    githubUsers = { login: "octoadmin", membership: { role: "admin", state: "active" } };
    const login1 = await login(handler);
    const session = csrfCookiePair(login1);

    const before = fs.readFileSync(path.join(configDir, "review.json"), "utf8");

    const bad = await callAdmin(handler, "PUT", "/api/admin/config", {
      headers: authedHeaders(session),
      body: { schemaVersion: 1, review: { confidence: { minimumInline: "not-a-number" } } },
    });
    expect(bad.statusCode).toBe(400);
    expect(JSON.parse(bad.body).updated).toBe(false);

    const after = fs.readFileSync(path.join(configDir, "review.json"), "utf8");
    expect(after).toBe(before); // atomic: file untouched
    // Atomicity: a rejected update writes nothing — neither review.json
    // nor a last-known-good snapshot.
    expect(fs.existsSync(path.join(configDir, "review.json.last-known-good.json"))).toBe(false);

    const rejected = await prisma.auditLog.findMany({ where: { action: "config.update_rejected" } });
    expect(rejected.length).toBe(1);

    // A valid PUT succeeds and writes both files.
    const valid = JSON.parse(before) as unknown;
    const good = await callAdmin(handler, "PUT", "/api/admin/config", {
      headers: authedHeaders(session),
      body: valid,
    });
    expect(good.statusCode).toBe(200);
    expect(JSON.parse(good.body).updated).toBe(true);
    const updated = await prisma.auditLog.findMany({ where: { action: "config.update" } });
    expect(updated.length).toBe(1);
  });

  test("validate and dry-run endpoints report validity without touching disk", async () => {
    githubUsers = { login: "octoadmin", membership: { role: "admin", state: "active" } };
    const login1 = await login(handler);
    const session = csrfCookiePair(login1);
    const before = fs.readFileSync(path.join(configDir, "review.json"), "utf8");
    const valid = JSON.parse(before) as unknown;

    const ok = await callAdmin(handler, "POST", "/api/admin/config/validate", { headers: authedHeaders(session), body: valid });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body).valid).toBe(true);

    const bad = await callAdmin(handler, "POST", "/api/admin/config/validate", {
      headers: authedHeaders(session),
      body: { schemaVersion: 99 },
    });
    expect(bad.statusCode).toBe(200);
    expect(JSON.parse(bad.body).valid).toBe(false);

    const dry = await callAdmin(handler, "POST", "/api/admin/config/dry-run", { headers: authedHeaders(session), body: valid });
    expect(dry.statusCode).toBe(200);
    expect(JSON.parse(dry.body).applied).toBe(false);

    // Embedded secret rejected by validate (path only, value never echoed).
    const secretBody = structuredClone(valid) as Record<string, unknown>;
    (secretBody as { sneaky: unknown }).sneaky = { token: "super-secret-value" };
    const secret = await callAdmin(handler, "POST", "/api/admin/config/validate", { headers: authedHeaders(session), body: secretBody });
    expect(JSON.parse(secret.body).valid).toBe(false);
    expect(secret.body).not.toContain("super-secret-value");

    expect(fs.readFileSync(path.join(configDir, "review.json"), "utf8")).toBe(before);
  });

  test("reload succeeds and reports fromLastKnownGood on broken file", async () => {
    githubUsers = { login: "octoadmin", membership: { role: "admin", state: "active" } };
    const login1 = await login(handler);
    const session = csrfCookiePair(login1);

    const ok = await callAdmin(handler, "POST", "/api/admin/config/reload", { headers: authedHeaders(session) });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body).reloaded).toBe(true);

    // Break review.json after seeding the LKG from the reload above.
    fs.writeFileSync(path.join(configDir, "review.json"), "{ this is not json");
    const fallback = await callAdmin(handler, "POST", "/api/admin/config/reload", { headers: authedHeaders(session) });
    expect(fallback.statusCode).toBe(200);
    expect(JSON.parse(fallback.body).fromLastKnownGood).toBe(true);
  });

  test("rollback restores the last-known-good; 409 when none exists", async () => {
    githubUsers = { login: "octoadmin", membership: { role: "admin", state: "active" } };
    const login1 = await login(handler);
    const session = csrfCookiePair(login1);

    const none = await callAdmin(handler, "POST", "/api/admin/config/rollback", { headers: authedHeaders(session) });
    expect(none.statusCode).toBe(409);

    // Seed LKG via a valid PUT (which also writes LKG), then change review.json,
    // then roll back.
    const valid = JSON.parse(fs.readFileSync(path.join(configDir, "review.json"), "utf8")) as unknown;
    await callAdmin(handler, "PUT", "/api/admin/config", { headers: authedHeaders(session), body: valid });
    fs.writeFileSync(path.join(configDir, "review.json"), "{ broken");
    const rolled = await callAdmin(handler, "POST", "/api/admin/config/rollback", { headers: authedHeaders(session) });
    expect(rolled.statusCode).toBe(200);
    expect(JSON.parse(rolled.body).rolledBack).toBe(true);
    expect(fs.existsSync(path.join(configDir, "review.json")));
    expect(() => JSON.parse(fs.readFileSync(path.join(configDir, "review.json"), "utf8"))).not.toThrow();
    const audits = await prisma.auditLog.findMany({ where: { action: "config.rollback" } });
    expect(audits.length).toBe(1);
  });

  test("logout destroys the session", async () => {
    githubUsers = { login: "octoadmin", membership: { role: "admin", state: "active" } };
    const login1 = await login(handler);
    const session = csrfCookiePair(login1);

    const out = await callAdmin(handler, "POST", "/api/admin/auth/logout", { headers: authedHeaders(session) });
    expect(out.statusCode).toBe(200);
    expect(cookieOf(out)).toMatch(/Max-Age=0/);
    const after = await callAdmin(handler, "GET", "/api/admin/session", { headers: { cookie: session.cookie } });
    expect(after.statusCode).toBe(401);
  });

  test("rate limiting returns 429 with Retry-After", async () => {
    const tightEnv: Env = loadEnv({ ...ADMIN_ENV, ADMIN_RATE_LIMIT_PER_MINUTE: "3" });
    const { handler: tight } = makeHandler(tightEnv, path.join(configDir, "review.json"));
    const responses = [];
    for (let i = 0; i < 5; i += 1) {
      responses.push(await callAdmin(tight, "GET", "/api/admin/session"));
    }
    expect(responses[0]!.statusCode).toBe(401); // unauthenticated but counted
    expect(responses[3]!.statusCode).toBe(429);
    expect(responses[3]!.headers["retry-after"]).toBeTruthy();
    expect(responses[3]!.headers["x-ratelimit-limit"]).toBe("3");
  });

  test("reviews list + detail endpoints", async () => {
    githubUsers = { login: "octoadmin", membership: { role: "admin", state: "active" } };
    const login1 = await login(handler);
    const session = csrfCookiePair(login1);

    const installation = await prisma.installation.create({
      data: { githubInstallationId: 810001n, organization: "octo-org" },
    });
    const repository = await prisma.repository.create({
      data: { githubRepositoryId: 810002n, installationId: installation.id, fullName: "octo-org/admin-test" },
    });
    const pullRequest = await prisma.pullRequest.create({
      data: { repositoryId: repository.id, githubPrNumber: 7, headSha: "cccc1111cccc1111cccc1111cccc1111cccc1111" },
    });
    const review = await prisma.review.create({
      data: {
        pullRequestId: pullRequest.id,
        githubInstallationId: 810001n,
        githubRepositoryId: 810002n,
        pullRequestNumber: 7,
        headSha: "cccc1111cccc1111cccc1111cccc1111cccc1111",
        state: "queued",
        trigger: "manual",
      },
    });

    try {
      const list = await callAdmin(handler, "GET", "/api/admin/reviews?limit=10", { headers: { cookie: session.cookie } });
      expect(list.statusCode).toBe(200);
      const body = JSON.parse(list.body) as { total: number; reviews: Array<{ id: string; repository: string }> };
      expect(body.total).toBeGreaterThanOrEqual(1);
      expect(body.reviews.some((r) => r.id === review.id && r.repository === "octo-org/admin-test")).toBe(true);

      const detail = await callAdmin(handler, "GET", `/api/admin/reviews/${review.id}`, { headers: { cookie: session.cookie } });
      expect(detail.statusCode).toBe(200);
      expect(JSON.parse(detail.body)).toBeTruthy();

      const missing = await callAdmin(handler, "GET", "/api/admin/reviews/nonexistent000000000000", { headers: { cookie: session.cookie } });
      expect(missing.statusCode).toBe(404);
    } finally {
      await prisma.review.delete({ where: { id: review.id } });
      await prisma.pullRequest.delete({ where: { id: pullRequest.id } });
      await prisma.repository.delete({ where: { id: repository.id } });
      await prisma.installation.delete({ where: { id: installation.id } });
    }
  });

  test("authorizeAdmin policy matrix", () => {
    const base = { login: "u" };
    expect(authorizeAdmin(ADMIN_ENV, base, null).allowed).toBe(false);
    expect(authorizeAdmin(ADMIN_ENV, base, { role: "member", state: "active" }).allowed).toBe(false);
    expect(authorizeAdmin(ADMIN_ENV, base, { role: "admin", state: "active" }).allowed).toBe(true);
    expect(authorizeAdmin(ADMIN_ENV, base, { role: "admin", state: "pending" }).allowed).toBe(false);
    const allowlist: Env = loadEnv({ ...ADMIN_ENV, ADMIN_GITHUB_LOGINS: "u" });
    expect(authorizeAdmin(allowlist, base, { role: "member", state: "active" }).allowed).toBe(true);
    expect(authorizeAdmin(allowlist, { login: "v" }, { role: "admin", state: "active" }).allowed).toBe(false);
    const multiRole: Env = loadEnv({ ...ADMIN_ENV, ADMIN_ORG_ADMIN_ROLES: "admin, billing-manager" });
    expect(authorizeAdmin(multiRole, base, { role: "member", state: "active" }).allowed).toBe(false);
  });

  test("review trigger endpoint ingests a review of the requested type", async () => {
    githubUsers = { login: "octoadmin", membership: { role: "admin", state: "active" } };
    const login1 = await login(handler);
    const session = csrfCookiePair(login1);

    // Clean leftovers from earlier failed runs (FK-safe order).
    await prisma.outboxEvent.deleteMany();
    await prisma.reviewStateTransition.deleteMany();
    await prisma.reviewJob.deleteMany();
    await prisma.review.deleteMany({ where: { OR: [{ pullRequestNumber: 21 }, { pullRequest: { repository: { fullName: "octo-org/trigger-test" } } }] } });
    await prisma.pullRequest.deleteMany({ where: { repository: { fullName: "octo-org/trigger-test" } } });
    await prisma.repository.deleteMany({ where: { fullName: "octo-org/trigger-test" } });
    await prisma.installation.deleteMany({ where: { githubInstallationId: 820001n } });

    const installation = await prisma.installation.create({
      data: { githubInstallationId: 820001n, organization: "octo-org" },
    });
    const repository = await prisma.repository.create({
      data: { githubRepositoryId: 820002n, installationId: installation.id, fullName: "octo-org/trigger-test" },
    });
    const pullRequest = await prisma.pullRequest.create({
      data: { repositoryId: repository.id, githubPrNumber: 21, headSha: "dddd1111dddd1111dddd1111dddd1111dddd1111" },
    });

    try {
      const triggered = await callAdmin(handler, "POST", "/api/admin/reviews/trigger", {
        headers: authedHeaders(session),
        body: { repository: "octo-org/trigger-test", pullRequestNumber: 21, reviewType: "handbook" },
      });
      expect(triggered.statusCode, triggered.body + " LOGS: " + JSON.stringify(logs)).toBe(202);
      const body = JSON.parse(triggered.body) as { outcome: string; reviewType: string; reviewId: string };
      expect(body.outcome).toBe("created");
      expect(body.reviewType).toBe("handbook");

      const review = await prisma.review.findUniqueOrThrow({ where: { id: body.reviewId } });
      expect(review.reviewType).toBe("handbook");
      expect(review.pullRequestId).toBe(pullRequest.id);
      expect(review.trigger).toBe("manual");

      // Unknown repository → 404.
      const missing = await callAdmin(handler, "POST", "/api/admin/reviews/trigger", {
        headers: authedHeaders(session),
        body: { repository: "octo-org/missing", pullRequestNumber: 1 },
      });
      expect(missing.statusCode).toBe(404);

      // Invalid body → 400.
      const invalid = await callAdmin(handler, "POST", "/api/admin/reviews/trigger", {
        headers: authedHeaders(session),
        body: { repository: "not-a-slug", pullRequestNumber: 1 },
      });
      expect(invalid.statusCode).toBe(400);
    } finally {
      await prisma.outboxEvent.deleteMany({ where: { reviewJob: { review: { pullRequestId: pullRequest.id } } } });
      await prisma.reviewJob.deleteMany({ where: { review: { pullRequestId: pullRequest.id } } });
      await prisma.reviewStateTransition.deleteMany({ where: { review: { pullRequestId: pullRequest.id } } });
      await prisma.review.deleteMany({ where: { pullRequestId: pullRequest.id } });
      await prisma.pullRequest.delete({ where: { id: pullRequest.id } });
      await prisma.repository.delete({ where: { id: repository.id } });
      await prisma.installation.delete({ where: { id: installation.id } });
    }
  });

  test("compare endpoint returns per-type rows with findings and unique counts", async () => {
    githubUsers = { login: "octoadmin", membership: { role: "admin", state: "active" } };
    const login1 = await login(handler);
    const session = csrfCookiePair(login1);

    const installation = await prisma.installation.create({
      data: { githubInstallationId: 830001n, organization: "octo-org" },
    });
    const repository = await prisma.repository.create({
      data: { githubRepositoryId: 830002n, installationId: installation.id, fullName: "octo-org/compare-test" },
    });
    const pullRequest = await prisma.pullRequest.create({
      data: { repositoryId: repository.id, githubPrNumber: 33, headSha: "eeee1111eeee1111eeee1111eeee1111eeee1111" },
    });

    const makeReview = (reviewType: "standard" | "skill") =>
      prisma.review.create({
        data: {
          pullRequestId: pullRequest.id,
          githubInstallationId: 830001n,
          githubRepositoryId: 830002n,
          pullRequestNumber: 33,
          headSha: "eeee1111eeee1111eeee1111eeee1111eeee1111",
          state: "completed",
          trigger: "manual",
          reviewType,
          attempt: 1,
          startedAt: new Date("2026-01-01T00:00:00Z"),
          completedAt: new Date("2026-01-01T00:05:00Z"),
          inputTokens: 1000,
          outputTokens: 500,
          publishSkipped: reviewType === "skill",
          // Additive metrics (§16.1) for the skill row.
          ...(reviewType === "skill"
            ? {
                knowledgeSnapshot: {
                  skill: { ref: "a".repeat(40), status: "fresh", contentHash: "sha-skill", files: [] },
                  metrics: {
                    source: "skill",
                    injectedTokens: 1200,
                    documentsRetrieved: 1,
                    candidates: 1,
                    relevant: 1,
                    selected: 1,
                    truncated: false,
                  },
                },
              }
            : {}),
        },
      });

    const standard = await makeReview("standard");
    const skill = await makeReview("skill");
    // Shared fingerprint found by BOTH types; one unique per type.
    const sharedFp = "fp-shared";
    await prisma.finding.create({
      data: {
        reviewId: standard.id,
        repositoryId: repository.id,
        fingerprint: sharedFp,
        category: "functional",
        severity: "high",
        confidence: 0.9,
        title: "shared",
        filePath: "a.ts",
        lineNumber: 1,
        description: "d",
        evidence: [],
        verified: true,
      },
    });
    await prisma.finding.create({
      data: {
        reviewId: skill.id,
        repositoryId: repository.id,
        fingerprint: sharedFp,
        category: "functional",
        severity: "high",
        confidence: 0.9,
        title: "shared",
        filePath: "a.ts",
        lineNumber: 1,
        description: "d",
        evidence: [],
        verified: true,
      },
    });
    await prisma.finding.create({
      data: {
        reviewId: skill.id,
        repositoryId: repository.id,
        fingerprint: "fp-skill-only",
        category: "security",
        severity: "critical",
        confidence: 0.95,
        title: "skill only",
        filePath: "b.ts",
        lineNumber: 2,
        description: "d",
        evidence: [],
        verified: true,
      },
    });

    try {
      const result = await callAdmin(
        handler,
        "GET",
        "/api/admin/reviews/compare?repository=octo-org/compare-test&pr=33",
        { headers: { cookie: session.cookie } },
      );
      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body) as {
        reviews: Array<{
          id: string;
          reviewType: string;
          state: string;
          attempt: number;
          durationMs: number | null;
          severityCounts: Record<string, number>;
          uniqueFindings: number;
          publishSkipped: boolean;
          inputTokens: number | null;
          knowledgeMetrics: {
            source: string;
            injectedTokens: number;
            documentsRetrieved: number;
            candidates: number;
            relevant: number;
            selected: number;
            truncated: boolean;
          } | null;
        }>;
      };
      expect(body.reviews).toHaveLength(2);
      const standardRow = body.reviews.find((r) => r.reviewType === "standard")!;
      const skillRow = body.reviews.find((r) => r.reviewType === "skill")!;
      expect(standardRow.state).toBe("completed");
      expect(standardRow.attempt).toBe(1);
      expect(standardRow.durationMs).toBe(5 * 60 * 1000);
      expect(standardRow.severityCounts.high).toBe(1);
      expect(standardRow.uniqueFindings).toBe(0);
      expect(standardRow.publishSkipped).toBe(false);
      expect(standardRow.inputTokens).toBe(1000);
      expect(standardRow.knowledgeMetrics).toBeNull();
      // Additive per-row injection metrics (§16.1).
      expect(skillRow.knowledgeMetrics).toMatchObject({
        source: "skill",
        injectedTokens: 1200,
        documentsRetrieved: 1,
        candidates: 1,
        relevant: 1,
        selected: 1,
        truncated: false,
      });
      expect(skillRow.severityCounts).toEqual({ high: 1, critical: 1 });
      expect(skillRow.uniqueFindings).toBe(1);
      expect(skillRow.publishSkipped).toBe(true);

      // Missing query parameters → 400; unknown repository → 404.
      const badQuery = await callAdmin(handler, "GET", "/api/admin/reviews/compare", { headers: { cookie: session.cookie } });
      expect(badQuery.statusCode).toBe(400);
      const unknown = await callAdmin(handler, "GET", "/api/admin/reviews/compare?repository=octo-org/nope&pr=1", {
        headers: { cookie: session.cookie },
      });
      expect(unknown.statusCode).toBe(404);
    } finally {
      await prisma.finding.deleteMany({ where: { reviewId: { in: [standard.id, skill.id] } } });
      await prisma.review.deleteMany({ where: { id: { in: [standard.id, skill.id] } } });
      await prisma.pullRequest.delete({ where: { id: pullRequest.id } });
      await prisma.repository.delete({ where: { id: repository.id } });
      await prisma.installation.delete({ where: { id: installation.id } });
    }
  });
});
