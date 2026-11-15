import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import { clearOauthStates, createAdminApi } from "../../src/admin/api.js";
import { resetGithubFetch, setGithubFetch, type GithubFetch } from "../../src/admin/github-client.js";
import { createPrismaAuditRepository } from "../../src/admin/prisma-audit.repository.js";
import { clearRateLimitBuckets } from "../../src/admin/rate-limit.js";
import { clearSessions } from "../../src/admin/session.js";
import { loadEnv, type Env } from "../../src/config/env.js";
import { createReviewConfigStore } from "../../src/config/review-config-store.js";
import { DEFAULT_CONFIG_PATH } from "../../src/config/review-loader.js";
import { adminErrorEnvelopeSchema, type AdminErrorEnvelope } from "../../src/contracts/admin.js";
import { createReviewQueue } from "../../src/ingestion/queue.js";
import { testEnv } from "../helpers/env.js";
import { createTestIngestion } from "../helpers/ingestion.js";
import { cleanDatabase, disconnectDatabase, prisma } from "./support.js";

/**
 * Characterization: admin authentication and authorization (§14.2, §15).
 *
 * Requests go through the real `createAdminApi` HTTP handler. GitHub OAuth and
 * membership calls use the production `setGithubFetch` test seam; sessions,
 * CSRF, rate limiting, audit rows and response bodies are asserted as
 * externally observable behaviour.
 */

process.env.MODEL_BASE_URL ??= "http://localhost:8000";
process.env.MODEL_NAME ??= "glm-4.7-flash";

const reviewQueue = createReviewQueue(testEnv.REDIS_URL);

const BASE_ENV = {
  NODE_ENV: "test",
  ADMIN_OAUTH_CLIENT_ID: "characterization-client",
  ADMIN_OAUTH_CLIENT_SECRET: "characterization-secret",
  ADMIN_OAUTH_CALLBACK_URL: "http://localhost:3000/api/admin/auth/github/callback",
  SESSION_SECRET: "characterization-session-secret-0123456789",
  ADMIN_GITHUB_ORG: "octo-org",
  ADMIN_GITHUB_LOGINS: "",
  ADMIN_ORG_ADMIN_ROLES: "admin",
  SESSION_TTL_SECONDS: "28800",
  ADMIN_RATE_LIMIT_PER_MINUTE: "60",
} as const;

const ADMIN_ENV: Env = loadEnv(BASE_ENV);

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
  return {
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
}

function mockResponse(): { res: ServerResponse; result: MockResponse } {
  const result: MockResponse = { statusCode: 0, headers: {}, body: "" };
  const store = new Map<string, string | string[]>();
  const res = {
    statusCode: 200,
    setHeader(name: string, value: string | string[]) {
      store.set(name.toLowerCase(), value);
    },
    getHeader(name: string) {
      return store.get(name.toLowerCase());
    },
    end(body?: string) {
      result.statusCode = res.statusCode;
      result.body = body ?? "";
      for (const [name, value] of store) {
        result.headers[name] = value;
      }
    },
  } as unknown as ServerResponse;
  return { res, result };
}

interface GithubUserMock {
  login: string;
  membership: { role: "admin" | "member"; state: "active" | "pending" } | null;
}

let githubUser: GithubUserMock | undefined;

const githubMock: GithubFetch = (async (input: unknown) => {
  const url = String(input);
  const jsonResponse = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (url === "https://github.com/login/oauth/access_token") {
    return jsonResponse(200, { access_token: "characterization-oauth-token" });
  }
  if (url === "https://api.github.com/user") {
    return githubUser
      ? jsonResponse(200, { login: githubUser.login, id: 7001 })
      : jsonResponse(401, { message: "Bad credentials" });
  }
  if (url.startsWith("https://api.github.com/orgs/octo-org/memberships/")) {
    if (!githubUser?.membership) {
      return new Response("", { status: 404 });
    }
    return jsonResponse(200, githubUser.membership);
  }
  return new Response("not found", { status: 404 });
}) as unknown as GithubFetch;

interface Handler {
  handler: ReturnType<typeof createAdminApi>;
  logs: Array<{ level: string; msg: string }>;
}

function makeHandler(env: Env, configPath: string): Handler {
  const logs: Array<{ level: string; msg: string }> = [];
  const logger = {
    info: (obj: unknown, msg: string) => logs.push({ level: "info", msg: `${msg}:${JSON.stringify(obj ?? "")}` }),
    warn: (_obj: unknown, msg: string) => logs.push({ level: "warn", msg }),
    error: (obj: unknown, msg: string) => logs.push({ level: "error", msg: `${msg}:${JSON.stringify(obj ?? "")}` }),
  };
  const config = createReviewConfigStore({
    path: configPath,
    env: {
      ...process.env,
      ...Object.fromEntries(Object.entries(env).map(([key, value]) => [key, String(value)])),
    },
  });
  const handler = createAdminApi({
    env,
    audit: createPrismaAuditRepository(prisma, logger),
    ingestion: createTestIngestion({ queue: reviewQueue.queue, config }).services,
    config,
    logger,
  });
  return { handler, logs };
}

async function call(
  handler: Handler["handler"],
  method: string,
  url: string,
  options: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<MockResponse> {
  const { res, result } = mockResponse();
  await handler(mockRequest(method, url, options), res);
  return result;
}

function cookieOf(result: MockResponse): string {
  const raw = result.headers["set-cookie"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value ?? "";
}

function startLogin(handler: Handler["handler"]): Promise<MockResponse> {
  return call(handler, "GET", "/api/admin/auth/github/login");
}

async function loginWith(handler: Handler["handler"], user: GithubUserMock): Promise<MockResponse> {
  githubUser = user;
  const start = await startLogin(handler);
  expect(start.statusCode).toBe(302);
  const authorizeUrl = new URL(start.headers.location as string);
  const state = authorizeUrl.searchParams.get("state");
  if (!state) {
    throw new Error("authorize redirect is missing the OAuth state");
  }
  return call(handler, "GET", `/api/admin/auth/github/callback?code=good-code&state=${encodeURIComponent(state)}`);
}

function sessionOf(result: MockResponse): { cookie: string; csrfToken: string } {
  const body = JSON.parse(result.body) as { csrfToken: string };
  return { cookie: cookieOf(result).split(";")[0]!, csrfToken: body.csrfToken };
}

/** The admin API contract change: every failure is `{ code, message, statusCode, details? }`. */
function errorEnvelope(result: MockResponse, code: string, statusCode: number): AdminErrorEnvelope {
  const body = adminErrorEnvelopeSchema.parse(JSON.parse(result.body));
  expect(body.code).toBe(code);
  expect(body.statusCode).toBe(statusCode);
  expect(body.message.length).toBeGreaterThan(0);
  expect(body).not.toHaveProperty("error");
  return body;
}

let configDir: string;
let handler: Handler["handler"];

beforeEach(async () => {
  await cleanDatabase();
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "characterization-admin-"));
  fs.copyFileSync(DEFAULT_CONFIG_PATH, path.join(configDir, "review.json"));
  githubUser = undefined;
  clearSessions();
  clearOauthStates();
  clearRateLimitBuckets();
  setGithubFetch(githubMock);
  ({ handler } = makeHandler(ADMIN_ENV, path.join(configDir, "review.json")));
});

afterEach(() => {
  resetGithubFetch();
  clearSessions();
  clearOauthStates();
  clearRateLimitBuckets();
  fs.rmSync(configDir, { recursive: true, force: true });
});

afterAll(async () => {
  await reviewQueue.close();
  await cleanDatabase();
  await disconnectDatabase();
});

describe("OAuth state and CSRF (§14.2)", () => {
  test("the authorize redirect carries client, scope and a single-use state", async () => {
    const start = await startLogin(handler);
    expect(start.statusCode).toBe(302);
    const authorizeUrl = new URL(start.headers.location as string);
    expect(authorizeUrl.origin).toBe("https://github.com");
    expect(authorizeUrl.searchParams.get("client_id")).toBe("characterization-client");
    expect(authorizeUrl.searchParams.get("scope")).toBe("read:org");
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(BASE_ENV.ADMIN_OAUTH_CALLBACK_URL);
    const state = authorizeUrl.searchParams.get("state");
    expect(state).toBeTruthy();

    githubUser = { login: "octoadmin", membership: { role: "admin", state: "active" } };
    const callback = await call(
      handler,
      "GET",
      `/api/admin/auth/github/callback?code=good-code&state=${encodeURIComponent(state!)}`,
    );
    expect(callback.statusCode).toBe(200);

    // The state was consumed: replaying the same callback is rejected.
    const replay = await call(
      handler,
      "GET",
      `/api/admin/auth/github/callback?code=good-code&state=${encodeURIComponent(state!)}`,
    );
    expect(replay.statusCode).toBe(400);
    expect(errorEnvelope(replay, "VALIDATION_ERROR", 400).message).toMatch(/oauth state/);

    const denied = await prisma.auditLog.findMany({ where: { action: "admin.login_denied" } });
    expect(denied.some((row) => row.actor === "anonymous")).toBe(true);
  });

  test("a callback without state is rejected and audited", async () => {
    const result = await call(handler, "GET", "/api/admin/auth/github/callback?code=good-code");
    expect(result.statusCode).toBe(400);
    expect(errorEnvelope(result, "VALIDATION_ERROR", 400).message).toMatch(/oauth state/);
    expect(await prisma.auditLog.count({ where: { action: "admin.login_denied" } })).toBe(1);
  });
});

describe("session cookie and logout (§14.2)", () => {
  test("login issues a signed HttpOnly cookie and an authenticated session document", async () => {
    const result = await loginWith(handler, {
      login: "octoadmin",
      membership: { role: "admin", state: "active" },
    });
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body) as {
      authenticated: boolean;
      user: { login: string };
      rolePolicy: string;
      csrfToken: string;
    };
    expect(body.authenticated).toBe(true);
    expect(body.user.login).toBe("octoadmin");
    expect(body.rolePolicy).toBe("org-role");
    expect(body.csrfToken).toBeTruthy();

    const cookie = cookieOf(result);
    expect(cookie).toContain("admin_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toContain("characterization-secret");

    const session = sessionOf(result);
    const who = await call(handler, "GET", "/api/admin/session", { headers: { cookie: session.cookie } });
    expect(who.statusCode).toBe(200);
    expect(JSON.parse(who.body)).toMatchObject({
      authenticated: true,
      user: { login: "octoadmin" },
      rolePolicy: "org-role",
      csrfToken: session.csrfToken,
    });

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "admin.login" } });
    expect(audit).toMatchObject({ actor: "octoadmin", resource: "admin_session" });

    // A forged signature is rejected before any session lookup.
    const tampered = `${session.cookie.slice(0, -1)}${session.cookie.endsWith("A") ? "B" : "A"}`;
    const rejected = await call(handler, "GET", "/api/admin/session", { headers: { cookie: tampered } });
    expect(rejected.statusCode).toBe(401);
  });

  test("logout requires the CSRF token and destroys the session", async () => {
    const login = await loginWith(handler, {
      login: "octoadmin",
      membership: { role: "admin", state: "active" },
    });
    const session = sessionOf(login);

    const missingCsrf = await call(handler, "POST", "/api/admin/auth/logout", {
      headers: { cookie: session.cookie },
    });
    expect(missingCsrf.statusCode).toBe(403);
    expect(errorEnvelope(missingCsrf, "ADMIN_CSRF_FAILED", 403).message).toMatch(/csrf/);

    const loggedOut = await call(handler, "POST", "/api/admin/auth/logout", {
      headers: { cookie: session.cookie, "x-csrf-token": session.csrfToken },
    });
    expect(loggedOut.statusCode).toBe(200);
    expect(JSON.parse(loggedOut.body)).toEqual({ ok: true });
    expect(cookieOf(loggedOut)).toContain("admin_session=;");
    expect(cookieOf(loggedOut)).toContain("Max-Age=0");
    expect(await prisma.auditLog.count({ where: { action: "admin.logout", actor: "octoadmin" } })).toBe(1);

    const afterLogout = await call(handler, "GET", "/api/admin/session", {
      headers: { cookie: session.cookie },
    });
    expect(afterLogout.statusCode).toBe(401);
  });

  test("unauthenticated admin requests get 401 and non-admin paths fall through", async () => {
    const unauthenticated = await call(handler, "GET", "/api/admin/config");
    expect(unauthenticated.statusCode).toBe(401);
    expect(errorEnvelope(unauthenticated, "UNAUTHORIZED", 401).message).toMatch(/authentication required/);

    const session = await call(handler, "GET", "/api/admin/session");
    expect(session.statusCode).toBe(401);

    const handled = await handler(mockRequest("GET", "/healthz"), mockResponse().res);
    expect(handled).toBe(false);
  });
});

describe("organization membership and admin role policy (§14.2)", () => {
  test("non-members and pending members are forbidden and audited", async () => {
    const nonMember = await loginWith(handler, { login: "outsider", membership: null });
    expect(nonMember.statusCode).toBe(403);
    const nonMemberEnvelope = errorEnvelope(nonMember, "ADMIN_ACCESS_DENIED", 403);
    expect(nonMemberEnvelope.message).toBe("admin access denied");
    expect(nonMemberEnvelope.details).toMatchObject({
      reason: expect.stringMatching(/not an organization member/),
    });

    const pending = await loginWith(handler, {
      login: "pending-user",
      membership: { role: "member", state: "pending" },
    });
    expect(pending.statusCode).toBe(403);
    expect(errorEnvelope(pending, "ADMIN_ACCESS_DENIED", 403).details).toMatchObject({
      reason: expect.stringMatching(/pending/),
    });

    const denied = await prisma.auditLog.findMany({ where: { action: "admin.login_denied" } });
    expect(denied.map((row) => row.actor).sort()).toEqual(["outsider", "pending-user"]);
  });

  test("an allowlist wins over the organization role", async () => {
    const allowlistEnv = loadEnv({
      ...BASE_ENV,
      ADMIN_GITHUB_LOGINS: "listed-admin",
      ADMIN_ORG_ADMIN_ROLES: "admin",
    });
    ({ handler } = makeHandler(allowlistEnv, path.join(configDir, "review.json")));
    githubUser = undefined;

    const listed = await loginWith(handler, {
      login: "listed-admin",
      membership: { role: "member", state: "active" },
    });
    expect(listed.statusCode).toBe(200);
    expect(JSON.parse(listed.body).rolePolicy).toBe("allowlist");

    // An organization owner who is not on the allowlist is still denied:
    // membership alone is not admin authority.
    const orgOwner = await loginWith(handler, {
      login: "org-owner",
      membership: { role: "admin", state: "active" },
    });
    expect(orgOwner.statusCode).toBe(403);
    expect(errorEnvelope(orgOwner, "ADMIN_ACCESS_DENIED", 403).details).toMatchObject({
      reason: expect.stringMatching(/allowlist/),
    });

    // The allowlist still requires organization membership.
    const notMember = await loginWith(handler, { login: "listed-admin", membership: null });
    expect(notMember.statusCode).toBe(403);
  });

  test("without an allowlist the configured organization role grants admin", async () => {
    const orgAdmin = await loginWith(handler, {
      login: "org-owner",
      membership: { role: "admin", state: "active" },
    });
    expect(orgAdmin.statusCode).toBe(200);
    expect(JSON.parse(orgAdmin.body).rolePolicy).toBe("org-role");

    const plainMember = await loginWith(handler, {
      login: "plain-member",
      membership: { role: "member", state: "active" },
    });
    expect(plainMember.statusCode).toBe(403);
    expect(errorEnvelope(plainMember, "ADMIN_ACCESS_DENIED", 403).details).toMatchObject({
      reason: expect.stringMatching(/does not grant admin/),
    });
  });
});

describe("rate limiting (§14.2)", () => {
  test("requests beyond the configured budget return 429 with retry metadata", async () => {
    const limitedEnv = loadEnv({ ...BASE_ENV, ADMIN_RATE_LIMIT_PER_MINUTE: "2" });
    ({ handler } = makeHandler(limitedEnv, path.join(configDir, "review.json")));
    clearRateLimitBuckets();
    const headers = { "x-forwarded-for": "198.51.100.23" };

    const first = await call(handler, "GET", "/api/admin/session", { headers });
    expect(first.statusCode).toBe(401);
    expect(first.headers["x-ratelimit-limit"]).toBe("2");
    expect(first.headers["x-ratelimit-remaining"]).toBe("1");

    const second = await call(handler, "GET", "/api/admin/session", { headers });
    expect(second.statusCode).toBe(401);
    expect(second.headers["x-ratelimit-remaining"]).toBe("0");

    const third = await call(handler, "GET", "/api/admin/session", { headers });
    expect(third.statusCode).toBe(429);
    const body = errorEnvelope(third, "RATE_LIMITED", 429);
    expect(body.message).toMatch(/rate limit/);
    const details = body.details;
    if (typeof details !== "object" || details === null || Array.isArray(details)) {
      throw new Error("rate limit details must be an object");
    }
    const retryAfterSeconds = Number(details.retryAfterSeconds);
    expect(retryAfterSeconds).toBeGreaterThan(0);
    expect(third.headers["retry-after"]).toBe(String(retryAfterSeconds));
  });
});
