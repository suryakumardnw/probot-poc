import { describe, expect, it, vi } from "vitest";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildPrompt } from "../src/agent/opencode-runtime.js";
import type { AgentRuntimeConfigSource } from "../src/agent/opencode-config.js";
import type { SdkHostClient, SdkHostClientOptions } from "../src/agent/sdk/client.js";
import type {
  SdkCreateSessionInput,
  SdkMessage,
  SdkPromptInput,
  SdkSessionRef,
  SdkSessionRow,
} from "../src/agent/sdk/types.js";
import {
  createSdkAgentRuntime,
  OpenCodeSdkAgentRuntime,
  type SdkRuntimeOptions,
} from "../src/agent/opencode-sdk-runtime.js";
import { AgentRuntimeError, type AgentSession } from "../src/agent/types.js";

// ---------------------------------------------------------------------------
// Fixtures
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
    runtime: { type: "opencode-sdk", sessionStrategy: "per-review", timeoutMs: 900_000 },
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

const cliConfig: AgentRuntimeConfigSource = {
  ...baseConfig,
  agent: {
    ...baseConfig.agent,
    runtime: { ...baseConfig.agent.runtime, type: "opencode-cli" },
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

// ---------------------------------------------------------------------------
// Fake host client (records calls, returns queued rows/messages)
// ---------------------------------------------------------------------------

interface FakeClientOptions {
  messages?: SdkMessage[];
  outcome?: string;
  hangStart?: boolean;
  startError?: unknown;
  hangGet?: boolean;
  hangPrompt?: boolean;
  hangClose?: boolean;
  promptError?: Error;
  removeError?: Error;
  closeError?: Error;
}

class FakeHostClient implements SdkHostClient {
  startCalls = 0;
  killCalls = 0;
  closeCalls = 0;
  getCalls = 0;
  createSessionCalls: SdkCreateSessionInput[] = [];
  prompts: SdkPromptInput[] = [];
  removeSessionCalls: SdkSessionRef[] = [];

  constructor(
    private readonly options: FakeClientOptions,
    private readonly now: () => number,
    private readonly advance: (ms: number) => void,
  ) {}

  async start(): Promise<void> {
    this.startCalls += 1;
    if (this.options.hangStart) return new Promise<void>(() => {});
    if (this.options.startError) throw this.options.startError;
  }

  async createSession(input: SdkCreateSessionInput): Promise<SdkSessionRow> {
    this.createSessionCalls.push(input);
    return { id: `sdksess_${this.createSessionCalls.length}`, time: { idle: 0 } };
  }

  async getSession(input: SdkSessionRef): Promise<SdkSessionRow> {
    this.getCalls += 1;
    if (this.options.hangGet) return new Promise<SdkSessionRow>(() => {});
    return {
      id: input.sessionID,
      time: { idle: this.now() },
      ...(this.options.outcome ? { outcome: this.options.outcome } : {}),
    };
  }

  async prompt(input: SdkPromptInput): Promise<void> {
    this.prompts.push(input);
    if (this.options.hangPrompt) return new Promise<void>(() => {});
    if (this.options.promptError) throw this.options.promptError;
    this.advance(10);
  }

  async listMessages(
    _input: SdkSessionRef & { order?: "asc" | "desc" },
  ): Promise<SdkMessage[]> {
    return this.options.messages ?? DEFAULT_MESSAGES;
  }

  async removeSession(input: SdkSessionRef): Promise<void> {
    this.removeSessionCalls.push(input);
    if (this.options.removeError) throw this.options.removeError;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.options.hangClose) return new Promise<void>(() => {});
    if (this.options.closeError) throw this.options.closeError;
  }

  kill(): void {
    this.killCalls += 1;
  }
}

interface HarnessOptions extends FakeClientOptions {
  probeError?: Error;
  probeVersion?: string;
  perReviewMessages?: Record<string, SdkMessage[]>;
}

function makeHarness(options: HarnessOptions = {}) {
  let clock = 1_000;
  const now = () => clock;
  const advance = (ms: number) => {
    clock += ms;
  };
  const sleepImpl = vi.fn(async (ms: number) => {
    clock += ms;
  });
  const rmImpl = vi.fn(async () => undefined);

  const clients: FakeHostClient[] = [];
  const clientOptions: SdkHostClientOptions[] = [];
  const createHostClient = vi.fn((opts: SdkHostClientOptions) => {
    clientOptions.push(opts);
    const messages = options.perReviewMessages?.[opts.reviewId] ?? options.messages;
    const client = new FakeHostClient({ ...options, messages }, now, advance);
    clients.push(client);
    return client;
  });

  const probeSdkHost = vi.fn(async () => {
    if (options.probeError) throw options.probeError;
    return { version: options.probeVersion ?? "2.3.0" };
  });

  return {
    state: { clients, clientOptions, rmImpl },
    now,
    sleepImpl,
    createHostClient,
    probeSdkHost,
  };
}

type Harness = ReturnType<typeof makeHarness>;

function makeRuntime(
  harness: Harness,
  overrides: Partial<SdkRuntimeOptions> = {},
): OpenCodeSdkAgentRuntime {
  return new OpenCodeSdkAgentRuntime(baseConfig, {
    createHostClient: harness.createHostClient,
    probeSdkHost: harness.probeSdkHost,
    nodeMajorVersion: () => 24,
    gitStatusImpl: async () => undefined,
    rmImpl: harness.state.rmImpl,
    sleepImpl: harness.sleepImpl,
    now: harness.now,
    pollIntervalMs: 250,
    ...overrides,
  });
}

async function started(
  rt: OpenCodeSdkAgentRuntime,
  reviewId = "rev_sdk",
  overrides: Partial<Parameters<OpenCodeSdkAgentRuntime["startSession"]>[0]> = {},
): Promise<AgentSession> {
  return await rt.startSession({
    reviewId,
    workspacePath: "/tmp/review-workspace-fixture",
    ...overrides,
  });
}

function findSessionDir(reviewId: string): string {
  const root = path.join(os.tmpdir(), "opencode-sdk-sessions");
  if (!existsSync(root)) return "";
  const matches = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${reviewId}-`))
    .map((entry) => path.join(root, entry.name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return matches[0] ?? "";
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
// Constructor / factory
// ---------------------------------------------------------------------------

describe("SDK runtime adapter construction", () => {
  it("rejects a config whose runtime.type is opencode-cli", () => {
    expect(() => new OpenCodeSdkAgentRuntime(cliConfig)).toThrowError(
      expect.objectContaining({ code: "config" }),
    );
    expect(() => createSdkAgentRuntime(cliConfig)).toThrowError(
      expect.objectContaining({ code: "config" }),
    );
  });

  it("createSdkAgentRuntime builds the SDK adapter directly", () => {
    expect(createSdkAgentRuntime(baseConfig)).toBeInstanceOf(OpenCodeSdkAgentRuntime);
  });
});

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

describe("SDK session lifecycle", () => {
  it("startSession creates config/data/state dirs and does not create a host client", async () => {
    const harness = makeHarness();
    const runtime = makeRuntime(harness);
    const session = await started(runtime, "rev_start");
    const dir = findSessionDir("rev_start");
    try {
      expect(dir).toBeTruthy();
      expect(existsSync(path.join(dir, "config"))).toBe(true);
      expect(existsSync(path.join(dir, "data"))).toBe(true);
      expect(existsSync(path.join(dir, "state"))).toBe(true);
      expect(session.reviewId).toBe("rev_start");
      expect(session.workspacePath).toBe("/tmp/review-workspace-fixture");
      expect(session.timeoutMs).toBe(baseConfig.agent.runtime.timeoutMs);
      expect(harness.createHostClient).not.toHaveBeenCalled();
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("execute creates one client, starts it, creates one session, prompts, polls, returns text", async () => {
    const harness = makeHarness();
    const runtime = makeRuntime(harness);
    const session = await started(runtime, "rev_exec");

    const result = await runtime.execute(session, { instruction: "review this diff", output: "text" });

    expect(harness.createHostClient).toHaveBeenCalledTimes(1);
    const client = harness.state.clients[0];
    expect(client.startCalls).toBe(1);
    expect(client.createSessionCalls).toHaveLength(1);
    expect(client.prompts).toEqual([{ sessionID: "sdksess_1", text: "review this diff" }]);
    expect(client.getCalls).toBeGreaterThanOrEqual(1);
    expect(result.text).toBe("first\n\nsecond");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, reasoningTokens: 2 });
    expect(result.sessionId).toBe(session.id);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    // The child env is buildChildEnv plus XDG roots inside the session dir.
    const opts = harness.state.clientOptions[0];
    expect(opts.env.XDG_CONFIG_HOME).toContain("opencode-sdk-sessions");
    expect(opts.env.XDG_CONFIG_HOME).toContain("config");
    expect(opts.env.XDG_DATA_HOME).toContain("data");
    expect(opts.env.XDG_STATE_HOME).toContain("state");
    expect(opts.configContent).toContain("reviewer/glm");
    expect(opts.databasePath).toContain("opencode.db");
    expect(opts.workspacePath).toBe("/tmp/review-workspace-fixture");
    expect(opts.hostProcessPath).toContain("host-process.js");

    await runtime.terminate(session);
  });

  it("terminate removes the session, closes the client, kills it, removes the dir, and is idempotent", async () => {
    const harness = makeHarness();
    const runtime = makeRuntime(harness);
    const session = await started(runtime, "rev_term");
    await runtime.execute(session, { instruction: "x", output: "text" });

    await runtime.terminate(session);
    const client = harness.state.clients[0];
    expect(client.removeSessionCalls).toEqual([{ sessionID: "sdksess_1" }]);
    expect(client.closeCalls).toBe(1);
    expect(client.killCalls).toBe(1);
    expect(harness.state.rmImpl).toHaveBeenCalledTimes(1);
    const cleanupPath = harness.state.rmImpl.mock.calls[0][0] as unknown as string;
    expect(cleanupPath).toContain("opencode-sdk-sessions");

    await runtime.terminate(session);
    expect(client.removeSessionCalls).toHaveLength(1);
    expect(client.closeCalls).toBe(1);
    expect(client.killCalls).toBe(1);
    expect(harness.state.rmImpl).toHaveBeenCalledTimes(1);

    await expect(runtime.execute(session, { instruction: "x", output: "text" })).rejects.toMatchObject({
      code: "config",
    });
  });

  it("two concurrent sessions get two distinct clients and never share messages", async () => {
    const harness = makeHarness({
      perReviewMessages: {
        rev_a: [{ type: "assistant", content: [{ type: "text", text: "alpha" }] }],
        rev_b: [{ type: "assistant", content: [{ type: "text", text: "beta" }] }],
      },
    });
    const runtime = makeRuntime(harness);
    const a = await started(runtime, "rev_a");
    const b = await started(runtime, "rev_b");

    const [resultA, resultB] = await Promise.all([
      runtime.execute(a, { instruction: "a", output: "text" }),
      runtime.execute(b, { instruction: "b", output: "text" }),
    ]);

    expect(resultA.text).toBe("alpha");
    expect(resultB.text).toBe("beta");
    expect(harness.state.clients).toHaveLength(2);
    expect(harness.state.clients[0]).not.toBe(harness.state.clients[1]);
    expect(harness.state.clients[0].prompts.map((p) => p.text)).toEqual(["a"]);
    expect(harness.state.clients[1].prompts.map((p) => p.text)).toEqual(["b"]);

    await runtime.terminate(a);
    await runtime.terminate(b);
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

  it("prompt for a json task includes the shared single-JSON-object contract", async () => {
    const harness = makeHarness({
      messages: [{ type: "assistant", content: [{ type: "text", text: '{"verdict":"ok"}' }] }],
    });
    const runtime = makeRuntime(harness);
    const session = await started(runtime);
    await runtime.execute(session, { instruction: "review", output: "json" });

    const prompt = harness.state.clients[0].prompts[0].text;
    expect(prompt).toBe(buildPrompt({ instruction: "review", output: "json" }));
    expect(prompt).toContain("exactly one JSON object");
    await runtime.terminate(session);
  });

  it("does not concatenate multi-step output blindly (newest message wins)", async () => {
    const harness = makeHarness({
      messages: [
        { type: "assistant", content: [{ type: "text", text: '{"verdict":' }] },
        { type: "assistant", content: [{ type: "text", text: '{"verdict":"approve"}' }] },
      ],
    });
    const runtime = makeRuntime(harness);
    const session = await started(runtime);
    const result = await runtime.execute(session, {
      instruction: "review",
      output: "json",
      validate: (value) =>
        typeof value === "object" &&
        value !== null &&
        "verdict" in value &&
        (value as { verdict: unknown }).verdict === "approve"
          ? { ok: true, value }
          : { ok: false, error: "verdict must be approve" },
    });
    expect(result.json).toEqual({ verdict: "approve" });
    await runtime.terminate(session);
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

  it("a hung host start is bounded by the total deadline, kills the client, throws timeout", async () => {
    const harness = makeHarness({ hangStart: true });
    const runtime = makeRuntime(harness);
    const session = await started(runtime, "rev_hung_start", { timeoutMs: 50 });

    await expect(runtime.execute(session, { instruction: "x", output: "text" })).rejects.toMatchObject({
      code: "timeout",
    });
    // The client was registered before start() was awaited, so the deadline
    // timer can kill the child that is stuck in the create handshake.
    expect(harness.state.clients).toHaveLength(1);
    expect(harness.state.clients[0].killCalls).toBeGreaterThanOrEqual(1);
    await runtime.terminate(session);
  });

  it("a hung prompt is bounded by the total deadline, kills the client, throws timeout", async () => {
    const harness = makeHarness({ hangPrompt: true });
    const runtime = makeRuntime(harness);
    const session = await started(runtime, "rev_hung_prompt", { timeoutMs: 50 });

    await expect(runtime.execute(session, { instruction: "x", output: "text" })).rejects.toMatchObject({
      code: "timeout",
    });
    expect(harness.state.clients).toHaveLength(1);
    expect(harness.state.clients[0].killCalls).toBeGreaterThanOrEqual(1);
    await runtime.terminate(session);
  });

  it("a hung getSession is bounded by the total deadline, kills the client, throws timeout", async () => {
    const harness = makeHarness({ hangGet: true });
    const runtime = makeRuntime(harness);
    const session = await started(runtime, "rev_hung_get", { timeoutMs: 50 });

    await expect(runtime.execute(session, { instruction: "x", output: "text" })).rejects.toMatchObject({
      code: "timeout",
    });
    expect(harness.state.clients[0].getCalls).toBeGreaterThanOrEqual(1);
    expect(harness.state.clients[0].killCalls).toBeGreaterThanOrEqual(1);
    await runtime.terminate(session);
  });

  it("a hung close during timeout does not delay the timeout rejection", async () => {
    const harness = makeHarness({ hangGet: true, hangClose: true });
    const runtime = makeRuntime(harness);
    const session = await started(runtime, "rev_hung_close", { timeoutMs: 50 });

    await expect(runtime.execute(session, { instruction: "x", output: "text" })).rejects.toMatchObject({
      code: "timeout",
    });
    expect(harness.state.clients[0].closeCalls).toBe(1);
    // terminate must not double-close the client the timeout path detached.
    await runtime.terminate(session);
    expect(harness.state.clients[0].closeCalls).toBe(1);
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
// Health
// ---------------------------------------------------------------------------

describe("SDK healthCheck", () => {
  it("reports unhealthy on Node < 24 without creating a host client", async () => {
    const harness = makeHarness();
    const runtime = makeRuntime(harness, { nodeMajorVersion: () => 22 });
    const health = await runtime.healthCheck();
    expect(health.healthy).toBe(false);
    expect(health.detail).toContain("Node >= 24");
    expect(harness.createHostClient).not.toHaveBeenCalled();
    expect(harness.probeSdkHost).not.toHaveBeenCalled();
  });

  it("uses probeSdkHost and reports healthy with the version", async () => {
    const harness = makeHarness();
    const runtime = makeRuntime(harness);
    const health = await runtime.healthCheck();
    expect(health.healthy).toBe(true);
    expect(health.detail).toContain("opencode-sdk");
    expect(health.detail).toContain("2.3.0");
    expect(health.checkedAt).toBeTruthy();
    expect(harness.probeSdkHost).toHaveBeenCalledTimes(1);
    expect(harness.createHostClient).not.toHaveBeenCalled();
  });

  it("reports unhealthy when the probe throws", async () => {
    const harness = makeHarness({ probeError: new Error("spawn failed") });
    const runtime = makeRuntime(harness);
    const health = await runtime.healthCheck();
    expect(health.healthy).toBe(false);
    expect(health.detail).toContain("opencode-sdk unavailable");
    expect(harness.createHostClient).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Secret hygiene
// ---------------------------------------------------------------------------

describe("SDK secret hygiene", () => {
  it("scrubs the provider key and tracing secrets from thrown details and logger output", async () => {
    const secret = "sk-live-super-secret-123456";
    const langfuse = "pk-lf-super-secret";
    const otlpValue = "secret-otlp-token-value";
    process.env.MODEL_API_KEY = secret;
    process.env.LANGFUSE_SECRET_KEY = langfuse;
    process.env.OPENCODE_OTLP_HEADERS = `Authorization=Bearer ${otlpValue}`;

    try {
      const harness = makeHarness({
        promptError: new Error(
          `auth failed key=${secret} langfuse=${langfuse} otlp=${otlpValue} Authorization: Bearer ${otlpValue}`,
        ),
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
      expect(error.detail).not.toContain(langfuse);
      expect(error.detail).not.toContain(otlpValue);
      expect(error.detail).toContain("[redacted]");
      expect(JSON.stringify(lines)).not.toContain(secret);
      expect(JSON.stringify(lines)).not.toContain(langfuse);
      expect(JSON.stringify(lines)).not.toContain(otlpValue);
      expect(JSON.stringify(lines)).not.toContain("secret prompt contents");

      await runtime.terminate(session);
    } finally {
      delete process.env.MODEL_API_KEY;
      delete process.env.LANGFUSE_SECRET_KEY;
      delete process.env.OPENCODE_OTLP_HEADERS;
    }
  });

  it("scrubs the detail of a client error rethrown during host start", async () => {
    const secret = "sk-live-start-handshake-secret";
    process.env.MODEL_API_KEY = secret;
    try {
      const harness = makeHarness({
        startError: new AgentRuntimeError("crash", "host failed", {
          detail: `invalid protocol line contains ${secret}`,
        }),
      });
      const { logger, lines } = makeCaptureLogger();
      const runtime = makeRuntime(harness, { logger });
      const session = await started(runtime);

      const error = await runtime
        .execute(session, { instruction: "x", output: "text" })
        .catch((cause: unknown) => cause as { code?: string; detail?: string });

      expect(error.code).toBe("crash");
      expect(error.detail).toBeDefined();
      expect(error.detail).not.toContain(secret);
      expect(error.detail).toContain("[redacted]");
      expect(JSON.stringify(lines)).not.toContain(secret);

      await runtime.terminate(session);
    } finally {
      delete process.env.MODEL_API_KEY;
    }
  });
});
