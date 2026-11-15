import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  createStdioSdkHostClient,
  probeSdkHost,
  type SdkHostClientOptions,
} from "../src/platform/agents/sdk/client.js";

// ---------------------------------------------------------------------------
// Fake child process
// ---------------------------------------------------------------------------

class FakeStdin extends EventEmitter {
  readonly writes: string[] = [];
  ended = false;

  write(data: string): boolean {
    this.writes.push(data);
    return true;
  }

  end(): void {
    this.ended = true;
  }
}

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = new FakeStdin();
  readonly pid = 4242;
  readonly signals: string[] = [];
  killed = false;
  exitCode: number | null = null;

  kill(signal?: string): boolean {
    this.signals.push(signal ?? "SIGTERM");
    this.killed = true;
    return true;
  }

  emitStdout(data: string): void {
    this.stdout.emit("data", Buffer.from(data));
  }

  emitStderr(data: string): void {
    this.stderr.emit("data", Buffer.from(data));
  }

  exit(code: number): void {
    this.exitCode = code;
    this.emit("exit", code, null);
  }

  error(message: string): void {
    this.emit("error", new Error(message));
  }
}

const baseOptions: SdkHostClientOptions = {
  configContent: '{"model":"reviewer/glm"}',
  databasePath: "/tmp/opencode.db",
  workspacePath: "/tmp/review-workspace",
  env: { MODEL_API_KEY: "test-key", NODE_ENV: "test" },
  hostProcessPath: "/repo/lib/agent/sdk/host-process.js",
  sessionId: "sess_test",
  reviewId: "rev_test",
};

function makeClient(child: FakeChild, overrides: Partial<SdkHostClientOptions> = {}) {
  const spawnImpl = vi.fn(() => child) as unknown as typeof spawn;
  const client = createStdioSdkHostClient({ ...baseOptions, ...overrides, spawnImpl });
  return { client, spawnImpl };
}

function startRequest(child: FakeChild): { id: number; method: string; params: unknown } {
  const line = child.stdin.writes[0];
  expect(line).toBeTruthy();
  return JSON.parse(line) as { id: number; method: string; params: unknown };
}

/** Start the client and complete the `create` handshake (id 1). */
async function started(client: ReturnType<typeof createStdioSdkHostClient>, child: FakeChild) {
  const startPromise = client.start();
  const request = startRequest(child);
  expect(request).toMatchObject({ id: 1, method: "create" });
  child.emitStdout(`${JSON.stringify({ id: 1, ok: true })}\n`);
  await startPromise;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

describe("SDK host stdio client", () => {
  it("start() spawns the host process with shell:false, the env and the cwd", async () => {
    const child = new FakeChild();
    const { client, spawnImpl } = makeClient(child);

    const startPromise = client.start();
    child.emitStdout(`${JSON.stringify({ id: 1, ok: true })}\n`);
    await startPromise;

    expect(spawnImpl).toHaveBeenCalledWith(process.execPath, [baseOptions.hostProcessPath], {
      cwd: baseOptions.workspacePath,
      env: baseOptions.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
  });

  it("start() sends a create request with the inline config and database path", async () => {
    const child = new FakeChild();
    const { client } = makeClient(child);

    const startPromise = client.start();
    const request = startRequest(child);
    expect(request).toMatchObject({
      id: 1,
      method: "create",
      params: {
        configContent: baseOptions.configContent,
        databasePath: baseOptions.databasePath,
      },
    });
    child.emitStdout(`${JSON.stringify({ id: 1, ok: true })}\n`);
    await startPromise;
  });

  it("a response with the matching id resolves the pending call", async () => {
    const child = new FakeChild();
    const { client } = makeClient(child);
    await started(client, child);

    const pending = client.getSession({ sessionID: "sdksess_1" });
    child.emitStdout(`${JSON.stringify({ id: 2, ok: true, result: { id: "sdksess_1", time: { idle: 5 } } })}\n`);
    await expect(pending).resolves.toEqual({ id: "sdksess_1", time: { idle: 5 } });
  });

  it("reassembles split/partial response lines", async () => {
    const child = new FakeChild();
    const { client } = makeClient(child);
    await started(client, child);

    const pending = client.getSession({ sessionID: "sdksess_1" });
    child.emitStdout('{"id":2,"ok":true,"res');
    child.emitStdout('ult":{"id":"sess_1"}}\n');
    await expect(pending).resolves.toEqual({ id: "sess_1" });
  });

  it("a non-JSON stdout line rejects the pending call with a protocol error", async () => {
    const child = new FakeChild();
    const { client } = makeClient(child);
    await started(client, child);

    const pending = client.getSession({ sessionID: "sdksess_1" });
    child.emitStdout("this is not json\n");
    await expect(pending).rejects.toMatchObject({ code: "crash" });
  });

  it("an {ok:false} protocol response maps to a non-crash error code", async () => {
    const child = new FakeChild();
    const { client } = makeClient(child);
    await started(client, child);

    const pending = client.getSession({ sessionID: "missing" });
    child.emitStdout(`${JSON.stringify({ id: 2, ok: false, error: { message: "session not found" } })}\n`);
    const error = await pending.catch((cause) => cause as { code?: string });
    expect(error.code).toBe("unknown");
    expect(error.code).not.toBe("crash");
  });

  it("a structurally invalid protocol response fails every pending call", async () => {
    const child = new FakeChild();
    const { client } = makeClient(child);
    await started(client, child);

    const pending = client.getSession({ sessionID: "sdksess_1" });
    child.emitStdout(`${JSON.stringify({ id: 2, ok: "yes", result: { id: "sdksess_1" } })}\n`);
    await expect(pending).rejects.toMatchObject({
      code: "crash",
      message: expect.stringContaining("invalid protocol line"),
    });
  });

  it("an invalid method result fails closed instead of crossing the boundary untyped", async () => {
    const child = new FakeChild();
    const { client } = makeClient(child);
    await started(client, child);

    const pending = client.getSession({ sessionID: "sdksess_1" });
    child.emitStdout(`${JSON.stringify({ id: 2, ok: true, result: { id: 42 } })}\n`);
    await expect(pending).rejects.toMatchObject({
      code: "crash",
      message: expect.stringContaining("invalid session.get result"),
    });
  });

  it("message.list results are validated against the message contract", async () => {
    const child = new FakeChild();
    const { client } = makeClient(child);
    await started(client, child);

    const pending = client.listMessages({ sessionID: "sdksess_1" });
    child.emitStdout(`${JSON.stringify({ id: 2, ok: true, result: { data: [] } })}\n`);
    await expect(pending).rejects.toMatchObject({
      code: "crash",
      message: expect.stringContaining("invalid message.list result"),
    });
  });

  it("child exit rejects every pending call", async () => {
    const child = new FakeChild();
    const { client } = makeClient(child);
    await started(client, child);

    const first = client.getSession({ sessionID: "a" });
    const second = client.getSession({ sessionID: "b" });
    child.exit(1);
    await expect(first).rejects.toMatchObject({ code: "crash" });
    await expect(second).rejects.toMatchObject({ code: "crash" });
  });

  it("child error rejects every pending call", async () => {
    const child = new FakeChild();
    const { client } = makeClient(child);
    await started(client, child);

    const pending = client.getSession({ sessionID: "a" });
    child.error("spawn failed");
    await expect(pending).rejects.toMatchObject({ code: "crash" });
  });

  it("forwards stderr lines to the callback and never parses them as protocol", async () => {
    const onStderr = vi.fn();
    const child = new FakeChild();
    const { client } = makeClient(child, { onStderr });
    await started(client, child);

    child.emitStderr('{"type":"log","level":"error","message":"a diagnostic"}\n');
    expect(onStderr).toHaveBeenCalledWith('{"type":"log","level":"error","message":"a diagnostic"}');

    // The stderr line must not resolve or reject any pending call.
    const pending = client.getSession({ sessionID: "a" });
    child.emitStdout(`${JSON.stringify({ id: 2, ok: true, result: { id: "sess_a" } })}\n`);
    await expect(pending).resolves.toEqual({ id: "sess_a" });
  });

  it("kill() sends SIGTERM and is idempotent", async () => {
    const child = new FakeChild();
    const { client } = makeClient(child);
    await started(client, child);

    client.kill();
    expect(child.signals).toEqual(["SIGTERM"]);

    client.kill();
    expect(child.signals).toEqual(["SIGTERM"]);
  });

  it("close() retains the child handle so a later kill() can still signal it", async () => {
    const child = new FakeChild();
    const { client } = makeClient(child);
    await started(client, child);

    const closing = client.close();
    // The close request is id 2 (after the create handshake).
    expect(child.stdin.writes[1]).toBe(`${JSON.stringify({ id: 2, method: "close" })}\n`);
    child.emitStdout(`${JSON.stringify({ id: 2, ok: true })}\n`);
    await closing;

    // The child has not exited; kill() must still reach its handle.
    client.kill();
    expect(child.signals).toEqual(["SIGTERM"]);
  });

  it("probeSdkHost spawns a temp child, sends health, returns the version, and kills it", async () => {
    const child = new FakeChild();
    const spawnImpl = vi.fn(() => child) as unknown as typeof spawn;

    const pending = probeSdkHost({
      env: baseOptions.env,
      hostProcessPath: baseOptions.hostProcessPath,
      spawnImpl,
    });

    expect(spawnImpl).toHaveBeenCalledWith(process.execPath, [baseOptions.hostProcessPath], {
      env: baseOptions.env,
      shell: false,
      stdio: ["pipe", "pipe", "ignore"],
    });
    expect(child.stdin.writes[0]).toBe(`${JSON.stringify({ id: 1, method: "health" })}\n`);

    child.emitStdout(`${JSON.stringify({ id: 1, ok: true, result: { version: "2.3.0" } })}\n`);
    await expect(pending).resolves.toEqual({ version: "2.3.0" });
    expect(child.signals).toContain("SIGTERM");
  });
});
