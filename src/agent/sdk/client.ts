/**
 * Parent-side stdio client for the isolated SDK host process (Task 3).
 *
 * Spawns `lib/agent/sdk/host-process.js` as a child, speaking the
 * line-delimited JSON protocol: one request per stdin line, one response per
 * stdout line, `{ type: "log" }` diagnostics on stderr. The child stdout is
 * protocol-only; stderr is forwarded to a callback and never parsed.
 *
 * The Task 4 runtime adapter builds on this client. It owns the total
 * execution deadline; this client only bounds individual request round-trips.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import { AgentRuntimeError } from "../types.js";
import type { SdkHostMethod, SdkHostRequest, SdkHostResponse } from "./protocol.js";
import type { SdkCreateSessionInput, SdkMessage, SdkPromptInput, SdkSessionRef, SdkSessionRow } from "./types.js";

/** Maximum bytes of a single protocol line (a global protocol constraint). */
const MAX_LINE_BYTES = 1024 * 1024; // 1 MiB
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const CLOSE_GRACE_MS = 2_000;
const KILL_ESCALATION_MS = 2_000;

export interface SdkHostClientOptions {
  configContent: string;
  databasePath: string;
  workspacePath: string;
  env: NodeJS.ProcessEnv;
  hostProcessPath: string;
  sessionId: string;
  reviewId: string;
  spawnImpl?: typeof spawn;
  requestTimeoutMs?: number;
  onStderr?: (line: string) => void;
}

export interface SdkHostClient {
  start(): Promise<void>;
  createSession(input: SdkCreateSessionInput): Promise<SdkSessionRow>;
  getSession(input: SdkSessionRef): Promise<SdkSessionRow>;
  prompt(input: SdkPromptInput): Promise<void>;
  listMessages(input: SdkSessionRef & { order?: "asc" | "desc" }): Promise<SdkMessage[]>;
  removeSession(input: SdkSessionRef): Promise<void>;
  close(): Promise<void>;
  kill(): void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  method: SdkHostMethod;
}

class StdioSdkHostClient implements SdkHostClient {
  private readonly options: SdkHostClientOptions;
  private readonly requestTimeoutMs: number;
  private readonly spawnImpl: typeof spawn;

  private child?: ChildProcess;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private killed = false;
  private closed = false;

  private readonly stdoutDecoder = new StringDecoder("utf8");
  private readonly stderrDecoder = new StringDecoder("utf8");
  private stdoutBuffer = "";
  private stderrBuffer = "";

  constructor(options: SdkHostClientOptions) {
    this.options = options;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.spawnImpl = options.spawnImpl ?? spawn;
  }

  async start(): Promise<void> {
    if (this.child) {
      return;
    }
    const child = this.spawnImpl(process.execPath, [this.options.hostProcessPath], {
      cwd: this.options.workspacePath,
      env: this.options.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.wire(child);
    await this.request("create", {
      configContent: this.options.configContent,
      databasePath: this.options.databasePath,
    });
  }

  async createSession(input: SdkCreateSessionInput): Promise<SdkSessionRow> {
    return (await this.request("session.create", input)) as SdkSessionRow;
  }

  async getSession(input: SdkSessionRef): Promise<SdkSessionRow> {
    return (await this.request("session.get", input)) as SdkSessionRow;
  }

  async prompt(input: SdkPromptInput): Promise<void> {
    await this.request("session.prompt", input);
  }

  async listMessages(input: SdkSessionRef & { order?: "asc" | "desc" }): Promise<SdkMessage[]> {
    return (await this.request("message.list", input)) as SdkMessage[];
  }

  async removeSession(input: SdkSessionRef): Promise<void> {
    await this.request("session.remove", input);
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child || this.closed) {
      return;
    }
    this.closed = true;
    try {
      await Promise.race([this.request("close", undefined), sleep(CLOSE_GRACE_MS)]);
    } catch {
      // Closing is best-effort; a failed close must not surface to the adapter.
    } finally {
      // Keep the child handle alive: `this.child` is only cleared on the actual
      // `exit`/`error` event, so a later `kill()` can still signal a hung child.
      child.stdin?.end();
    }
  }

  kill(): void {
    const child = this.child;
    if (!child || this.killed) {
      return;
    }
    this.killed = true;
    child.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }, KILL_ESCALATION_MS);
    timer.unref?.();
  }

  // -------------------------------------------------------------------------
  // Protocol plumbing
  // -------------------------------------------------------------------------

  private wire(child: ChildProcess): void {
    child.stdout?.on("data", (chunk: Buffer | string) => this.onStdout(chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => this.onStderrData(chunk));
    child.once("exit", (code, signal) => {
      this.failAll(
        new AgentRuntimeError(
          "crash",
          `opencode sdk host exited unexpectedly (code ${code ?? "?"}, signal ${signal ?? "none"})`,
        ),
      );
      this.child = undefined;
    });
    child.once("error", (error) => {
      this.failAll(
        new AgentRuntimeError("crash", `opencode sdk host failed: ${error.message}`, {
          detail: error.message,
        }),
      );
      this.child = undefined;
    });
  }

  private request(method: SdkHostMethod, params: unknown): Promise<unknown> {
    if (!this.child) {
      return Promise.reject(new AgentRuntimeError("crash", "opencode sdk host is not running", { detail: method }));
    }
    const id = this.nextId;
    this.nextId += 1;
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new AgentRuntimeError("timeout", `opencode sdk host request ${method} timed out`, {
            detail: method,
          }),
        );
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });
    });
    this.writeLine({ id, method, params });
    return response;
  }

  private writeLine(request: SdkHostRequest): void {
    this.child?.stdin?.write(`${JSON.stringify(request)}\n`);
  }

  private onStdout(chunk: Buffer | string): void {
    this.stdoutBuffer += this.stdoutDecoder.write(chunk);
    let idx = this.stdoutBuffer.indexOf("\n");
    while (idx >= 0) {
      const line = this.stdoutBuffer.slice(0, idx);
      this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
      if (line.trim() !== "") {
        this.handleResponseLine(line);
      }
      idx = this.stdoutBuffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.stdoutBuffer, "utf8") > MAX_LINE_BYTES) {
      this.stdoutBuffer = "";
      this.failAll(new AgentRuntimeError("crash", "opencode sdk host emitted an over-long protocol line"));
    }
  }

  private handleResponseLine(line: string): void {
    let response: SdkHostResponse;
    try {
      response = JSON.parse(line) as SdkHostResponse;
    } catch {
      this.failAll(
        new AgentRuntimeError("crash", "opencode sdk host emitted an invalid protocol line", {
          detail: line,
        }),
      );
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    } // late or duplicate response — ignore.
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.ok) {
      pending.resolve(response.result);
    } else {
      const message = response.error?.message ?? "opencode sdk host request failed";
      // An SDK-level failure returned over the wire (e.g. "session not found")
      // is not a process crash; `crash` is reserved for genuine exit/parse
      // failures. The runtime adapter owns any finer classification.
      pending.reject(
        new AgentRuntimeError("unknown", message, {
          detail: message,
        }),
      );
    }
  }

  private onStderrData(chunk: Buffer | string): void {
    if (!this.options.onStderr) {
      return;
    }
    this.stderrBuffer += this.stderrDecoder.write(chunk);
    let idx = this.stderrBuffer.indexOf("\n");
    while (idx >= 0) {
      const line = this.stderrBuffer.slice(0, idx);
      this.stderrBuffer = this.stderrBuffer.slice(idx + 1);
      if (line.trim() !== "") {
        this.options.onStderr(line);
      }
      idx = this.stderrBuffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.stderrBuffer, "utf8") > MAX_LINE_BYTES) {
      this.stderrBuffer = "";
    }
  }

  private failAll(error: AgentRuntimeError): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export function createStdioSdkHostClient(options: SdkHostClientOptions): SdkHostClient {
  return new StdioSdkHostClient(options);
}

/**
 * Liveness probe: spawn a temporary child, ask for `health`, and return the
 * resolved SDK version. The child is always killed in `finally`.
 */
export async function probeSdkHost(options: {
  env: NodeJS.ProcessEnv;
  hostProcessPath: string;
  spawnImpl?: typeof spawn;
  requestTimeoutMs?: number;
}): Promise<{ version: string }> {
  const spawnImpl = options.spawnImpl ?? spawn;
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const child = spawnImpl(process.execPath, [options.hostProcessPath], {
    env: options.env,
    shell: false,
    stdio: ["pipe", "pipe", "ignore"],
  });
  try {
    const result = await requestHealth(child, timeoutMs);
    const version =
      result && typeof result === "object" && "version" in result
        ? String((result as { version: unknown }).version ?? "unknown")
        : "unknown";
    return { version };
  } finally {
    if (child.exitCode === null && !child.killed) {
      child.kill("SIGTERM");
    }
  }
}

/** Send a single `health` request and resolve with its result. */
function requestHealth(child: ChildProcess, timeoutMs: number): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const decoder = new StringDecoder("utf8");
    let buffer = "";

    const timer = setTimeout(() => {
      cleanup();
      reject(new AgentRuntimeError("timeout", "opencode sdk host health probe timed out"));
    }, timeoutMs);
    timer.unref?.();

    const cleanup = (): void => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
    };

    const onData = (chunk: Buffer | string): void => {
      buffer += decoder.write(chunk);
      let idx = buffer.indexOf("\n");
      while (idx >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.trim() === "") {
          idx = buffer.indexOf("\n");
          continue;
        }
        let response: SdkHostResponse;
        try {
          response = JSON.parse(line) as SdkHostResponse;
        } catch {
          cleanup();
          reject(new AgentRuntimeError("crash", "opencode sdk host health probe returned invalid output"));
          return;
        }
        if (response.id === 1) {
          cleanup();
          if (response.ok) {
            resolve(response.result);
          } else {
            reject(
              new AgentRuntimeError("unknown", response.error?.message ?? "health probe failed", {
                detail: response.error?.message,
              }),
            );
          }
          return;
        }
        idx = buffer.indexOf("\n");
      }
    };

    const onExit = (code: number | null): void => {
      cleanup();
      reject(new AgentRuntimeError("crash", `opencode sdk host exited during health probe (code ${code ?? "?"})`));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(new AgentRuntimeError("crash", `opencode sdk host failed during health probe: ${error.message}`));
    };

    child.stdout?.on("data", onData);
    child.once("exit", onExit);
    child.once("error", onError);
    child.stdin?.write(`${JSON.stringify({ id: 1, method: "health" })}\n`);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}
