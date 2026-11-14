import { describe, expect, it } from "vitest";
import {
  buildSdkInlineConfig,
  buildSdkPermissions,
  evaluateSdkPermission,
  validateSdkPermissions,
} from "../src/agent/sdk/config.js";
import type { AgentRuntimeConfigSource } from "../src/agent/opencode-config.js";

// ---------------------------------------------------------------------------
// Test configuration fixture (mirrors the parsed review config shape)
// ---------------------------------------------------------------------------

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

describe("SDK permission rules", () => {
  it("is deny-by-default with only mapped read-only actions allowed", () => {
    const rules = buildSdkPermissions(baseConfig);
    expect(evaluateSdkPermission(rules, "read", "src/app.ts")).toBe("allow");
    expect(evaluateSdkPermission(rules, "grep", "src/app.ts")).toBe("allow");
    expect(evaluateSdkPermission(rules, "glob", "src/**")).toBe("allow");
    expect(evaluateSdkPermission(rules, "edit", "src/app.ts")).toBe("deny");
    expect(evaluateSdkPermission(rules, "write", "pwned.txt")).toBe("deny");
    expect(evaluateSdkPermission(rules, "shell", "rm src/app.ts")).toBe("deny");
    expect(evaluateSdkPermission(rules, "external_directory", "/tmp/outside")).toBe("deny");
  });

  it("denies secret paths even though reads are allowed", () => {
    const rules = buildSdkPermissions(baseConfig);
    for (const path of [".env", "config/prod.env", "prod.env.local", "credentials/token.txt", ".git-credentials"]) {
      expect(evaluateSdkPermission(rules, "read", path)).toBe("deny");
    }
  });

  it("denies everything when permissionPolicy is none", () => {
    const rules = buildSdkPermissions({
      ...baseConfig,
      agent: {
        ...baseConfig.agent,
        tools: { ...baseConfig.agent.tools, permissionPolicy: "none" },
      },
    });
    expect(evaluateSdkPermission(rules, "read", "src/app.ts")).toBe("deny");
  });

  it("validates the generated ruleset structurally and behaviorally", () => {
    expect(validateSdkPermissions(buildSdkPermissions(baseConfig))).toEqual({
      ok: true,
      problems: [],
      evaluated: expect.any(Array),
    });
  });
});

describe("SDK inline config", () => {
  it("emits the verified provider shape with env-referenced credentials", () => {
    const config = buildSdkInlineConfig(baseConfig, { MODEL_NAME: "workers-ai/@cf/zai-org/glm-4.7-flash" }, {
      maxOutputTokens: 8192,
    });
    expect(config.model).toBe("reviewer/glm");
    expect(config.share).toBe("disabled");
    expect(config.snapshots).toBe(false);
    expect(config.permissions).toEqual(expect.any(Array));
    const provider = (config.providers as Record<string, any>).reviewer;
    expect(provider.package).toBe("@opencode/ai/providers/openai-compatible");
    expect(provider.settings.apiKey).toBe("{env:MODEL_API_KEY}");
    expect(JSON.stringify(config)).not.toContain("secret-key-value");
  });

  it("falls back to provider.model when MODEL_NAME is absent", () => {
    const config = buildSdkInlineConfig(baseConfig, {}, { maxOutputTokens: 8192 });
    const provider = (config.providers as Record<string, any>).reviewer;
    expect(provider.models.glm.modelID).toBe(baseConfig.provider.model);
  });

  it("includes the same tracing plugin entry as the CLI config when enabled", () => {
    const traced = {
      ...baseConfig,
      observability: { agentTracing: { enabled: true } },
    };
    const config = buildSdkInlineConfig(traced, {}, {
      maxOutputTokens: 8192,
      reviewId: "rev_123",
      repository: "acme/app",
      pullRequestNumber: 42,
    });
    expect(config.plugins).toEqual([
      {
        package: "@devtheops/opencode-plugin-otel@2.1.0",
        options: {
          enabled: true,
          tags: ["review:rev_123", "repository:acme/app", "pr:42"],
          spanAttributes: "review.id=rev_123,repository=acme/app,pr.number=42",
        },
      },
    ]);
  });
});
