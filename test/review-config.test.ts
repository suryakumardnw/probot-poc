import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG_PATH,
  EmbeddedSecretError,
  LAST_KNOWN_GOOD_SUFFIX,
  MANDATORY_SECURITY_POLICIES,
  MissingEnvVarError,
  applyMandatorySecurityPolicies,
  checkForEmbeddedSecrets,
  createConfigurationSnapshot,
  loadReviewConfig,
  ConfigValidationError,
  redactConfiguration,
  resolveRepositoryOverrides,
  updateReviewConfig,
  validateRawConfig,
} from "../src/config/review-loader.js";
import { CURRENT_SCHEMA_VERSION, reviewConfigSchema } from "../src/config/review-schema.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const ENV = {
  MODEL_BASE_URL: "https://api.example.com/v1",
  MODEL_API_KEY: "MODEL_API_KEY",
};

interface Fixture {
  dir: string;
  path: string;
  cleanup: () => void;
}

function makeFixture(initial: unknown, name = "review.json"): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "review-config-"));
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(initial, null, 2), "utf8");
  return {
    dir,
    path,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function validConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    provider: {
      baseURL: "${MODEL_BASE_URL}",
      apiKeyEnv: "MODEL_API_KEY",
      model: "llama-3.3-70b-versatile",
    },
    github: { organization: "acme" },
    ...overrides,
  };
}

const fixtures: Fixture[] = [];

beforeEach(() => {
  fixtures.length = 0;
});

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.cleanup();
  }
});

function track(initial: unknown, name?: string): Fixture {
  const fixture = makeFixture(initial, name);
  fixtures.push(fixture);
  return fixture;
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

describe("reviewConfigSchema (strict validation)", () => {
  it("accepts the checked-in config/review.json", () => {
    const raw: unknown = JSON.parse(readFileSync(DEFAULT_CONFIG_PATH, "utf8"));

    expect(() => validateRawConfig(raw)).not.toThrow();
  });

  it("accepts a minimal valid configuration and applies defaults", () => {
    const config = validateRawConfig({
      schemaVersion: 1,
      provider: {
        baseURL: "https://api.example.com/v1",
        apiKeyEnv: "MODEL_API_KEY",
        model: "llama-3.3-70b-versatile",
      },
      github: { organization: "acme" },
    });
    expect(config.schemaVersion).toBe(1);
    expect(config.application.name).toBe("ai-pr-reviewer");
    expect(config.review.confidence.minimumInline).toBe(0.85);
    expect(config.review.confidence.minimumVerified).toBe(0.8);
    expect(config.execution.sandbox.runAsNonRoot).toBe(true);
    expect(config.provider.failurePolicy).toBe("fail-immediately");
  });

  it("defaults agent tracing to disabled with the pinned OpenTelemetry plugin", () => {
    const config = validateRawConfig(validConfig());
    expect(config.observability.agentTracing.enabled).toBe(false);
    expect(config.observability.agentTracing.plugin).toBe("@devtheops/opencode-plugin-otel@2.1.0");
    expect(config.observability.agentTracing.options).toEqual({});
  });

  it("accepts plugin-shaped agent tracing with scalar and list options", () => {
    const config = validateRawConfig(
      validConfig({
        observability: {
          agentTracing: {
            enabled: true,
            plugin: "@devtheops/opencode-plugin-otel@2.1.0",
            options: {
              endpoint: "http://phoenix:6006",
              protocol: "http/protobuf",
              logsEnabled: false,
              disabledMetrics: ["token.usage", "cost.usage"],
            },
          },
        },
      }),
    );
    expect(config.observability.agentTracing).toMatchObject({
      enabled: true,
      plugin: "@devtheops/opencode-plugin-otel@2.1.0",
      options: {
        endpoint: "http://phoenix:6006",
        protocol: "http/protobuf",
        logsEnabled: false,
        disabledMetrics: ["token.usage", "cost.usage"],
      },
    });
  });

  it("rejects the removed langfuse block", () => {
    expect(() => validateRawConfig(validConfig({ observability: { langfuse: { enabled: true } } }))).toThrow(
      /Invalid review configuration/,
    );
  });

  it("rejects a missing required provider block", () => {
    expect(() => validateRawConfig({ schemaVersion: 1, github: { organization: "acme" } })).toThrow(
      /Invalid review configuration/,
    );
  });

  it("rejects a missing github.organization", () => {
    expect(() =>
      validateRawConfig({
        schemaVersion: 1,
        provider: { baseURL: "https://x", apiKeyEnv: "A_KEY", model: "m" },
        github: {},
      }),
    ).toThrow(/organization/);
  });

  it("rejects an invalid enum value", () => {
    expect(() => validateRawConfig(validConfig({ execution: { mode: "full-root" } }))).toThrow(
      /Invalid review configuration/,
    );
  });

  it("rejects invalid numeric limits (out-of-range confidence)", () => {
    expect(() =>
      validateRawConfig(validConfig({ review: { confidence: { minimumInline: 1.5, minimumVerified: 0.8 } } })),
    ).toThrow(/Invalid review configuration/);
  });

  it("rejects minimumInline < minimumVerified", () => {
    expect(() =>
      validateRawConfig(validConfig({ review: { confidence: { minimumInline: 0.5, minimumVerified: 0.9 } } })),
    ).toThrow(/minimumInline must be >= review\.confidence\.minimumVerified/);
  });

  it("rejects sandbox mode without an enabled sandbox", () => {
    expect(() => validateRawConfig(validConfig({ execution: { mode: "sandbox" } }))).toThrow(/sandbox/);
  });

  it("rejects an unsupported schemaVersion", () => {
    expect(() => validateRawConfig(validConfig({ schemaVersion: 2 }))).toThrow(/unsupported schemaVersion/);
  });

  it("rejects unknown top-level keys (strict mode)", () => {
    expect(() => validateRawConfig(validConfig({ notASection: true }))).toThrow(/Invalid review configuration/);
  });

  it("strips the editor-only $schema key before validation", () => {
    const config = validateRawConfig({
      $schema: "./schemas/review-config-v1.schema.json",
      ...validConfig(),
    });
    expect(config.provider.model).toBe("llama-3.3-70b-versatile");
  });

  it("exposes the current schema version as 1", () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(1);
    expect(reviewConfigSchema.safeParse(validConfig()).success).toBe(true);
  });
});

describe("agent runtime selection", () => {
  it("defaults to the OpenCode CLI runtime", () => {
    const parsed = reviewConfigSchema.parse(validConfig());
    expect(parsed.agent.runtime.type).toBe("opencode-cli");
  });

  it("accepts the OpenCode SDK runtime", () => {
    const parsed = reviewConfigSchema.parse(validConfig({ agent: { runtime: { type: "opencode-sdk" } } }));
    expect(parsed.agent.runtime.type).toBe("opencode-sdk");
  });

  it("rejects an unknown runtime type", () => {
    expect(() => reviewConfigSchema.parse(validConfig({ agent: { runtime: { type: "opencode-http" } } }))).toThrow();
  });

  it("mirrors the runtime enum in the JSON Schema", () => {
    const schema = JSON.parse(
      readFileSync(join(__dirname, "../config/schemas/review-config-v1.schema.json"), "utf8"),
    ) as {
      properties: {
        agent: {
          properties: {
            runtime: { properties: { type: { enum: string[] } } };
          };
        };
      };
    };
    expect(schema.properties.agent.properties.runtime.properties.type.enum).toEqual([
      "opencode-cli",
      "opencode-sdk",
      "opencode-server",
      "custom",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Secret hygiene
// ---------------------------------------------------------------------------

describe("secret hygiene", () => {
  it("rejects embedded secret values", () => {
    expect(() => checkForEmbeddedSecrets({ apiKey: "sk-live-123" })).toThrow(EmbeddedSecretError);
    expect(() => checkForEmbeddedSecrets({ webhook_secret: "whsec" })).toThrow(EmbeddedSecretError);
    expect(() => checkForEmbeddedSecrets({ provider: { token: 12345 } })).toThrow(EmbeddedSecretError);
  });

  it("allows the apiKeyEnv indirection (env var NAME, not a secret)", () => {
    expect(() => checkForEmbeddedSecrets({ apiKeyEnv: "MODEL_API_KEY" })).not.toThrow();
  });

  it("redacts secret-adjacent fields for display", () => {
    const redacted = redactConfiguration({
      apiKeyEnv: "MODEL_API_KEY",
      nested: { accessToken: "x", safe: "y" },
    });
    expect(redacted).toEqual({ apiKeyEnv: "[REDACTED]", nested: { accessToken: "[REDACTED]", safe: "y" } });
  });
});

// ---------------------------------------------------------------------------
// Environment variable resolution
// ---------------------------------------------------------------------------

describe("env var resolution", () => {
  it("resolves ${VAR} references", () => {
    const loaded = loadReviewConfig(track(validConfig()).path, { env: ENV });
    expect(loaded.config.provider.baseURL).toBe("https://api.example.com/v1");
  });

  it("throws a clear error when a required variable is missing", () => {
    expect(() => loadReviewConfig(track(validConfig()).path, { env: {} })).toThrow(MissingEnvVarError);
    try {
      loadReviewConfig(track(validConfig()).path, { env: {} });
    } catch (error) {
      expect((error as MissingEnvVarError).variable).toBe("MODEL_BASE_URL");
      expect((error as Error).message).toMatch(/provider\.baseURL/);
    }
  });

  it("honours ${VAR:-default} fallbacks", () => {
    const loaded = loadReviewConfig(
      track(validConfig({ review: { conventions: { customInstructions: "${MISSING_VAR:-fallback}" } } })).path,
      { env: ENV },
    );
    expect(loaded.config.review.conventions.customInstructions).toBe("fallback");
  });
});

// ---------------------------------------------------------------------------
// Mandatory security policies
// ---------------------------------------------------------------------------

describe("mandatory security policies", () => {
  it("are locked and cannot be weakened", () => {
    const config = applyMandatorySecurityPolicies(
      validateRawConfig(
        validConfig({
          provider: { baseURL: "https://x", apiKeyEnv: "K", model: "m", failurePolicy: "retry-once" },
          execution: { sandbox: { enabled: true, runAsNonRoot: false } },
        }),
      ),
    );
    expect(config.provider.failurePolicy).toBe("fail-immediately");
    expect(config.execution.sandbox.runAsNonRoot).toBe(true);
  });

  it("raise confidence floors", () => {
    const config = applyMandatorySecurityPolicies(
      validateRawConfig(validConfig({ review: { confidence: { minimumInline: 0.5, minimumVerified: 0.5 } } })),
    );
    expect(config.review.confidence.minimumInline).toBe(
      MANDATORY_SECURITY_POLICIES.floors["review.confidence.minimumInline"],
    );
    expect(config.review.confidence.minimumVerified).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// Repository overrides
// ---------------------------------------------------------------------------

describe("repository overrides", () => {
  it("allow listed sections and re-apply security policies", () => {
    const base = validateRawConfig(validConfig());
    const patched = resolveRepositoryOverrides(base, { "review.severity": ["critical", "high"] }, { env: ENV });
    expect(patched.review.severity).toEqual(["critical", "high"]);
    expect(patched.provider.failurePolicy).toBe("fail-immediately");
  });

  it("reject overrides outside the allowlist", () => {
    const base = validateRawConfig(validConfig());
    expect(() => resolveRepositoryOverrides(base, { "provider.model": "other" }, { env: ENV })).toThrow(
      /not permitted/,
    );
  });

  it("reject overrides when repositoryOverrides are disabled", () => {
    const base = validateRawConfig(validConfig({ configuration: { repositoryOverrides: { enabled: false } } }));
    expect(() => resolveRepositoryOverrides(base, { "review.severity": ["critical"] }, { env: ENV })).toThrow(
      /disabled/,
    );
  });

  it("cannot allowlist a mandatory security path", () => {
    const base = validateRawConfig(
      validConfig({ configuration: { repositoryOverrides: { allowedSections: ["provider"] } } }),
    );
    expect(() => resolveRepositoryOverrides(base, { "provider.model": "other" }, { env: ENV })).toThrow(
      /mandatory security policy/,
    );
  });
});

// ---------------------------------------------------------------------------
// Loading and last-known-good protection
// ---------------------------------------------------------------------------

describe("loadReviewConfig", () => {
  it("loads and validates a good file", () => {
    const loaded = loadReviewConfig(track(validConfig()).path, { env: ENV });
    expect(loaded.fromLastKnownGood).toBe(false);
    expect(loaded.config.github.organization).toBe("acme");
    expect(loaded.snapshot.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("falls back to the last-known-good on an invalid file", () => {
    const fixture = track(validConfig());
    const good = loadReviewConfig(fixture.path, { env: ENV, updateLastKnownGood: true });
    expect(good.fromLastKnownGood).toBe(false);

    writeFileSync(fixture.path, "{ this is not json", "utf8");
    const fallback = loadReviewConfig(fixture.path, { env: ENV });
    expect(fallback.fromLastKnownGood).toBe(true);
    expect(fallback.config.provider.model).toBe("llama-3.3-70b-versatile");
    expect(existsSync(fixture.path + LAST_KNOWN_GOOD_SUFFIX)).toBe(true);
  });

  it("throws when the file is invalid and no last-known-good exists", () => {
    const fixture = track("{ broken");
    expect(() => loadReviewConfig(fixture.path, { env: ENV })).toThrow(ConfigValidationError);
  });

  it("produces an immutable snapshot with a stable hash", () => {
    const snapshot = createConfigurationSnapshot(
      validateRawConfig({ ...validConfig(), ...{ provider: { baseURL: "https://x", apiKeyEnv: "K", model: "m" } } }),
    );
    expect(Object.isFrozen(snapshot.config)).toBe(true);
    const again = createConfigurationSnapshot(
      validateRawConfig({ ...validConfig(), ...{ provider: { baseURL: "https://x", apiKeyEnv: "K", model: "m" } } }),
    );
    expect(again.hash).toBe(snapshot.hash);
  });
});

// ---------------------------------------------------------------------------
// Atomic updates
// ---------------------------------------------------------------------------

describe("updateReviewConfig", () => {
  it("atomically replaces the active configuration with a valid candidate", () => {
    const fixture = track(validConfig());
    loadReviewConfig(fixture.path, { env: ENV, updateLastKnownGood: true });

    const next = validConfig({
      provider: { baseURL: "${MODEL_BASE_URL}", apiKeyEnv: "MODEL_API_KEY", model: "updated-model" },
    });
    const result = updateReviewConfig(fixture.path, next, { env: ENV });
    expect(result.next.config.provider.model).toBe("updated-model");
    expect(JSON.parse(readFileSync(fixture.path, "utf8"))).toMatchObject({
      provider: { model: "updated-model" },
    });
  });

  it("never touches the active file or LKG when the candidate is invalid", () => {
    const fixture = track(validConfig());
    loadReviewConfig(fixture.path, { env: ENV, updateLastKnownGood: true });
    const before = readFileSync(fixture.path, "utf8");
    const lkgBefore = readFileSync(fixture.path + LAST_KNOWN_GOOD_SUFFIX, "utf8");

    const invalid = validConfig({ schemaVersion: 2 });
    expect(() => updateReviewConfig(fixture.path, invalid, { env: ENV })).toThrow(/unsupported schemaVersion/);

    expect(readFileSync(fixture.path, "utf8")).toBe(before);
    expect(readFileSync(fixture.path + LAST_KNOWN_GOOD_SUFFIX, "utf8")).toBe(lkgBefore);
  });

  it("refuses to update while the current file is broken", () => {
    const fixture = track(validConfig());
    loadReviewConfig(fixture.path, { env: ENV, updateLastKnownGood: true });
    writeFileSync(fixture.path, "{ broken", "utf8");

    expect(() => updateReviewConfig(fixture.path, validConfig(), { env: ENV })).toThrow(
      /Invalid review configuration|not valid JSON/,
    );
  });
});
