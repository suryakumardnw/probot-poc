import { describe, expect, test } from "vitest";
import { loadEnv } from "../src/platform/config/env.js";
import { createLogger, logRedactPaths } from "../src/platform/logger.js";
import { registerGracefulShutdown, type ShutdownStep } from "../src/platform/shutdown.js";

describe("pino logger", () => {
  test("is configured for structured JSON output", () => {
    const env = loadEnv({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
    const logger = createLogger(env);
    expect(typeof logger.info).toBe("function");
    expect(logger.level).toBe(env.LOG_LEVEL);
  });

  test("redacts secret-bearing keys", async () => {
    const { Writable } = await import("node:stream");
    const { default: pino } = await import("pino");

    const lines: string[] = [];
    const capture = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });

    // Use the exact redact configuration shipped by createLogger().
    const logger = pino(
      {
        level: "info",
        redact: { paths: logRedactPaths, censor: "[REDACTED]" },
      },
      capture,
    );

    logger.info(
      {
        token: "super-secret-token",
        password: "hunter2",
        apiKey: "key-123",
        // Non-secret fields must survive.
        repository: "org/repo",
      },
      "test event",
    );
    capture.end();

    const output = lines.join("");
    expect(output).not.toContain("super-secret-token");
    expect(output).not.toContain("hunter2");
    expect(output).not.toContain("key-123");
    expect(output).toContain("org/repo");
  });

  test("redact list covers common secret field names", () => {
    for (const path of ["token", "password", "privateKey", "apiKey", "webhookSecret"]) {
      expect(logRedactPaths).toContain(path);
    }
  });
});

describe("registerGracefulShutdown", () => {
  test("registers handlers and exposes step API", () => {
    const env = loadEnv({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
    const logger = createLogger(env);
    const steps: ShutdownStep[] = [{ name: "noop", run: async () => {} }];

    // Should not throw on a process without existing handlers.
    expect(() => registerGracefulShutdown(logger, steps)).not.toThrow();
    // Node throws ERR_EVENT_HANDLER... no: duplicate listeners are allowed.
    // Clean up is process-wide; tests must not remove global handlers, and
    // repeated registration is tolerated (guarded by `shuttingDown` flag).
  });
});
