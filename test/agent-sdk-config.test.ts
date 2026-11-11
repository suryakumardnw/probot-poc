import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  buildSdkInlineConfig,
  buildSdkPermissions,
  evaluateSdkPermission,
  SDK_MODEL_KEY,
  SDK_PROVIDER_ID,
  SDK_PROVIDER_PACKAGE,
  validateSdkPermissions,
} from "../src/agent/sdk/config.js";
import type { AgentRuntimeConfigSource } from "../src/agent/opencode-config.js";
import { reviewConfigSchema } from "../src/config/review-schema.js";

const baseConfig: AgentRuntimeConfigSource = {
  provider: {
    type: "openai-compatible",
    baseURL: "https://llm.example.test/compat",
    apiKeyEnv: "MODEL_API_KEY",
    model: "workers-ai/@cf/zai-org/glm-4.7-flash",
    temperature: 0.1,
    maxOutputTokens: 8192,
    timeoutMs: 120_000,
  },
  agent: {
    runtime: { type: "opencode-cli", sessionStrategy: "per-review", timeoutMs: 900_000 },
    context: {
      adaptive: true,
      maxFiles: 100,
      maxRetrievalCalls: 40,
      maxInputTokens: 60_000,
      maxOutputTokens: 8192,
    },
    tools: {
      enabled: ["read_file", "list_files", "search_code"],
      permissionPolicy: "allowlist",
    },
  },
};

function minimalConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    provider: {
      baseURL: "https://api.example.com/v1",
      apiKeyEnv: "MODEL_API_KEY",
      model: "llama-3.3-70b-versatile",
    },
    github: { organization: "acme" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Config schema (agent.sdk feature flag)
// ---------------------------------------------------------------------------

describe("agent.sdk config schema", () => {
  it("defaults to disabled with shadowMode enabled", () => {
    const config = reviewConfigSchema.parse(minimalConfig());
    expect(config.agent.sdk).toEqual({ enabled: false, shadowMode: true });
  });

  it("accepts an explicit enable", () => {
    const config = reviewConfigSchema.parse(
      minimalConfig({ agent: { sdk: { enabled: true, shadowMode: false } } }),
    );
    expect(config.agent.sdk).toEqual({ enabled: true, shadowMode: false });
  });

  it("rejects invalid sdk types", () => {
    expect(
      reviewConfigSchema.safeParse(minimalConfig({ agent: { sdk: { enabled: "yes" } } })).success,
    ).toBe(false);
    expect(
      reviewConfigSchema.safeParse(minimalConfig({ agent: { sdk: { shadowMode: 1 } } })).success,
    ).toBe(false);
  });

  it("mirrors enabled/shadowMode in the JSON Schema", () => {
    const schema = JSON.parse(
      readFileSync(new URL("../config/schemas/review-config-v1.schema.json", import.meta.url), "utf8"),
    ) as {
      properties: {
        agent: {
          properties: {
            sdk?: {
              type: string;
              additionalProperties: boolean;
              properties: Record<string, { type: string }>;
            };
          };
        };
      };
    };
    const sdk = schema.properties.agent.properties.sdk;
    expect(sdk).toBeDefined();
    expect(sdk?.type).toBe("object");
    expect(sdk?.additionalProperties).toBe(false);
    expect(Object.keys(sdk?.properties ?? {}).sort()).toEqual(["enabled", "shadowMode"]);
    expect(sdk?.properties.enabled.type).toBe("boolean");
    expect(sdk?.properties.shadowMode.type).toBe("boolean");
  });
});

// ---------------------------------------------------------------------------
// Permission ruleset
// ---------------------------------------------------------------------------

describe("SDK permission rules", () => {
  it("is deny-by-default with only mapped read-only actions allowed", () => {
    const rules = buildSdkPermissions(baseConfig);
    expect(rules[0]).toEqual({ action: "*", resource: "*", effect: "deny" });
    expect(rules[1]).toEqual({ action: "*", resource: "*/*", effect: "deny" });
    expect(evaluateSdkPermission(rules, "read", "README.md")).toBe("allow");
    expect(evaluateSdkPermission(rules, "read", "src/app.ts")).toBe("allow");
    expect(evaluateSdkPermission(rules, "grep", "src/app.ts")).toBe("allow");
    expect(evaluateSdkPermission(rules, "glob", "src")).toBe("allow");
    expect(evaluateSdkPermission(rules, "edit", "src/app.ts")).toBe("deny");
    expect(evaluateSdkPermission(rules, "write", "pwned.txt")).toBe("deny");
    expect(evaluateSdkPermission(rules, "shell", "rm src/app.ts")).toBe("deny");
    expect(evaluateSdkPermission(rules, "external_directory", "/tmp/outside")).toBe("deny");
  });

  it("denies secret paths even though reads are allowed (last match wins)", () => {
    const rules = buildSdkPermissions(baseConfig);
    for (const path of [
      ".env",
      "prod.env.local",
      "config/prod.env",
      "src/.env.example",
      "credentials/token.txt",
      "src/credentials/notes.md",
      ".git-credentials",
    ]) {
      expect(evaluateSdkPermission(rules, "read", path), path).toBe("deny");
    }
    expect(evaluateSdkPermission(rules, "read", "src/credentials.test.ts")).toBe("deny");
    // A non-secret file in a similarly named directory is still readable.
    expect(evaluateSdkPermission(rules, "read", "src/config/app.ts")).toBe("allow");
  });

  it("denies everything when the permission policy is none", () => {
    const rules = buildSdkPermissions({
      ...baseConfig,
      agent: {
        ...baseConfig.agent,
        tools: { enabled: ["read_file", "search_code"], permissionPolicy: "none" },
      },
    });
    expect(evaluateSdkPermission(rules, "read", "README.md")).toBe("deny");
    expect(evaluateSdkPermission(rules, "grep", "src/app.ts")).toBe("deny");
    expect(evaluateSdkPermission(rules, "glob", "src")).toBe("deny");
    expect(validateSdkPermissions(rules, { requireReadAccess: false }).ok).toBe(true);
  });

  it("structural validator accepts the generated ruleset and reports malformed rules", () => {
    const validation = validateSdkPermissions(buildSdkPermissions(baseConfig));
    expect(validation.ok).toBe(true);
    expect(validation.problems).toEqual([]);
    expect(validation.evaluated.find((item) => item.resource === ".env")?.actual).toBe("deny");

    const broken = [
      { action: "*", resource: "*", effect: "deny" },
      { action: "read", resource: "*", effect: "sometimes" },
    ] as unknown as ReturnType<typeof buildSdkPermissions>;
    const result = validateSdkPermissions(broken);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toMatch(/invalid effect/);
    expect(result.problems.join(" ")).toMatch(/missing external_directory deny/);
  });
});

// ---------------------------------------------------------------------------
// Inline host configuration
// ---------------------------------------------------------------------------

describe("SDK inline config", () => {
  it("emits the verified provider shape with env-referenced credentials", () => {
    const env = { MODEL_NAME: "workers-ai/@cf/zai-org/glm-4.7-flash", MODEL_API_KEY: "sk-super-secret-value" };
    const config = buildSdkInlineConfig(baseConfig, env, { maxOutputTokens: 4_000 }) as {
      model: string;
      permissions: unknown[];
      providers: Record<
        string,
        {
          package: string;
          env: string[];
          settings: Record<string, unknown>;
          models: Record<string, Record<string, unknown>>;
        }
      >;
    };
    expect(config.model).toBe(`${SDK_PROVIDER_ID}/${SDK_MODEL_KEY}`);
    expect(config.permissions.length).toBeGreaterThan(0);
    const provider = config.providers[SDK_PROVIDER_ID];
    expect(provider.package).toBe(SDK_PROVIDER_PACKAGE);
    expect(provider.env).toEqual(["MODEL_API_KEY"]);
    expect(provider.settings).toMatchObject({
      baseURL: baseConfig.provider.baseURL,
      apiKey: "{env:MODEL_API_KEY}",
      timeout: baseConfig.provider.timeoutMs,
    });
    expect(provider.models[SDK_MODEL_KEY]).toMatchObject({
      modelID: "workers-ai/@cf/zai-org/glm-4.7-flash",
      limit: { context: baseConfig.agent.context.maxInputTokens, output: 4_000 },
    });
    // No raw secret value ever lands in the serialized config.
    expect(JSON.stringify(config)).not.toContain("sk-super-secret-value");
    expect(JSON.stringify(config)).toContain("{env:MODEL_API_KEY}");
  });

  it("falls back to provider.model when MODEL_NAME is absent", () => {
    const config = buildSdkInlineConfig(baseConfig, {}, { maxOutputTokens: 1_000 }) as {
      providers: Record<string, { models: Record<string, { modelID: string }> }>;
    };
    expect(config.providers[SDK_PROVIDER_ID].models[SDK_MODEL_KEY].modelID).toBe(
      baseConfig.provider.model,
    );
  });
});
