import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import { createAdminApi } from "../src/admin/api.js";
import { setGithubFetch, resetGithubFetch, type GithubFetch } from "../src/admin/github-client.js";
import { PANEL_FIELDS, PANEL_SECTIONS, SECTION_LABELS } from "../src/admin/panel-fields.js";
import { createAdminPanel } from "../src/admin/panel.js";
import { clearRateLimitBuckets } from "../src/admin/rate-limit.js";
import { clearSessions, createSession, sessionCookieValue } from "../src/admin/session.js";
import { loadEnv, type Env } from "../src/config/env.js";
import { DEFAULT_CONFIG_PATH, LAST_KNOWN_GOOD_SUFFIX } from "../src/config/review-loader.js";
import { getPrisma, disconnectPrisma } from "../src/lib/prisma.js";
import { disconnectRedis } from "../src/lib/redis.js";

/**
 * Ticket 14 integration tests: server-rendered admin HTML panel.
 *
 * Sessions are created through the ticket-10 admin API OAuth flow (GitHub
 * mocked via the setGithubFetch seam); the panel handler shares the same
 * in-process session store and the same config primitives.
 */

process.env.DATABASE_URL ??= "postgres://postgres:postgres@localhost:5432/reviewer";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.MODEL_BASE_URL ??= "http://localhost:8000";
// The checked-in configuration references ${MODEL_NAME}; pin it for the
// admin panel's configuration round-trip assertions.
process.env.MODEL_NAME ??= "glm-4.7-flash";

const prisma = getPrisma();

const ADMIN_ENV: Env = loadEnv({
  NODE_ENV: "test",
  DATABASE_URL: process.env.DATABASE_URL,
  REDIS_URL: process.env.REDIS_URL,
  ADMIN_OAUTH_CLIENT_ID: "test-client-id",
  ADMIN_OAUTH_CLIENT_SECRET: "test-client-secret-do-not-render",
  ADMIN_OAUTH_CALLBACK_URL: "http://localhost:3000/api/admin/auth/github/callback",
  SESSION_SECRET: "test-session-secret-do-not-render",
  ADMIN_GITHUB_ORG: "octo-org",
  ADMIN_GITHUB_LOGINS: "",
  ADMIN_ORG_ADMIN_ROLES: "admin",
  SESSION_TTL_SECONDS: "28800",
  ADMIN_RATE_LIMIT_PER_MINUTE: "600",
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
  options: { headers?: Record<string, string>; body?: string } = {},
): IncomingMessage {
  const chunks = options.body === undefined ? [] : [Buffer.from(options.body)];
  const req = {
    method,
    url,
    headers: { host: "localhost:3000", ...(options.headers ?? {}) },
    socket: { remoteAddress: "203.0.113.9" },
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
      if (result.statusCode === 0) {
        result.statusCode = res.statusCode;
      }
    },
  } as unknown as ServerResponse;
  Object.defineProperty(res, "statusCode", {
    get: () => result.statusCode,
    set: (value: number) => {
      result.statusCode = value;
    },
  });
  const originalEnd = res.end.bind(res) as (body?: string) => void;
  res.end = ((body?: string) => {
    for (const [name, value] of store) {
      result.headers[name] = value as string;
    }
    return originalEnd(body);
  }) as typeof res.end;
  return { res, result };
}

// GitHub OAuth mock (same shape as the admin API tests) --------------------------

interface GithubUserMock {
  login: string;
  membership: { role: "admin" | "member"; state: "active" | "pending" } | null;
}

let githubUsers: GithubUserMock | undefined;

const githubMock: GithubFetch = (async (input: unknown) => {
  const url = String(input);
  const jsonResponse = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (url === "https://github.com/login/oauth/access_token") {
    return jsonResponse(200, { access_token: "gho_test_token" });
  }
  if (url === "https://api.github.com/user") {
    if (!githubUsers) {
      return jsonResponse(401, {});
    }
    return jsonResponse(200, { login: githubUsers.login, id: 7001 });
  }
  if (url.startsWith("https://api.github.com/orgs/octo-org/memberships/")) {
    if (!githubUsers || !githubUsers.membership) {
      return new Response("", { status: 404 });
    }
    return jsonResponse(200, githubUsers.membership);
  }
  return new Response("not found", { status: 404 });
}) as unknown as GithubFetch;

// Handlers ------------------------------------------------------------------------

function makeConfigDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "admin-panel-test-"));
  const source = fs.readFileSync(DEFAULT_CONFIG_PATH, "utf8");
  fs.writeFileSync(path.join(dir, "review.json"), source);
  return dir;
}

interface Handlers {
  panel: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  api: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  logs: string[];
}

function makeHandlers(env: Env, configPath: string): Handlers {
  const logs: string[] = [];
  const logger = {
    info: (obj: unknown, msg: string) => logs.push(`${msg}:${JSON.stringify(obj ?? "")}`),
    warn: (_obj: unknown, msg: string) => logs.push(`warn:${msg}`),
    error: (_obj: unknown, msg: string) => logs.push(`error:${msg}`),
  };
  const deps = { env, prisma, logger, configPath };
  return { panel: createAdminPanel(deps), api: createAdminApi(deps), logs };
}

async function call(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>,
  method: string,
  url: string,
  options: { headers?: Record<string, string>; body?: string } = {},
): Promise<MockResponse> {
  const { res, result } = mockResponse();
  await handler(mockRequest(method, url, options), res);
  return result;
}

function formBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

/** Login through the admin API OAuth flow and return the panel-ready session. */
async function login(
  handlers: Handlers,
  user: GithubUserMock = { login: "octoadmin", membership: { role: "admin", state: "active" } },
): Promise<{ cookie: string; csrfToken: string }> {
  githubUsers = user;
  const start = await call(handlers.api, "GET", "/api/admin/auth/github/login");
  expect(start.statusCode).toBe(302);
  const state = new URL(start.headers.location as string).searchParams.get("state")!;
  const done = await call(handlers.api, "GET", `/api/admin/auth/github/callback?code=good-code&state=${state}`);
  expect(done.statusCode).toBe(200);
  const body = JSON.parse(done.body) as { csrfToken: string };
  return { cookie: (done.headers["set-cookie"] as string).split(";")[0]!, csrfToken: body.csrfToken };
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// Suite ------------------------------------------------------------------------------

let configDir: string;
let handlers: Handlers;
const configPath = () => path.join(configDir, "review.json");
const lkgPath = () => `${configPath()}${LAST_KNOWN_GOOD_SUFFIX}`;

beforeEach(async () => {
  await prisma.auditLog.deleteMany();
  configDir = makeConfigDir();
  handlers = makeHandlers(ADMIN_ENV, configPath());
  githubUsers = undefined;
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

describe("admin panel (ticket 14)", () => {
  test("unauthenticated GET redirects to the admin OAuth login", async () => {
    const result = await call(handlers.panel, "GET", "/admin");
    expect(result.statusCode).toBe(303);
    expect(result.headers.location).toBe("/api/admin/auth/github/login");
    // And non-admin paths still fall through to the rest of the server.
    const unhandled = await call(handlers.panel, "GET", "/healthz");
    expect(unhandled.statusCode).toBe(0);
  });

  test("authenticated /logs redirects to the Dozzle UI; unauthenticated goes to login", async () => {
    const anonymous = await call(handlers.panel, "GET", "/logs");
    expect(anonymous.statusCode).toBe(303);
    expect(anonymous.headers.location).toBe("/api/admin/auth/github/login");

    const session = await login(handlers);
    const result = await call(handlers.panel, "GET", "/logs", { headers: { cookie: session.cookie } });
    expect(result.statusCode).toBe(302);
    expect(result.headers.location).toBe("/dozzle/");
  });

  test("authenticated non-admin gets a 403 page", async () => {
    // A session issued under an allowlist policy but whose login is not on the
    // (currently empty) allowlist is no longer an administrator.
    const session = createSession({ login: "octomember", id: 7002 }, "allowlist", { env: ADMIN_ENV });
    const cookie = `admin_session=${sessionCookieValue(session, ADMIN_ENV.SESSION_SECRET!)}`;
    const result = await call(handlers.panel, "GET", "/admin", { headers: { cookie } });
    expect(result.statusCode).toBe(403);
    expect(result.body).toMatch(/not an administrator/i);
  });

  test("overview + every section render with fields, CSRF input and config version", async () => {
    const session = await login(handlers);

    const overview = await call(handlers.panel, "GET", "/admin", { headers: { cookie: session.cookie } });
    expect(overview.statusCode).toBe(200);
    expect(overview.body).toMatch(/Configuration version: schema <strong>v1<\/strong>/);
    expect(overview.body).toMatch(/sha256:/);
    expect(overview.body).toContain('href="/logs"');
    for (const section of PANEL_SECTIONS) {
      expect(overview.body).toContain(SECTION_LABELS[section]);
    }

    for (const section of PANEL_SECTIONS) {
      const page = await call(handlers.panel, "GET", `/admin/${section}`, { headers: { cookie: session.cookie } });
      expect(page.statusCode).toBe(200);
      for (const field of PANEL_FIELDS[section]) {
        expect(page.body).toContain(field.label);
      }
      expect(page.body).toContain('name="_csrf"');
      expect(page.body).toContain(`action="/admin/${section}"`);
    }

    const audit = await call(handlers.panel, "GET", "/admin/audit?page=1", { headers: { cookie: session.cookie } });
    expect(audit.statusCode).toBe(200);
    expect(audit.body).toMatch(/Audit History/);
    expect(audit.body).toMatch(/admin\.login/); // the login above was audited
    expect(audit.body).toMatch(/Page 1 of 1/);
  });

  test("missing or wrong CSRF token on POST is rejected with 403", async () => {
    const session = await login(handlers);
    const before = fs.readFileSync(configPath(), "utf8");

    const missing = await call(handlers.panel, "POST", "/admin/general", {
      headers: { cookie: session.cookie },
      body: formBody({ "f:application.timezone": "UTC" }),
    });
    expect(missing.statusCode).toBe(403);

    const wrong = await call(handlers.panel, "POST", "/admin/general", {
      headers: { cookie: session.cookie },
      body: formBody({ _csrf: "forged", "f:application.timezone": "UTC" }),
    });
    expect(wrong.statusCode).toBe(403);

    expect(fs.readFileSync(configPath(), "utf8")).toBe(before);
    expect(fs.existsSync(lkgPath())).toBe(false);
  });

  test("invalid save renders field-level errors and persists nothing", async () => {
    const session = await login(handlers);
    const before = fs.readFileSync(configPath(), "utf8");

    const result = await call(handlers.panel, "POST", "/admin/general", {
      headers: { cookie: session.cookie },
      body: formBody({
        _csrf: session.csrfToken,
        action: "save",
        "f:application.environment": "bogus-environment",
        "f:queue.concurrency": "not-a-number",
      }),
    });
    expect(result.statusCode).toBe(400);
    // The panel stays server-rendered HTML; only the JSON admin API uses the
    // error envelope.
    expect(result.headers["content-type"]).toContain("text/html");
    expect(result.body).not.toContain('"statusCode"');
    expect(result.body).toMatch(/Validation failed — nothing was saved/);
    // Field-level errors render beside their fields.
    expect(result.body).toMatch(/Invalid option/); // enum error for environment
    expect(result.body).toMatch(/must be a finite number/); // local coercion error
    expect(result.body).toMatch(/has-error/);

    // Atomic: neither review.json nor an LKG snapshot was written.
    expect(fs.readFileSync(configPath(), "utf8")).toBe(before);
    expect(fs.existsSync(lkgPath())).toBe(false);
    const rejected = await prisma.auditLog.findMany({ where: { action: "config.update_rejected" } });
    expect(rejected).toHaveLength(1);
  });

  test("valid save persists through updateReviewConfig, writes LKG and audits", async () => {
    const session = await login(handlers);

    const result = await call(handlers.panel, "POST", "/admin/general", {
      headers: { cookie: session.cookie },
      body: formBody({
        _csrf: session.csrfToken,
        action: "save",
        "f:application.timezone": "Europe/Berlin",
      }),
    });
    expect(result.statusCode).toBe(303);
    expect(result.headers.location).toBe("/admin/general?notice=saved");

    const saved = JSON.parse(fs.readFileSync(configPath(), "utf8")) as { application: { timezone: string } };
    expect(saved.application.timezone).toBe("Europe/Berlin");
    expect(fs.existsSync(lkgPath())).toBe(true);

    const updates = await prisma.auditLog.findMany({ where: { action: "config.update" } });
    expect(updates).toHaveLength(1);
    expect(updates[0]!.actor).toBe("octoadmin");
    expect(updates[0]!.metadata).toMatchObject({ source: "panel", section: "general" });

    // Unchanged fields outside the submitted section are preserved (the schema
    // normalizes the full document, so spot-check representative keys instead
    // of comparing the whole object).
    const savedDoc = JSON.parse(fs.readFileSync(configPath(), "utf8")) as Record<string, unknown>;
    expect(savedDoc.schemaVersion).toBe(1);
    expect((savedDoc.provider as Record<string, unknown>).model).toBe("glm-4.7-flash");
    expect((savedDoc.review as Record<string, unknown>).enabled).toBe(true);
    expect((savedDoc.execution as Record<string, unknown>).mode).toBe("static-analysis");
  });

  test("sensitive execution changes require the confirmation interstitial", async () => {
    const session = await login(handlers);
    const before = fs.readFileSync(configPath(), "utf8");

    // First POST → interstitial, nothing persisted.
    const interstitial = await call(handlers.panel, "POST", "/admin/execution", {
      headers: { cookie: session.cookie },
      body: formBody({
        _csrf: session.csrfToken,
        action: "save",
        "f:execution.mode": "sandbox",
        // The schema requires sandbox mode to come with sandbox.enabled.
        "f:execution.sandbox.enabled": "true",
      }),
    });
    expect(interstitial.statusCode).toBe(200);
    expect(interstitial.body).toMatch(/Confirm sensitive changes/);
    expect(interstitial.body).toMatch(/execution\.mode/);
    expect(interstitial.body).toMatch(/read-only/);
    expect(interstitial.body).toMatch(/sandbox/);
    expect(fs.readFileSync(configPath(), "utf8")).toBe(before);
    expect(await prisma.auditLog.findMany({ where: { action: "config.update" } })).toHaveLength(0);

    // Extract the round-tripped candidate and confirm.
    const match = /name="candidate" value="([^"]*)"/.exec(interstitial.body)!;
    const candidate = decodeHtmlEntities(match[1]!);
    expect(() => JSON.parse(candidate)).not.toThrow();
    expect((JSON.parse(candidate) as { execution: { mode: string } }).execution.mode).toBe("sandbox");

    const confirmed = await call(handlers.panel, "POST", "/admin/execution", {
      headers: { cookie: session.cookie },
      body: formBody({
        _csrf: session.csrfToken,
        action: "save",
        confirm: "confirmed",
        candidate,
      }),
    });
    expect(confirmed.statusCode).toBe(303);
    expect(confirmed.headers.location).toBe("/admin/execution?notice=saved");
    const saved = JSON.parse(fs.readFileSync(configPath(), "utf8")) as { execution: { mode: string } };
    expect(saved.execution.mode).toBe("sandbox");
    expect(await prisma.auditLog.findMany({ where: { action: "config.update" } })).toHaveLength(1);
  });

  test("validate action reports success without persisting", async () => {
    const session = await login(handlers);
    const before = fs.readFileSync(configPath(), "utf8");

    const ok = await call(handlers.panel, "POST", "/admin/general", {
      headers: { cookie: session.cookie },
      body: formBody({
        _csrf: session.csrfToken,
        action: "validate",
        "f:application.timezone": "Europe/Berlin",
      }),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toMatch(/Validation passed — nothing was saved/);
    expect(fs.readFileSync(configPath(), "utf8")).toBe(before);
    expect(await prisma.auditLog.count()).toBe(1); // only the login event
  });

  test("rollback restores the last-known-good snapshot; without one it redirects with an error", async () => {
    const session = await login(handlers);

    // No snapshot yet → error redirect, nothing changes.
    const none = await call(handlers.panel, "POST", "/admin/config/rollback", {
      headers: { cookie: session.cookie },
      body: formBody({ _csrf: session.csrfToken }),
    });
    expect(none.statusCode).toBe(303);
    expect(none.headers.location).toBe("/admin?error=no-snapshot");

    // Save once to seed the LKG, then corrupt the live file.
    const save = await call(handlers.panel, "POST", "/admin/general", {
      headers: { cookie: session.cookie },
      body: formBody({ _csrf: session.csrfToken, action: "save", "f:application.timezone": "Asia/Tokyo" }),
    });
    expect(save.statusCode).toBe(303);

    fs.writeFileSync(configPath(), "{ broken json");
    const rolled = await call(handlers.panel, "POST", "/admin/config/rollback", {
      headers: { cookie: session.cookie },
      body: formBody({ _csrf: session.csrfToken }),
    });
    expect(rolled.statusCode).toBe(303);
    expect(rolled.headers.location).toBe("/admin?notice=rolledback");

    const restored = JSON.parse(fs.readFileSync(configPath(), "utf8")) as { application: { timezone: string } };
    expect(restored.application.timezone).toBe("Asia/Tokyo");

    const audits = await prisma.auditLog.findMany({
      where: { action: { in: ["config.rollback", "config.rollback_failed"] } },
      orderBy: { createdAt: "asc" },
    });
    expect(audits.map((row) => row.action)).toEqual(["config.rollback_failed", "config.rollback"]);
  });

  test("reload pulls the configuration from disk (LKG fallback reported)", async () => {
    const session = await login(handlers);

    const result = await call(handlers.panel, "POST", "/admin/config/reload", {
      headers: { cookie: session.cookie },
      body: formBody({ _csrf: session.csrfToken }),
    });
    expect(result.statusCode).toBe(303);
    expect(result.headers.location).toBe("/admin?notice=reloaded");
    const audits = await prisma.auditLog.findMany({ where: { action: "config.reload" } });
    expect(audits).toHaveLength(1);
  });

  test("no secret value is ever rendered — API key appears as its env name only", async () => {
    const session = await login(handlers);

    const result = await call(handlers.panel, "GET", "/admin/ai-model", { headers: { cookie: session.cookie } });
    expect(result.statusCode).toBe(200);
    // provider.apiKeyEnv is read-only and redacted, never a key value.
    const apiKeyField = result.body.match(/API key environment variable[\s\S]*?<input[^>]*readonly/);
    expect(apiKeyField).toBeTruthy();
    expect(result.body).not.toContain("test-client-secret-do-not-render");
    expect(result.body).not.toContain("test-session-secret-do-not-render");
    expect(result.body).not.toContain("gho_test_token");
    expect(result.body).toContain("[REDACTED]");
    expect(result.body).toMatch(/value="\[REDACTED\]"/);
  });

  // Dev-only login (local verification convenience) ---------------------------------

  test("dev login is inert outside NODE_ENV=development even when ADMIN_DEV_LOGIN=1", async () => {
    process.env.ADMIN_DEV_LOGIN = "1";
    try {
      const result = await call(handlers.panel, "GET", "/admin/dev-login");
      // Falls through to the normal unauthenticated flow → OAuth redirect.
      expect(result.statusCode).toBe(303);
      expect(result.headers.location).toBe("/api/admin/auth/github/login");
      expect(result.headers["set-cookie"]).toBeUndefined();
    } finally {
      delete process.env.ADMIN_DEV_LOGIN;
    }
  });

  test("dev login in development mints a real admin session and grants panel access", async () => {
    const devEnv: Env = loadEnv({
      NODE_ENV: "development",
      DATABASE_URL: process.env.DATABASE_URL!,
      REDIS_URL: process.env.REDIS_URL!,
      SESSION_SECRET: "dev-session-secret-for-local-verification",
      ADMIN_RATE_LIMIT_PER_MINUTE: "600",
    });
    const devHandlers = makeHandlers(devEnv, configPath());
    process.env.ADMIN_DEV_LOGIN = "1";
    try {
      const loginResult = await call(devHandlers.panel, "GET", "/admin/dev-login?login=localadmin");
      expect(loginResult.statusCode).toBe(303);
      expect(loginResult.headers.location).toBe("/admin");
      const cookie = (loginResult.headers["set-cookie"] as string).split(";")[0]!;
      expect(cookie).toMatch(/^admin_session=.+\..+/);

      const overview = await call(devHandlers.panel, "GET", "/admin", { headers: { cookie } });
      expect(overview.statusCode).toBe(200);
      expect(overview.body).toContain("Signed in as");
      expect(overview.body).toContain("localadmin");
    } finally {
      delete process.env.ADMIN_DEV_LOGIN;
      clearSessions();
    }
  });
});
