import { describe, expect, test } from "vitest";
import {
  CURRENT_SCHEMA_VERSION as shimSchemaVersion,
  reviewConfigSchema as shimReviewConfigSchema,
} from "../config/review-schema.js";
import { CURRENT_SCHEMA_VERSION, envSchema, reviewConfigSchema } from "./config.js";
import * as contracts from "./index.js";

/**
 * Contract tests for the environment and review configuration schemas.
 * Loader behavior (env references, secret scanning, last-known-good) stays in
 * `test/review-config.test.ts`; these tests pin the shapes and defaults.
 */

function minimalReviewConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    provider: {
      baseURL: "https://api.example.com/v1",
      apiKeyEnv: "MODEL_API_KEY",
      model: "test-model",
    },
    github: { organization: "acme" },
    ...overrides,
  };
}

describe("envSchema", () => {
  test("applies safe defaults when optional variables are absent", () => {
    const env = envSchema.parse({});

    expect(env).toMatchObject({
      NODE_ENV: "development",
      LOG_LEVEL: "info",
      PORT: 3000,
      HOST: "0.0.0.0",
      DATABASE_URL: "postgres://postgres:postgres@localhost:5432/reviewer",
      REDIS_URL: "redis://localhost:6379",
      ADMIN_GITHUB_LOGINS: "",
      ADMIN_ORG_ADMIN_ROLES: "admin",
      SESSION_TTL_SECONDS: 28_800,
      ADMIN_RATE_LIMIT_PER_MINUTE: 60,
    });
  });

  test("coerces PORT and keeps explicit dependency URLs", () => {
    const env = envSchema.parse({
      DATABASE_URL: "postgresql://user:secret@db.internal:5432/reviewer",
      REDIS_URL: "rediss://cache.internal:6379",
      PORT: "8080",
    });

    expect(env.PORT).toBe(8080);
    expect(env.DATABASE_URL).toContain("db.internal");
    expect(env.REDIS_URL.startsWith("rediss://")).toBe(true);
  });

  test("rejects a non-postgres DATABASE_URL without echoing its value", () => {
    const result = envSchema.safeParse({ DATABASE_URL: "mysql://user:supersecret@host/db" });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["DATABASE_URL"]);
      expect(JSON.stringify(result.error.issues)).not.toContain("supersecret");
    }
  });

  test("rejects a non-redis REDIS_URL", () => {
    expect(envSchema.safeParse({ REDIS_URL: "postgres://localhost:5432/db" }).success).toBe(false);
  });

  test("rejects a non-numeric or out-of-range PORT", () => {
    expect(envSchema.safeParse({ PORT: "abc" }).success).toBe(false);
    expect(envSchema.safeParse({ PORT: "0" }).success).toBe(false);
    expect(envSchema.safeParse({ PORT: "70000" }).success).toBe(false);
  });

  test("requires a session secret of at least 16 characters when supplied", () => {
    expect(envSchema.safeParse({ SESSION_SECRET: "short" }).success).toBe(false);
    expect(envSchema.safeParse({ SESSION_SECRET: "sixteen-characters" }).success).toBe(true);
  });
});

describe("reviewConfigSchema", () => {
  test("accepts a minimal configuration and applies defaults", () => {
    const config = reviewConfigSchema.parse(minimalReviewConfig());

    expect(config.schemaVersion).toBe(1);
    expect(config.application.name).toBe("ai-pr-reviewer");
    expect(config.review.confidence.minimumInline).toBe(0.85);
    expect(config.review.confidence.minimumVerified).toBe(0.8);
    expect(config.execution.sandbox.runAsNonRoot).toBe(true);
    expect(config.provider.failurePolicy).toBe("fail-immediately");
    expect(config.evaluation.minimumQualityThreshold).toBe(0.85);
  });

  test("requires the provider and github sections", () => {
    expect(reviewConfigSchema.safeParse({ schemaVersion: 1, github: { organization: "acme" } }).success).toBe(false);
    expect(
      reviewConfigSchema.safeParse({
        schemaVersion: 1,
        provider: { baseURL: "https://x", apiKeyEnv: "K", model: "m" },
      }).success,
    ).toBe(false);
  });

  test("rejects unknown top-level keys", () => {
    expect(reviewConfigSchema.safeParse(minimalReviewConfig({ surprise: true })).success).toBe(false);
  });

  test("rejects an unsupported schemaVersion with the supported list", () => {
    const result = reviewConfigSchema.safeParse(minimalReviewConfig({ schemaVersion: 2 }));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message).join(" ")).toContain("supported versions: 1");
    }
  });

  test("rejects inline confidence below verified confidence", () => {
    const result = reviewConfigSchema.safeParse(
      minimalReviewConfig({ review: { confidence: { minimumInline: 0.5, minimumVerified: 0.9 } } }),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["review", "confidence", "minimumInline"]);
    }
  });

  test("requires sandbox.enabled when execution.mode is sandbox", () => {
    const result = reviewConfigSchema.safeParse(minimalReviewConfig({ execution: { mode: "sandbox" } }));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["execution", "mode"]);
    }
  });

  test("rejects a secret-looking provider key name that is not an env var NAME", () => {
    const result = reviewConfigSchema.safeParse(
      minimalReviewConfig({
        provider: { baseURL: "https://x", apiKeyEnv: "sk-live-123", model: "m" },
      }),
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("environment variable NAME");
    }
  });
});

describe("compatibility re-exports", () => {
  test("review-schema keeps pointing at the same schema object", () => {
    expect(shimReviewConfigSchema).toBe(reviewConfigSchema);
    expect(shimSchemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(CURRENT_SCHEMA_VERSION).toBe(1);
  });

  test("the public barrel exposes the same contract objects", () => {
    expect(contracts.reviewConfigSchema).toBe(reviewConfigSchema);
    expect(contracts.envSchema).toBe(envSchema);
    expect(contracts.knowledgeManifestSchema).toBeDefined();
    expect(contracts.benchmarkSuiteSchema).toBeDefined();
  });
});
