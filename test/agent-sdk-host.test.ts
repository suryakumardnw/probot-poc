import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { runHostProcess } from "../src/platform/agents/sdk/host-process.js";
import { createSdkHostDispatcher, type SdkHostDispatcher } from "../src/platform/agents/sdk/host.js";
import type {
  SdkCreateSessionInput,
  SdkHost,
  SdkHostOptions,
  SdkMessage,
  SdkModule,
  SdkSessionRef,
} from "../src/platform/agents/sdk/types.js";
import { first } from "./helpers/assert.js";

// ---------------------------------------------------------------------------
// Fake SDK module (same shape as the reference adapter test's fake)
// ---------------------------------------------------------------------------

interface FakeState {
  hostOptions: SdkHostOptions[];
  hosts: SdkHost[];
  sessionsCreated: SdkCreateSessionInput[];
  prompts: Array<{ sessionID: string; text: string }>;
  gets: SdkSessionRef[];
  removes: SdkSessionRef[];
  closes: number;
  messages: SdkMessage[];
}

interface FakeOptions {
  getError?: Error;
}

function makeFakeModule(options: FakeOptions = {}) {
  const state: FakeState = {
    hostOptions: [],
    hosts: [],
    sessionsCreated: [],
    prompts: [],
    gets: [],
    removes: [],
    closes: 0,
    messages: [],
  };

  const sdkModule: SdkModule = {
    OpenCode: {
      create: vi.fn(async (createOptions: SdkHostOptions) => {
        state.hostOptions.push(createOptions);
        const host: SdkHost = {
          sessions: {
            create: vi.fn(async (input: SdkCreateSessionInput) => {
              state.sessionsCreated.push(input);
              return { id: "sdksess_1" };
            }),
            get: vi.fn(async (input: SdkSessionRef) => {
              state.gets.push(input);
              if (options.getError) {
                throw options.getError;
              }
              return { id: "sdksess_1", time: { idle: 1 } };
            }),
            prompt: vi.fn(async (input: { sessionID: string; text: string }) => {
              state.prompts.push(input);
            }),
            remove: vi.fn(async (input: SdkSessionRef) => {
              state.removes.push(input);
            }),
          },
          message: {
            list: vi.fn(async () => ({ data: state.messages })),
          },
          close: vi.fn(async () => {
            state.closes += 1;
          }),
        };
        state.hosts.push(host);
        return host;
      }),
    },
  };

  const loader = vi.fn(async () => sdkModule);
  return { state, loader, sdkModule };
}

type Harness = ReturnType<typeof makeFakeModule>;

async function createdHost(harness: Harness, onLog = vi.fn()): Promise<SdkHostDispatcher> {
  const dispatcher = createSdkHostDispatcher(harness.loader, onLog);
  const response = await dispatcher.handle({
    id: 1,
    method: "create",
    params: { configContent: "{}", databasePath: "/tmp/opencode.db" },
  });
  expect(response).toMatchObject({ id: 1, ok: true });
  return dispatcher;
}

function collectStream(): { stream: PassThrough; data: () => string } {
  const stream = new PassThrough();
  let out = "";
  stream.on("data", (chunk) => {
    out += chunk.toString();
  });
  return { stream, data: () => out };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

describe("SDK host dispatcher", () => {
  it("create calls OpenCode.create once with the mandated host options", async () => {
    const harness = makeFakeModule();
    const onLog = vi.fn();
    const dispatcher = createSdkHostDispatcher(harness.loader, onLog);

    const response = await dispatcher.handle({
      id: 1,
      method: "create",
      params: { configContent: '{"model":"reviewer/glm"}', databasePath: "/tmp/opencode.db" },
    });
    expect(response).toEqual({ id: 1, ok: true });

    expect(harness.loader).toHaveBeenCalledTimes(1);
    expect(harness.state.hostOptions).toHaveLength(1);
    const options = first(harness.state.hostOptions, "host options");
    expect(options.config).toEqual({
      content: '{"model":"reviewer/glm"}',
      project: false,
      claude: false,
    });
    expect(options.database).toEqual({ path: "/tmp/opencode.db" });
    expect(options.models).toEqual({ fetch: false });
    expect(options.fs).toEqual({ filewatcher: false });
    expect(options.log.level).toBe("error");
    expect(options.log.emit).toBe(onLog);
  });

  it("malformed method params return a protocol error instead of reaching the SDK", async () => {
    const harness = makeFakeModule();
    const dispatcher = createSdkHostDispatcher(harness.loader, vi.fn());

    const response = await dispatcher.handle({
      id: 1,
      method: "create",
      params: { configContent: "{}" },
    });

    expect(response).toMatchObject({
      id: 1,
      ok: false,
      error: { message: expect.stringContaining("invalid create params") },
    });
    expect(harness.loader).not.toHaveBeenCalled();
  });

  it("session.create forwards location.directory, metadata, title and model", async () => {
    const harness = makeFakeModule();
    const dispatcher = await createdHost(harness);
    const input: SdkCreateSessionInput = {
      location: { directory: "/tmp/review-workspace" },
      metadata: { reviewId: "rev_1" },
      title: "review rev_1",
      model: { id: "glm", providerID: "reviewer" },
    };

    const response = await dispatcher.handle({ id: 2, method: "session.create", params: input });
    expect(response).toMatchObject({ id: 2, ok: true });
    expect(harness.state.sessionsCreated).toEqual([input]);
    expect((response as { result?: unknown }).result).toEqual({ id: "sdksess_1" });
  });

  it("session.prompt and session.get forward the session id", async () => {
    const harness = makeFakeModule();
    const dispatcher = await createdHost(harness);

    await dispatcher.handle({
      id: 2,
      method: "session.prompt",
      params: { sessionID: "sdksess_1", text: "review this diff" },
    });
    expect(harness.state.prompts).toEqual([{ sessionID: "sdksess_1", text: "review this diff" }]);

    await dispatcher.handle({ id: 3, method: "session.get", params: { sessionID: "sdksess_1" } });
    expect(harness.state.gets).toEqual([{ sessionID: "sdksess_1" }]);
  });

  it("message.list returns the fake host's messages", async () => {
    const harness = makeFakeModule();
    harness.state.messages = [
      { type: "user", content: [{ type: "text", text: "hello" }] },
      { type: "assistant", content: [{ type: "text", text: "world" }] },
    ];
    const dispatcher = await createdHost(harness);

    const response = await dispatcher.handle({
      id: 2,
      method: "message.list",
      params: { sessionID: "sdksess_1", order: "asc" },
    });
    expect(response).toEqual({ id: 2, ok: true, result: harness.state.messages });
  });

  it("session.remove forwards the session id", async () => {
    const harness = makeFakeModule();
    const dispatcher = await createdHost(harness);

    await dispatcher.handle({ id: 2, method: "session.remove", params: { sessionID: "sdksess_1" } });
    expect(harness.state.removes).toEqual([{ sessionID: "sdksess_1" }]);
  });

  it("close calls host.close once and is idempotent", async () => {
    const harness = makeFakeModule();
    const dispatcher = await createdHost(harness);

    await dispatcher.handle({ id: 2, method: "close" });
    await dispatcher.handle({ id: 3, method: "close" });
    expect(harness.state.closes).toBe(1);
  });

  it("returns an SDK error as { ok: false, error: { message } } without throwing", async () => {
    const harness = makeFakeModule({ getError: new Error("boom") });
    const dispatcher = await createdHost(harness);

    const response = await dispatcher.handle({
      id: 2,
      method: "session.get",
      params: { sessionID: "sdksess_1" },
    });
    expect(response).toEqual({ id: 2, ok: false, error: { message: "boom" } });
  });

  it("health reports the module version without creating a host", async () => {
    const harness = makeFakeModule();
    const dispatcher = createSdkHostDispatcher(harness.loader, vi.fn());

    const response = await dispatcher.handle({ id: 1, method: "health" });
    expect(response).toMatchObject({ id: 1, ok: true });
    expect((response as { result?: unknown }).result).toMatchObject({
      version: expect.any(String),
    });
    expect(harness.loader).toHaveBeenCalledTimes(1);
    expect(harness.state.hostOptions).toHaveLength(0);
  });

  it("health rejects when the module has no OpenCode.create", async () => {
    const harness = makeFakeModule();
    const broken = {
      ...harness.sdkModule,
      OpenCode: {} as unknown as SdkModule["OpenCode"],
    };
    const dispatcher = createSdkHostDispatcher(
      vi.fn(async () => broken),
      vi.fn(),
    );

    const response = await dispatcher.handle({ id: 1, method: "health" });
    expect(response).toMatchObject({
      id: 1,
      ok: false,
      error: { message: expect.stringContaining("OpenCode.create") },
    });
  });
});

// ---------------------------------------------------------------------------
// Child process runner
// ---------------------------------------------------------------------------

describe("runHostProcess", () => {
  it("reads one request line, writes one response line, and resolves on close", async () => {
    const harness = makeFakeModule();
    const input = new PassThrough();
    const output = collectStream();
    const error = new PassThrough();
    error.on("data", () => {});

    const proc = runHostProcess({
      input,
      output: output.stream,
      error,
      loadSdk: harness.loader,
    });
    input.write(`${JSON.stringify({ id: 1, method: "health" })}\n`);
    input.end();

    await proc;

    const lines = output
      .data()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(1);
    expect(first(lines)).toMatchObject({ id: 1, ok: true });
    expect(first(lines).result).toMatchObject({ version: expect.any(String) });
  });

  it("a malformed request line produces an error response rather than crashing", async () => {
    const harness = makeFakeModule();
    const input = new PassThrough();
    const output = collectStream();
    const error = new PassThrough();
    error.on("data", () => {});

    const proc = runHostProcess({
      input,
      output: output.stream,
      error,
      loadSdk: harness.loader,
    });
    input.write("this is not json\n");
    input.end();

    await proc;

    const lines = output
      .data()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(1);
    expect(first(lines)).toMatchObject({ id: 0, ok: false });
    expect(first(lines).error).toMatchObject({ message: expect.stringContaining("malformed") });
  });
});
