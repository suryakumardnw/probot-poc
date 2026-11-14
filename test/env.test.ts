import { describe, expect, test } from "vitest";
import { EnvValidationError, loadEnv } from "../src/config/env.js";

describe("loadEnv", () => {
  test("applies safe defaults when optional variables are absent", () => {
    const env = loadEnv({
      NODE_ENV: "test",
    } as NodeJS.ProcessEnv);

    expect(env.NODE_ENV).toBe("test");
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.PORT).toBe(3000);
    expect(env.HOST).toBe("0.0.0.0");
    expect(env.DATABASE_URL).toContain("postgres://");
    expect(env.REDIS_URL).toContain("redis://");
  });

  test("accepts explicit dependency URLs", () => {
    const env = loadEnv({
      DATABASE_URL: "postgres://user:secret@db.internal:5432/reviewer",
      REDIS_URL: "redis://cache.internal:6379",
      LOG_LEVEL: "debug",
      PORT: "8080",
    } as unknown as NodeJS.ProcessEnv);

    expect(env.LOG_LEVEL).toBe("debug");
    expect(env.PORT).toBe(8080);
  });

  test("rejects an invalid DATABASE_URL with a clear error naming the variable", () => {
    expect(() => loadEnv({ DATABASE_URL: "not-a-url" } as unknown as NodeJS.ProcessEnv)).toThrow(EnvValidationError);

    try {
      loadEnv({ DATABASE_URL: "mysql://localhost/db" } as unknown as NodeJS.ProcessEnv);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      expect((error as Error).message).toContain("DATABASE_URL");
      expect((error as Error).message).toContain("postgres://");
    }
  });

  test("rejects an invalid REDIS_URL with a clear error naming the variable", () => {
    try {
      loadEnv({ REDIS_URL: "postgres://localhost:5432/db" } as unknown as NodeJS.ProcessEnv);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      expect((error as Error).message).toContain("REDIS_URL");
    }
  });

  test("rejects a non-numeric PORT", () => {
    expect(() => loadEnv({ PORT: "abc" } as unknown as NodeJS.ProcessEnv)).toThrow(EnvValidationError);
  });
});
