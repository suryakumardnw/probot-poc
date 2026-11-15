import { describe, expect, it, vi } from "vitest";
import {
  createAgentRuntime,
  OpenCodeAgentRuntime,
  OpenCodeSdkAgentRuntime,
  registerAgentRuntimePlugin,
  type AgentRuntimeConfigSource,
} from "../src/platform/agents/index.js";
import { AgentRuntimeError } from "../src/shared/errors/index.js";

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

// ---------------------------------------------------------------------------
// Runtime plugin registry
// ---------------------------------------------------------------------------

describe("agent runtime plugin registry", () => {
  it("selects the CLI adapter by default", () => {
    expect(createAgentRuntime(baseConfig)).toBeInstanceOf(OpenCodeAgentRuntime);
  });

  it("selects the SDK adapter when configured", () => {
    const sdkConfig: AgentRuntimeConfigSource = {
      ...baseConfig,
      agent: {
        ...baseConfig.agent,
        runtime: { ...baseConfig.agent.runtime, type: "opencode-sdk" },
      },
    };
    expect(createAgentRuntime(sdkConfig)).toBeInstanceOf(OpenCodeSdkAgentRuntime);
  });

  it("fails closed for a type with no plugin", () => {
    const config: AgentRuntimeConfigSource = {
      ...baseConfig,
      agent: {
        ...baseConfig.agent,
        runtime: { ...baseConfig.agent.runtime, type: "opencode-server" },
      },
    };
    try {
      createAgentRuntime(config);
      throw new Error("expected createAgentRuntime to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentRuntimeError);
      expect((error as AgentRuntimeError).code).toBe("config");
    }
  });

  it("lets a plugin register a new runtime type", () => {
    const fakeRuntime = {
      startSession: vi.fn(),
      execute: vi.fn(),
      terminate: vi.fn(),
      healthCheck: vi.fn(),
    };
    const fake = {
      id: "test-plugin",
      runtimeTypes: ["test-runtime"],
      create: vi.fn(() => fakeRuntime),
    };
    registerAgentRuntimePlugin(fake);
    const runtime = createAgentRuntime({
      ...baseConfig,
      agent: {
        ...baseConfig.agent,
        runtime: { ...baseConfig.agent.runtime, type: "test-runtime" },
      },
    } as AgentRuntimeConfigSource);
    expect(runtime).toBe(fakeRuntime);
    expect(fake.create).toHaveBeenCalledWith("test-runtime", expect.any(Object), expect.any(Object));
  });

  it("rejects duplicate runtime-type registration", () => {
    expect(() =>
      registerAgentRuntimePlugin({
        id: "duplicate",
        runtimeTypes: ["opencode-cli"],
        create: vi.fn(),
      }),
    ).toThrow(/already registered/);
  });

  it("re-exports the factory and plugin API from the agent barrel", async () => {
    const barrel = await import("../src/platform/agents/index.js");
    expect(typeof barrel.createAgentRuntime).toBe("function");
    expect(typeof barrel.registerAgentRuntimePlugin).toBe("function");
    expect(barrel.listAgentRuntimePlugins()).toContainEqual({
      id: "opencode",
      runtimeTypes: ["opencode-cli", "opencode-sdk"],
    });
  });
});
