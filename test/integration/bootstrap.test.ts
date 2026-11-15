import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createServerRuntime, isAdminDevLoginEnabled } from "../../src/bootstrap/server.js";
import { createWorkerRuntime } from "../../src/bootstrap/worker.js";
import type { Env } from "../../src/platform/config/env.js";
import { testEnv } from "../helpers/env.js";

/**
 * Bootstrap smoke tests.
 *
 * Both composition roots build the full object graph without starting work:
 * the server does not listen, the worker does not consume jobs. Teardown
 * closes every client so the suite leaves nothing running.
 *
 * The thin `src/server.ts` / `src/worker.ts` entry points immediately call
 * `bootstrapServer()` / `bootstrapWorker()`, which listen / start consuming
 * jobs and exit the process on failure. Invoking those wrappers in-process is
 * therefore not safe; these runtime factories are exactly the graphs the
 * wrappers build, minus those side effects, so this is the closest safe
 * smoke test.
 */

const saved = {
  appId: process.env.APP_ID,
  privateKey: process.env.PRIVATE_KEY,
  privateKeyPath: process.env.PRIVATE_KEY_PATH,
};

beforeAll(() => {
  // Force the HTTP-only path: the smoke test never needs a real Probot app.
  delete process.env.APP_ID;
  delete process.env.PRIVATE_KEY;
  delete process.env.PRIVATE_KEY_PATH;
});

afterAll(() => {
  if (saved.appId !== undefined) {
    process.env.APP_ID = saved.appId;
  }
  if (saved.privateKey !== undefined) {
    process.env.PRIVATE_KEY = saved.privateKey;
  }
  if (saved.privateKeyPath !== undefined) {
    process.env.PRIVATE_KEY_PATH = saved.privateKeyPath;
  }
});

describe("server composition root", () => {
  test("constructs the HTTP graph without starting the listener", async () => {
    const runtime = await createServerRuntime(testEnv);
    try {
      expect(runtime.server).toBeDefined();
      expect(runtime.server.listening).toBe(false);
    } finally {
      await runtime.close();
    }
  });
});

describe("admin dev-login gate", () => {
  const devEnv: Env = {
    ...testEnv,
    NODE_ENV: "development",
    SESSION_SECRET: "dev-only-session-secret",
  };

  test("enabled only in development with explicit opt-in and a session secret", () => {
    expect(isAdminDevLoginEnabled(devEnv, { ADMIN_DEV_LOGIN: "1" })).toBe(true);
    expect(isAdminDevLoginEnabled(devEnv, {})).toBe(false);
    expect(isAdminDevLoginEnabled(devEnv, { ADMIN_DEV_LOGIN: "" })).toBe(false);
    expect(isAdminDevLoginEnabled({ ...devEnv, NODE_ENV: "production" }, { ADMIN_DEV_LOGIN: "1" })).toBe(false);
    expect(isAdminDevLoginEnabled({ ...devEnv, SESSION_SECRET: undefined }, { ADMIN_DEV_LOGIN: "1" })).toBe(false);
  });
});

describe("worker composition root", () => {
  test("constructs the worker graph without consuming jobs", async () => {
    const runtime = await createWorkerRuntime(testEnv);
    try {
      expect(runtime.logger).toBeDefined();
    } finally {
      await runtime.close();
    }
  });
});
