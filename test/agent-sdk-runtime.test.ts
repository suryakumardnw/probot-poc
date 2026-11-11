import { describe, expect, it, vi } from "vitest";

import type { AgentRuntimeConfigSource } from "../src/agent/opencode-config.js";
import type {
  SdkHost,
  SdkHostOptions,
  SdkMessage,
  SdkModule,
  SdkSessionRow,
} from "../src/agent/sdk/types.js";
import {
  createSdkAgentRuntime,
  OpenCodeSdkAgentRuntime,
  type SdkRuntimeOptions,
} from "../src/agent/opencode-sdk-runtime.js";
import {
  createAgentRuntime,
  isSdkRuntimeEnabled,
  type AgentRuntimeFactoryConfig,
} from "../src/agent/factory.js";
import { OpenCodeAgentRuntime } from "../src/agent/opencode-runtime.js";
import type { AgentSession } from "../src/agent/types.js";

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

const DEFAULT_MESSAGES: SdkMessage[] = [
  { type: "user", content: [{ type: "text", text: "the prompt" }] },
  {
    type: "assistant",
    content: [
      { type: "text", text: "first" },
      {
        type: "text",
        text: "second",
        tokens: { usage: { input: 10, output: 5, reasoning: 2 } },
      },
    ],
  },
];

interface HarnessOptions {
  messages?: SdkMessage[];
  outcome?: string;
  neverIdle?: boolean;
  promptError?: Error;
  removeError?: Error;
  closeError?: Error;
  getError?: Error;
  moduleError?: Error;
  /** Prompt admission never resolves (exercises the total deadline). */
  hangPrompt?: boolean;
  /** sessions.get never resolves (exercises the total deadline during polling). */
  hangGet?: boolean;
  /** Host close never resolves (proves timeout rejects before awaiting close). */
  hangClose?: boolean;
}

function makeHarness(options: HarnessOptions = {}) {
  let clock = 1_000;
  const now = () => clock;
  const sleepImpl = vi.fn(async (ms: number) => {
    clock += ms;
  });
  const rmImpl = vi.fn(async () => undefined);

  const state = {
    hostOptions: [] as SdkHostOptions[],
    hosts: [] as SdkHost[],
    sessionsCreated: [] as Array<Record<string, unknown>>,
    prompts: [] as Array<{ sessionID: string; text: string }>,
    sessionsRemoved: [] as Array<{ sessionID: string }>,
    getCalls: 0,
    closes: 0,
  };

  const sdkModule: SdkModule = {
    OpenCode: {
      create: vi.fn(async (createOptions: SdkHostOptions) => {
        state.hostOptions.push(createOptions);
        const host: SdkHost = {
          sessions: {
            create: vi.fn(async (input) => {
              state.sessionsCreated.push(input as unknown as Record<string, unknown>);
              return { id: `sdksess_${state.sessionsCreated.length}`, time: { idle: 0 } };
            }),
            get: vi.fn(async (): Promise<SdkSessionRow> => {
              state.getCalls += 1;
              if (options.hangGet) return new Promise<SdkSessionRow>(() => {});
              if (options.getError) throw options.getError;
              return {
                id: "sdksess_1",
                time: { idle: options.neverIdle ? 0 : clock },
                outcome: options.outcome,
              };
            }),
            prompt: vi.fn(async (input) => {
              state.prompts.push(input);
              if (options.promptError) throw options.promptError;
              if (options.hangPrompt) return new Promise<void>(() => {});
              clock += 10;
              return undefined;
            }),
            remove: vi.fn(async (input) => {
              state.sessionsRemoved.push(input);
              if (options.removeError) throw options.removeError;
            }),
          },
          message: {
            list: vi.fn(async () => ({ data: options.messages ?? DEFAULT_MESSAGES })),
          },
          close: vi.fn(async () => {
            state.closes += 1;
            if (options.hangClose) return new Promise<void>(() => {});
            if (options.closeError) throw options.closeError;
          }),
        };
        state.hosts.push(host);
        return host;
      }),
    },
  };

  const loader = vi.fn(async () => {
    if (options.moduleError) throw options.moduleError;
    return sdkModule;
  });

  return { state, loader, now, sleepImpl, rmImpl, sdkModule };
}

type Harness = ReturnType<typeof makeHarness>;

function makeRuntime(
  harness: Harness,
  overrides: Partial<SdkRuntimeOptions> = {},
): OpenCodeSdkAgentRuntime {
  return new OpenCodeSdkAgentRuntime(baseConfig, {
    loadSdk: harness.loader,
    // Integrity guard disabled unless a test overrides it.
    gitStatusImpl: async () => undefined,
    rmImpl: harness.rmImpl as unknown as SdkRuntimeOptions["rmImpl"],
    sleepImpl: harness.sleepImpl,
    now: harness.now,
    pollIntervalMs: 250,
    ...overrides,
  });
}

async function started(rt: OpenCodeSdkAgentRuntime, reviewId = "rev_sdk"): Promise<AgentSession> {
  return await rt.startSession({ reviewId, workspacePath: "/tmp/review-workspace-fixture" });
}

function makeCaptureLogger() {
  const lines: Array<{ level: string; msg: string; obj: Record<string, unknown> }> = [];
  const push = (level: string) => (msg: string, obj?: unknown) => {
    lines.push({ level, msg, obj: (obj ?? {}) as Record<string, unknown> });
  };
  return {
    lines,
    logger: {
      debug: push("debug"),
      info: push("info"),
      warn: push("warn"),
      error: push("error"),
    },
  };
}

// ---------------------------------------------------------------------------
// Factory / feature flag
// ---------------------------------------------------------------------------

describe("agent runtime factory", () => {
  const withSdk = (enabled: boolean): AgentRuntimeFactoryConfig => ({
    ...baseConfig,
    agent: { ...baseConfig.agent, sdk: { enabled, shadowMode: true } },
  });

  it("keeps the CLI runtime as the default (flag absent or false)", () => {
    const absent = baseConfig as AgentRuntimeFactoryConfig;
    expect(isSdkRuntimeEnabled(absent)).toBe(false);
    expect(createAgentRuntime(absent)).toBeInstanceOf(OpenCodeAgentRuntime);
    expect(isSdkRuntimeEnabled(withSdk(false))).toBe(false);
    expect(createAgentRuntime(withSdk(false))).toBeInstanceOf(OpenCodeAgentRuntime);
  });

  it("selects the SDK runtime only when enabled is true", () => {
    expect(isSdkRuntimeEnabled(withSdk(true))).toBe(true);
    expect(createAgentRuntime(withSdk(true))).toBeInstanceOf(OpenCodeSdkAgentRuntime);
  });

  it("createSdkAgentRuntime builds the SDK adapter directly", () => {
    expect(createSdkAgentRuntime(baseConfig)).toBeInstanceOf(OpenCodeSdkAgentRuntime);
  });
});

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

describe("SDK session lifecycle", () => {
  it("startSession does not load or create the SDK host", async () => {
    const harness = makeHarness();
    const runtime = makeRuntime(harness);
    const session = await started(runtime, "rev_start");

    expect(harness.loader).not.toHaveBeenCalled();
    expect(harness.state.hostOptions).toHaveLength(0);
    expect(session.reviewId).toBe("rev_start");
    expect(session.workspacePath).toBe("/tmp/review-workspace-fixture");
    expect(session.timeoutMs).toBe(baseConfig.agent.runtime.timeoutMs);
    await runtime.terminate(session);
  });

  it("first execute creates one host and one SDK session, then reuses them", async () => {
    const harness = makeHarness();
    const runtime = makeRuntime(harness);
    const session = await started(runtime, "rev_first");

    const first = await runtime.execute(session, { instruction: "review this diff", output: "text" });
    expect(harness.loader).toHaveBeenCalledTimes(1);
    expect(harness.state.hostOptions).toHaveLength(1);
    expect(harness.state.sessionsCreated).toHaveLength(1);

    const hostOptions = harness.state.hostOptions[0];
    expect(hostOptions.config.project).toBe(false);
    expect(hostOptions.config.claude).toBe(false);
    expect(hostOptions.models).toEqual({ fetch: false });
    expect(hostOptions.fs).toEqual({ filewatcher: false });
    expect(hostOptions.log.level).toBe("error");
    expect(hostOptions.database.path).toContain("opencode-sdk-sessions");
    expect(hostOptions.database.path).toContain("opencode.db");
    const inline = JSON.parse(hostOptions.config.content) as {
      model: string;
      permissions: unknown[];
      providers: Record<string, { settings: Record<string, unknown> }>;
    };
    expect(inline.model).toBe("reviewer/glm");
    expect(inline.permissions.length).toBeGreaterThan(0);
    expect(inline.providers.reviewer.settings.apiKey).toBe("{env:MODEL_API_KEY}");

    expect(harness.state.sessionsCreated[0]).toMatchObject({
      location: { directory: "/tmp/review-workspace-fixture" },
      metadata: { reviewId: "rev_first" },
      model: { id: "glm", providerID: "reviewer" },
    });
    expect(harness.state.prompts).toEqual([
      { sessionID: "sdksess_1", text: "review this diff" },
    ]);

    expect(first.text).toBe("first\n\nsecond");
    expect(first.usage).toEqual({ inputTokens: 10, outputTokens: 5, reasoningTokens: 2 });
    expect(first.sessionId).toBe(session.id);
    expect(first.durationMs).toBeGreaterThanOrEqual(0);

    const second = await runtime.execute(session, { instruction: "again", output: "text" });
    expect(second.text).toBe("first\n\nsecond");
    // Host/session are per review, not per task.
    expect(harness.loader).toHaveBeenCalledTimes(1);
    expect(harness.state.hostOptions).toHaveLength(1);
    expect(harness.state.sessionsCreated).toHaveLength(1);

    await runtime.terminate(session);
  });

  it("terminate removes the session, closes the host, removes the dir, and is idempotent", async () => {
    const harness = makeHarness();
    const runtime = makeRuntime(harness);
    const session = await started(runtime);
    await runtime.execute(session, { instruction: "x", output: "text" });

    await runtime.terminate(session);
    expect(harness.state.sessionsRemoved).toEqual([{ sessionID: "sdksess_1" }]);
    expect(harness.state.closes).toBe(1);
    expect(harness.rmImpl).toHaveBeenCalledTimes(1);
    const cleanupPath = harness.rmImpl.mock.calls[0][0] as unknown as string;
    expect(cleanupPath).toContain("opencode-sdk-sessions");

    await runtime.terminate(session);
    expect(harness.state.sessionsRemoved).toHaveLength(1);
    expect(harness.state.closes).toBe(1);
    expect(harness.rmImpl).toHaveBeenCalledTimes(1);

    await expect(runtime.execute(session, { instruction: "x", output: "text" })).rejects.toMatchObject({
      code: "config",
    });
  });

  it("keeps independent hosts for concurrent reviews", async () => {
    const harness = makeHarness();
    const runtime = makeRuntime(harness);
    const a = await started(runtime, "rev_a");
    const b = await started(runtime, "rev_b");

    // Start both executions before awaiting either so host creation and
    // polling genuinely interleave (not a sequential smoke test).
    const [resultA, resultB] = await Promise.all([
      runtime.execute(a, { instruction: "a", output: "text" }),
      runtime.execute(b, { instruction: "b", output: "text" }),
    ]);
    expect(resultA.text).toBe("first\n\nsecond");
    expect(resultB.text).toBe("first\n\nsecond");
    expect(harness.state.hostOptions).toHaveLength(2);
    expect(harness.state.closes).toBe(0);

    await runtime.terminate(a);
    expect(harness.state.closes).toBe(1);
    expect(harness.state.sessionsRemoved).toHaveLength(1);

    // Terminating review A must not close review B's host.
    const again = await runtime.execute(b, { instruction: "b2", output: "text" });
    expect(again.text).toBe("first\n\nsecond");
    expect(harness.state.closes).toBe(1);

    await runtime.terminate(b);
    expect(harness.state.closes).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Execution success/failure normalization
// ---------------------------------------------------------------------------

describe("SDK execute", () => {
  it("parses and validates JSON output", async () => {
    const harness = makeHarness({
      messages: [
        {
          type: "assistant",
          content: [{ type: "text", text: 'Here you go:\n```json\n{"verdict":"ok"}\n```' }],
        },
      ],
    });
    const runtime = makeRuntime(harness);
    const session = await started(runtime);
    const result = await runtime.execute(session, {
      instruction: "review",
      output: "json",
      validate: (value) =>
        typeof value === "object" && value !== null && "verdict" in value
          ? { ok: true, value }
          : { ok: false, error: "missing verdict" },
    });
    expect(result.json).toEqual({ verdict: "ok" });
    expect(result.value).toEqual({ verdict: "ok" });
    await runtime.terminate(session);
  });

  it("missing JSON and validator failures both surface as invalid_output", async () => {
    const missing = makeHarness({
      messages: [{ type: "assistant", content: [{ type: "text", text: "no json here" }] }],
    });
    const runtimeMissing = makeRuntime(missing);
    const sessionMissing = await started(runtimeMissing);
    await expect(
      runtimeMissing.execute(sessionMissing, { instruction: "x", output: "json" }),
    ).rejects.toMatchObject({ code: "invalid_output" });
    await runtimeMissing.terminate(sessionMissing);

    const invalid = makeHarness({
      messages: [{ type: "assistant", content: [{ type: "text", text: '{"verdict":"bananas"}' }] }],
    });
    const runtimeInvalid = makeRuntime(invalid);
    const sessionInvalid = await started(runtimeInvalid);
    await expect(
      runtimeInvalid.execute(sessionInvalid, {
        instruction: "x",
        output: "json",
        validate: () => ({ ok: false, error: "verdict must be approve|request_changes" }),
      }),
    ).rejects.toMatchObject({
      code: "invalid_output",
      detail: expect.stringContaining("verdict must be approve|request_changes"),
    });
    await runtimeInvalid.terminate(sessionInvalid);
  });

  it("timeout closes the host and throws a timeout error", async () => {
    const harness = makeHarness({ neverIdle: true });
    const runtime = makeRuntime(harness);
    const session = await runtime.startSession({
      reviewId: "rev_timeout",
      workspacePath: "/tmp/review-workspace-fixture",
      timeoutMs: 500,
    });

    await expect(runtime.execute(session, { instruction: "slow", output: "text" })).rejects.toMatchObject({
      code: "timeout",
      message: expect.stringContaining("timed out"),
    });
    expect(harness.state.closes).toBe(1);
    await runtime.terminate(session);
  });

  it("hung prompt admission is bounded by the total deadline and closes the host", async () => {
    const harness = makeHarness({ hangPrompt: true });
    const runtime = makeRuntime(harness);
    const session = await runtime.startSession({
      reviewId: "rev_hung_prompt",
      workspacePath: "/tmp/review-workspace-fixture",
      timeoutMs: 50,
    });

    await expect(runtime.execute(session, { instruction: "x", output: "text" })).rejects.toMatchObject({
      code: "timeout",
    });
    // Host was created and must be closed even though prompt never returned.
    expect(harness.state.hosts).toHaveLength(1);
    expect(harness.state.closes).toBe(1);
    await runtime.terminate(session);
    expect(harness.state.closes).toBe(1);
  });

  it("hung sessions.get is bounded by the total deadline and closes the host", async () => {
    const harness = makeHarness({ hangGet: true });
    const runtime = makeRuntime(harness);
    const session = await runtime.startSession({
      reviewId: "rev_hung_get",
      workspacePath: "/tmp/review-workspace-fixture",
      timeoutMs: 50,
    });

    await expect(runtime.execute(session, { instruction: "x", output: "text" })).rejects.toMatchObject({
      code: "timeout",
    });
    expect(harness.state.getCalls).toBeGreaterThanOrEqual(1);
    expect(harness.state.closes).toBe(1);
    await runtime.terminate(session);
  });

  it("rejects with timeout even if host close hangs (deadline is not gated on cleanup)", async () => {
    const harness = makeHarness({ hangGet: true, hangClose: true });
    const runtime = makeRuntime(harness);
    const session = await runtime.startSession({
      reviewId: "rev_hung_close",
      workspacePath: "/tmp/review-workspace-fixture",
      timeoutMs: 50,
    });

    await expect(runtime.execute(session, { instruction: "x", output: "text" })).rejects.toMatchObject({
      code: "timeout",
    });
    expect(harness.state.closes).toBe(1);
    // terminate must not double-close the host that closeHost already detached.
    await runtime.terminate(session);
    expect(harness.state.closes).toBe(1);
  });

  it("outcome=failed maps to provider_unavailable", async () => {
    const harness = makeHarness({ outcome: "failed" });
    const runtime = makeRuntime(harness);
    const session = await started(runtime);
    await expect(runtime.execute(session, { instruction: "x", output: "text" })).rejects.toMatchObject({
      code: "provider_unavailable",
    });
    await runtime.terminate(session);
  });

  it("prompt admission failure maps to crash", async () => {
    const harness = makeHarness({ promptError: new Error("session not admitting prompts") });
    const runtime = makeRuntime(harness);
    const session = await started(runtime);
    await expect(runtime.execute(session, { instruction: "x", output: "text" })).rejects.toMatchObject({
      code: "crash",
    });
    await runtime.terminate(session);
  });

  it("module import failure maps to spawn (config on unsupported Node)", async () => {
    const harness = makeHarness({ moduleError: new Error("Cannot find module") });
    const runtime = makeRuntime(harness);
    const session = await started(runtime);
    await expect(runtime.execute(session, { instruction: "x", output: "text" })).rejects.toMatchObject({
      code: "spawn",
    });
    await runtime.terminate(session);

    // A SyntaxError is what Node <24 throws for `await using` in the SDK tree.
    const syntaxHarness = makeHarness({ moduleError: new SyntaxError("Unexpected reserved word") });
    const syntaxRuntime = makeRuntime(syntaxHarness);
    const syntaxSession = await started(syntaxRuntime);
    await expect(
      syntaxRuntime.execute(syntaxSession, { instruction: "x", output: "text" }),
    ).rejects.toMatchObject({ code: "config" });
    await syntaxRuntime.terminate(syntaxSession);
  });
});

// ---------------------------------------------------------------------------
// Egress fetch seam
// ---------------------------------------------------------------------------

describe("SDK egress fetch seam", () => {
  it("forwards the injected fetch implementation to OpenCode.create", async () => {
    const harness = makeHarness();
    const fetchImpl = vi.fn(async () => new Response("ok"));
    const runtime = makeRuntime(harness, { fetchImpl });
    const session = await started(runtime);
    await runtime.execute(session, { instruction: "x", output: "text" });
    expect(harness.state.hostOptions[0].fetch).toBe(fetchImpl);
    await runtime.terminate(session);
  });

  it("omits fetch when no implementation is supplied", async () => {
    const harness = makeHarness();
    const runtime = makeRuntime(harness);
    const session = await started(runtime);
    await runtime.execute(session, { instruction: "x", output: "text" });
    expect(harness.state.hostOptions[0].fetch).toBeUndefined();
    await runtime.terminate(session);
  });
});

// ---------------------------------------------------------------------------
// Workspace integrity
// ---------------------------------------------------------------------------

describe("SDK workspace integrity guard", () => {
  it("passes when the workspace snapshot is unchanged", async () => {
    const harness = makeHarness();
    const runtime = makeRuntime(harness, { gitStatusImpl: async () => " M src/a.ts\n" });
    const session = await started(runtime);
    const result = await runtime.execute(session, { instruction: "x", output: "text" });
    expect(result.text).toBe("first\n\nsecond");
    await runtime.terminate(session);
  });

  it("throws workspace_modified when the workspace changed during execution", async () => {
    const harness = makeHarness();
    let calls = 0;
    const runtime = makeRuntime(harness, {
      gitStatusImpl: async () => {
        calls += 1;
        return calls === 1 ? "" : "?? hacked.txt\n";
      },
    });
    const session = await started(runtime);
    await expect(runtime.execute(session, { instruction: "x", output: "text" })).rejects.toMatchObject({
      code: "workspace_modified",
      detail: expect.stringContaining("hacked.txt"),
    });
    await runtime.terminate(session);
  });

  it("skips the guard when git is unavailable", async () => {
    const harness = makeHarness();
    const runtime = makeRuntime(harness, { gitStatusImpl: async () => undefined });
    const session = await started(runtime);
    const result = await runtime.execute(session, { instruction: "x", output: "text" });
    expect(result.text).toBe("first\n\nsecond");
    await runtime.terminate(session);
  });
});

// ---------------------------------------------------------------------------
// Health & secret hygiene
// ---------------------------------------------------------------------------

describe("SDK healthCheck", () => {
  it("reports healthy from the injected module without creating a host", async () => {
    const harness = makeHarness();
    const runtime = makeRuntime(harness);
    const health = await runtime.healthCheck();
    expect(health.healthy).toBe(true);
    expect(health.detail).toContain("opencode-sdk");
    expect(health.checkedAt).toBeTruthy();
    expect(harness.state.hostOptions).toHaveLength(0);
  });

  it("reports unhealthy when the module import fails, without throwing", async () => {
    const harness = makeHarness({ moduleError: new SyntaxError("await using unsupported") });
    const runtime = makeRuntime(harness);
    const health = await runtime.healthCheck();
    expect(health.healthy).toBe(false);
    expect(health.detail).toContain("opencode-sdk unavailable");
    expect(harness.state.hostOptions).toHaveLength(0);
  });
});

describe("SDK secret hygiene", () => {
  it("scrubs the provider API key from thrown details and logger output", async () => {
    const secret = "sk-live-super-secret-123456";
    process.env.MODEL_API_KEY = secret;
    const harness = makeHarness({
      promptError: new Error(`admission rejected api key ${secret}`),
    });
    const { logger, lines } = makeCaptureLogger();
    const runtime = makeRuntime(harness, { logger });
    const session = await started(runtime);

    const error = await runtime
      .execute(session, { instruction: "secret prompt contents", output: "text" })
      .catch((cause: unknown) => cause as { code?: string; detail?: string });

    expect(error.code).toBe("crash");
    expect(error.detail).toBeDefined();
    expect(error.detail).not.toContain(secret);
    expect(error.detail).toContain("[redacted]");
    expect(JSON.stringify(lines)).not.toContain(secret);
    // Prompts are never logged.
    expect(JSON.stringify(lines)).not.toContain("secret prompt contents");

    await runtime.terminate(session);
    delete process.env.MODEL_API_KEY;
  });
});
