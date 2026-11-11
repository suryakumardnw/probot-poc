/**
 * OpenCode SDK agent runtime adapter (Phase 2a, docs/architecture-sdk-runtime.md
 * §12). Implements the existing `AgentRuntime` contract on top of
 * `@opencode/sdk@2.2.7`.
 *
 * Key facts from the Phase 0 spike this adapter follows:
 * - The host is created from inline configuration (`config.content`) with a
 *   per-session database and `models.fetch = false`.
 * - Completion is detected by polling `sessions.get(...).time.idle`; the
 *   `session.idle` event stream is NOT reliable enough to drive completion.
 * - Cleanup is an explicit `host.close()` in a `try/finally` (never
 *   `await using`).
 * - `@opencode/sdk` is loaded through a dynamic import with a variable
 *   specifier behind an injectable loader, so neither the production runtime
 *   nor `tsc` depends on the package (it cannot be imported on Node 20/22).
 *
 * Phase 2a is deliberately host-per-review: the long-lived host is Phase 3.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";

import {
  AgentRuntimeError,
  type AgentResult,
  type AgentRuntime,
  type AgentSession,
  type AgentSessionOptions,
  type AgentTask,
  type RuntimeHealth,
} from "./types.js";
import type { AgentRuntimeConfigSource } from "./opencode-config.js";
import { extractJson, type AgentRuntimeLogger } from "./opencode-runtime.js";
import {
  buildSdkInlineConfig,
  SDK_MODEL_KEY,
  SDK_PROVIDER_ID,
} from "./sdk/config.js";
import type {
  SdkHost,
  SdkHostOptions,
  SdkLoader,
  SdkLogEntry,
  SdkMessage,
  SdkModule,
  SdkSessionRow,
} from "./sdk/types.js";

const MAX_DETAIL_LENGTH = 500;
const DEFAULT_POLL_INTERVAL_MS = 250;
const SESSION_ROOT = "opencode-sdk-sessions";
const REQUIRED_NODE_MAJOR = 24;

export interface SdkRuntimeOptions {
  logger?: AgentRuntimeLogger;
  /** Dynamic SDK loader override (tests inject a fake module). */
  loadSdk?: SdkLoader;
  /** `git status --porcelain` override; undefined skips the integrity guard. */
  gitStatusImpl?: (workspacePath: string) => Promise<string | undefined>;
  /** fs.rm override for tests. */
  rmImpl?: (dir: string, options: { recursive: true; force: true }) => Promise<void>;
  /** Sleep override for tests (polling cadence). */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Clock override for tests. */
  now?: () => number;
  /** Completion poll cadence. Defaults to 250 ms. */
  pollIntervalMs?: number;
  /** Default per-task timeout when the session options do not set one. */
  defaultTimeoutMs?: number;
  /**
   * Egress seam (Phase 2b): a proxy-aware fetch supplied by the SDK worker and
   * forwarded to `OpenCode.create`. The adapter never chooses a proxy itself.
   */
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

interface SessionState {
  options: AgentSessionOptions;
  session: AgentSession;
  dir: string;
  host?: SdkHost;
  sdkSessionId?: string;
  inlineConfig?: Record<string, unknown>;
  terminated: boolean;
}

type NormalizedUsage = { inputTokens?: number; outputTokens?: number; reasoningTokens?: number };

/**
 * Default loader: a dynamic import with a variable specifier. `tsc` must not
 * resolve `@opencode/sdk` (it is not installed in the production image).
 */
const defaultLoadSdk: SdkLoader = async () => {
  const specifier = "@opencode/sdk";
  return (await import(specifier)) as unknown as SdkModule;
};

export class OpenCodeSdkAgentRuntime implements AgentRuntime {
  private readonly config: AgentRuntimeConfigSource;
  private readonly logger?: AgentRuntimeLogger;
  private readonly loadSdk: SdkLoader;
  private readonly gitStatusImpl: (workspacePath: string) => Promise<string | undefined>;
  private readonly rmImpl: (dir: string, options: { recursive: true; force: true }) => Promise<void>;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly pollIntervalMs: number;
  private readonly defaultTimeoutMs: number;
  private readonly fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  private readonly sessions = new Map<string, SessionState>();
  private readonly terminated = new Set<string>();

  constructor(config: AgentRuntimeConfigSource, options: SdkRuntimeOptions = {}) {
    this.config = config;
    this.logger = options.logger;
    this.loadSdk = options.loadSdk ?? defaultLoadSdk;
    this.gitStatusImpl = options.gitStatusImpl ?? defaultGitStatus;
    this.rmImpl = options.rmImpl ?? rm;
    this.sleepImpl = options.sleepImpl ?? sleep;
    this.now = options.now ?? Date.now;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? config.agent.runtime.timeoutMs;
    this.fetchImpl = options.fetchImpl;
  }

  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------

  async startSession(options: AgentSessionOptions): Promise<AgentSession> {
    const id = `sess_${randomUUID()}`;
    const dir = path.join(os.tmpdir(), SESSION_ROOT, sessionDirKey(id, options.reviewId));
    await mkdir(dir, { recursive: true });

    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const session: AgentSession = {
      id,
      reviewId: options.reviewId,
      workspacePath: options.workspacePath,
      createdAt: new Date(this.now()).toISOString(),
      timeoutMs,
    };
    this.sessions.set(id, { options, session, dir, terminated: false });

    this.logger?.info("agent sdk session created", {
      event: "agent_sdk_session_created",
      sessionId: id,
      reviewId: options.reviewId,
      providerType: this.config.provider.type,
      apiKeyEnv: this.config.provider.apiKeyEnv,
      workspacePath: options.workspacePath,
      timeoutMs,
      mode: "host-per-review",
    });

    // Contract: startSession must not spawn. The host is created lazily on the
    // first execute().
    return session;
  }

  async execute(session: AgentSession, task: AgentTask): Promise<AgentResult> {
    const state = this.sessions.get(session.id);
    if (!state || state.terminated || this.terminated.has(session.id)) {
      throw new AgentRuntimeError("config", "session is terminated", { sessionId: session.id });
    }

    const startedAt = this.now();
    const deadline = startedAt + session.timeoutMs;
    this.logger?.info("agent sdk execute started", {
      event: "agent_sdk_execute_started",
      sessionId: session.id,
      reviewId: session.reviewId,
      workspacePath: session.workspacePath,
      timeoutMs: session.timeoutMs,
      outputMode: task.output,
      instructionChars: task.instruction.length,
    });

    // The timeout bounds the ENTIRE execute lifecycle: host creation, SDK
    // session creation, prompt admission, idle polling and output collection.
    // Polling alone is not enough (a hung host/prompt/get would otherwise
    // escape the deadline). The timer closes the host to stop in-flight work.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const totalTimeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Mark and reject BEFORE closing: closing the host can make an
        // in-flight SDK call fail, and that failure must not win the race
        // with a generic crash/spawn error at the deadline.
        timedOut = true;
        this.logTimeout(session);
        reject(this.timeoutError(session));
        void this.closeHost(state);
      }, Math.max(0, session.timeoutMs));
      timer.unref?.();
    });
    // The race owns rejection handling for both promises; attach a no-op so a
    // late loser never surfaces as an unhandled rejection.
    totalTimeout.catch(() => {});

    try {
      const result = await Promise.race([
        this.runExecute(state, task, startedAt, deadline),
        totalTimeout,
      ]);
      this.logger?.info("agent sdk execute completed", {
        event: "agent_sdk_execute_completed",
        sessionId: session.id,
        reviewId: session.reviewId,
        durationMs: result.durationMs,
        outputMode: task.output,
        textChars: result.text.length,
        usage: result.usage,
      });
      return result;
    } catch (error) {
      let normalized =
        error instanceof AgentRuntimeError
          ? error
          : new AgentRuntimeError("crash", "opencode sdk execution failed", {
              sessionId: session.id,
              detail: this.safeDetail(error),
              cause: error,
            });
      // If the deadline fired, normalize any concurrent close-induced failure
      // (crash/spawn) to a timeout.
      if (timedOut && normalized.code !== "timeout") {
        normalized = this.timeoutError(session);
      }
      this.logger?.error("agent sdk execute failed", {
        event: "agent_sdk_execute_failed",
        sessionId: session.id,
        reviewId: session.reviewId,
        code: normalized.code,
        detail: normalized.detail ? truncate(normalized.detail, MAX_DETAIL_LENGTH) : undefined,
      });
      throw normalized;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async terminate(session: AgentSession): Promise<void> {
    this.terminated.add(session.id);
    const state = this.sessions.get(session.id);
    if (!state) {
      // Idempotent: already terminated or never started. Keep the marker
      // bounded so it cannot grow without limit over a long-lived host.
      this.terminated.delete(session.id);
      return;
    }
    state.terminated = true;

    const host = state.host;
    const sdkSessionId = state.sdkSessionId;
    state.host = undefined;
    state.sdkSessionId = undefined;

    if (host) {
      try {
        if (sdkSessionId) await host.sessions.remove({ sessionID: sdkSessionId });
      } catch (cause) {
        this.logger?.warn("agent sdk session remove failed", {
          event: "agent_sdk_session_remove_failed",
          sessionId: session.id,
          reviewId: session.reviewId,
          detail: this.safeDetail(cause),
        });
      } finally {
        try {
          await host.close();
        } catch (cause) {
          this.logger?.warn("agent sdk host close failed", {
            event: "agent_sdk_host_close_failed",
            sessionId: session.id,
            reviewId: session.reviewId,
            detail: this.safeDetail(cause),
          });
        }
      }
    }

    try {
      await this.rmImpl(state.dir, { recursive: true, force: true });
    } catch (cause) {
      this.logger?.warn("agent sdk session directory cleanup failed", {
        event: "agent_sdk_session_cleanup_failed",
        sessionId: session.id,
        reviewId: session.reviewId,
        detail: this.safeDetail(cause),
      });
    }

    this.sessions.delete(session.id);
    this.terminated.delete(session.id);
    this.logger?.debug("agent sdk session terminated", {
      event: "agent_sdk_session_terminated",
      sessionId: session.id,
      reviewId: session.reviewId,
    });
  }

  async healthCheck(): Promise<RuntimeHealth> {
    const checkedAt = new Date(this.now()).toISOString();
    try {
      const sdk = await this.loadSdk();
      if (!sdk?.OpenCode || typeof sdk.OpenCode.create !== "function") {
        return {
          healthy: false,
          detail: "opencode-sdk unavailable: module has no OpenCode.create",
          checkedAt,
        };
      }
      return { healthy: true, detail: `opencode-sdk ${resolveSdkVersion()}`, checkedAt };
    } catch (cause) {
      const reason = this.safeDetail(cause) ?? "import failed";
      return {
        healthy: false,
        detail: `opencode-sdk unavailable: ${truncate(reason, MAX_DETAIL_LENGTH)}`,
        checkedAt,
      };
    }
  }

  // -------------------------------------------------------------------------
  // Execution internals
  // -------------------------------------------------------------------------

  private async runExecute(
    state: SessionState,
    task: AgentTask,
    startedAt: number,
    deadline: number,
  ): Promise<AgentResult> {
    const session = state.session;
    this.throwIfExpired(session, deadline);
    // Baseline for the mandatory post-run workspace integrity guard.
    const baseline = await this.gitStatusImpl(session.workspacePath);

    const host = await this.ensureHost(state);
    this.throwIfExpired(session, deadline);
    const sdkSessionId = await this.ensureSdkSession(state, host);
    this.throwIfExpired(session, deadline);

    const promptStarted = this.now();
    try {
      await host.sessions.prompt({ sessionID: sdkSessionId, text: task.instruction });
    } catch (cause) {
      if (this.now() >= deadline) this.throwTimeout(session);
      throw new AgentRuntimeError("crash", "opencode sdk prompt admission failed", {
        sessionId: session.id,
        detail: this.safeDetail(cause),
        cause,
      });
    }

    const finalRow = await this.waitForIdle(state, host, sdkSessionId, promptStarted, deadline);
    if (finalRow.outcome === "failed") {
      throw new AgentRuntimeError(
        "provider_unavailable",
        "opencode sdk session finished with outcome=failed",
        { sessionId: session.id, detail: this.safeDetail(finalRow) },
      );
    }

    this.throwIfExpired(session, deadline);
    const { text, usage } = await this.collectOutput(host, sdkSessionId);
    if (!text) {
      throw new AgentRuntimeError("invalid_output", "agent produced no output", {
        sessionId: session.id,
      });
    }

    const result: AgentResult = {
      sessionId: session.id,
      text,
      durationMs: Math.max(0, this.now() - startedAt),
      ...(usage ? { usage } : {}),
    };

    if (task.output === "json") {
      const extracted = extractJson(text);
      if (extracted === undefined) {
        throw new AgentRuntimeError(
          "invalid_output",
          "agent output did not contain a JSON object",
          { sessionId: session.id, detail: truncate(this.scrub(text), MAX_DETAIL_LENGTH) },
        );
      }
      let value: unknown;
      try {
        value = JSON.parse(extracted);
      } catch {
        throw new AgentRuntimeError("invalid_output", "agent JSON output failed to parse", {
          sessionId: session.id,
          detail: truncate(this.scrub(extracted), MAX_DETAIL_LENGTH),
        });
      }
      if (task.validate) {
        const verdict = task.validate(value);
        if (!verdict.ok) {
          throw new AgentRuntimeError("invalid_output", "agent output failed validation", {
            sessionId: session.id,
            detail: truncate(this.scrub(verdict.error), MAX_DETAIL_LENGTH),
          });
        }
        result.value = verdict.value;
      }
      result.json = value;
    }

    await this.assertWorkspaceUnchanged(state, baseline);
    return result;
  }

  private async ensureHost(state: SessionState): Promise<SdkHost> {
    if (state.host) return state.host;
    const session = state.session;

    let sdk: SdkModule;
    try {
      sdk = await this.loadSdk();
    } catch (cause) {
      const unsupported = isUnsupportedNode() || cause instanceof SyntaxError;
      throw new AgentRuntimeError(
        unsupported ? "config" : "spawn",
        unsupported
          ? `opencode sdk requires Node >= ${REQUIRED_NODE_MAJOR}`
          : "failed to load opencode sdk",
        {
          sessionId: session.id,
          detail: unsupported
            ? `Node ${process.versions.node} cannot load @opencode/sdk: ${this.safeDetail(cause) ?? "unsupported syntax"}`
            : this.safeDetail(cause),
          cause,
        },
      );
    }

    try {
      state.inlineConfig ??= buildSdkInlineConfig(this.config, process.env, {
        maxOutputTokens:
          state.options.maxOutputTokens ?? this.config.agent.context.maxOutputTokens,
      });

      const hostOptions: SdkHostOptions = {
        config: {
          // No config file is written; provider credentials stay `{env:...}`.
          content: JSON.stringify(state.inlineConfig),
          project: false,
          claude: false,
        },
        database: { path: path.join(state.dir, "opencode.db") },
        models: { fetch: false },
        fs: { filewatcher: false },
        log: {
          level: "error",
          emit: (entry: SdkLogEntry) => this.logSdkEntry(session, entry),
        },
      };
      if (this.fetchImpl) hostOptions.fetch = this.fetchImpl;

      const host = await sdk.OpenCode.create(hostOptions);
      state.host = host;
      this.logger?.info("agent sdk host created", {
        event: "agent_sdk_host_created",
        sessionId: session.id,
        reviewId: session.reviewId,
        model: `${SDK_PROVIDER_ID}/${SDK_MODEL_KEY}`,
        providerType: this.config.provider.type,
        egressFetchInjected: Boolean(this.fetchImpl),
      });
      return host;
    } catch (cause) {
      throw new AgentRuntimeError("spawn", "failed to create opencode sdk host", {
        sessionId: session.id,
        detail: this.safeDetail(cause),
        cause,
      });
    }
  }

  private async ensureSdkSession(state: SessionState, host: SdkHost): Promise<string> {
    if (state.sdkSessionId) return state.sdkSessionId;
    const session = state.session;
    try {
      const row = await host.sessions.create({
        location: { directory: session.workspacePath },
        metadata: { reviewId: session.reviewId },
        title: `review ${session.reviewId}`,
        model: { id: SDK_MODEL_KEY, providerID: SDK_PROVIDER_ID },
      });
      state.sdkSessionId = row.id;
      this.logger?.info("agent sdk session created", {
        event: "agent_sdk_session_created",
        sessionId: session.id,
        reviewId: session.reviewId,
        sdkSessionId: row.id,
      });
      return row.id;
    } catch (cause) {
      throw new AgentRuntimeError("spawn", "failed to create opencode sdk session", {
        sessionId: session.id,
        detail: this.safeDetail(cause),
        cause,
      });
    }
  }

  /**
   * Poll `sessions.get(...).time.idle` until the turn completes. Phase 0 showed
   * the event stream can miss the idle transition, so polling is authoritative.
   */
  private async waitForIdle(
    state: SessionState,
    host: SdkHost,
    sdkSessionId: string,
    promptStarted: number,
    deadline: number,
  ): Promise<SdkSessionRow> {
    const session = state.session;
    for (;;) {
      if (state.terminated || this.terminated.has(session.id)) {
        throw new AgentRuntimeError("crash", "session terminated during execution", {
          sessionId: session.id,
        });
      }
      let row: SdkSessionRow | undefined;
      try {
        row = await host.sessions.get({ sessionID: sdkSessionId });
      } catch {
        row = undefined; // transient; the deadline owns the failure
      }
      if (row && typeof row.time?.idle === "number" && row.time.idle >= promptStarted) {
        return row;
      }
      if (this.now() >= deadline) {
        // Stop in-flight work before surfacing the timeout.
        await this.closeHost(state);
        this.logTimeout(session);
        throw new AgentRuntimeError(
          "timeout",
          `opencode sdk execute timed out after ${session.timeoutMs}ms`,
          { sessionId: session.id },
        );
      }
      await this.sleepImpl(this.pollIntervalMs);
    }
  }

  /** Fail fast when the total execution deadline has passed. */
  private throwIfExpired(session: AgentSession, deadline: number): void {
    if (this.now() >= deadline) this.throwTimeout(session);
  }

  private throwTimeout(session: AgentSession): never {
    this.logTimeout(session);
    throw this.timeoutError(session);
  }

  private timeoutError(session: AgentSession): AgentRuntimeError {
    return new AgentRuntimeError(
      "timeout",
      `opencode sdk execute timed out after ${session.timeoutMs}ms`,
      { sessionId: session.id },
    );
  }

  private logTimeout(session: AgentSession): void {
    this.logger?.warn("agent sdk execute timeout", {
      event: "agent_sdk_execute_timeout",
      sessionId: session.id,
      reviewId: session.reviewId,
      timeoutMs: session.timeoutMs,
    });
  }

  private async collectOutput(
    host: SdkHost,
    sdkSessionId: string,
  ): Promise<{ text: string; usage?: NormalizedUsage }> {
    let messages: SdkMessage[];
    try {
      const response = await host.message.list({ sessionID: sdkSessionId, order: "asc" });
      messages = Array.isArray(response) ? response : (response.data ?? []);
    } catch (cause) {
      throw new AgentRuntimeError("crash", "failed to read opencode sdk messages", {
        detail: this.safeDetail(cause),
        cause,
      });
    }

    const texts: string[] = [];
    let usage: NormalizedUsage | undefined;
    for (const message of messages) {
      usage = mergeUsage(usage, normalizeUsage(message.usage ?? message.tokens));
      if (message.type !== "assistant" || !Array.isArray(message.content)) continue;
      for (const part of message.content) {
        usage = mergeUsage(usage, normalizeUsage(part.usage ?? part.tokens));
        if (part.type === "text" && typeof part.text === "string") texts.push(part.text);
      }
    }
    return { text: texts.join("\n\n").trim(), usage };
  }

  private async assertWorkspaceUnchanged(
    state: SessionState,
    baseline: string | undefined,
  ): Promise<void> {
    if (baseline === undefined) return; // git unavailable — guard skipped
    const after = await this.gitStatusImpl(state.session.workspacePath);
    if (after === undefined || after === baseline) return;
    throw new AgentRuntimeError(
      "workspace_modified",
      "agent modified the review workspace; permission enforcement gap detected",
      {
        sessionId: state.session.id,
        detail: truncate(this.scrub(after), MAX_DETAIL_LENGTH),
      },
    );
  }

  private async closeHost(state: SessionState): Promise<void> {
    const host = state.host;
    state.host = undefined;
    state.sdkSessionId = undefined;
    if (!host) return;
    try {
      await host.close();
    } catch (cause) {
      this.logger?.debug("agent sdk host close failed", {
        event: "agent_sdk_host_close_failed",
        sessionId: state.session.id,
        reviewId: state.session.reviewId,
        detail: this.safeDetail(cause),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Secret hygiene
  // -------------------------------------------------------------------------

  private logSdkEntry(session: AgentSession, entry: SdkLogEntry): void {
    const message =
      typeof entry.message === "string" ? entry.message : String(entry.message ?? "");
    this.logger?.debug("agent sdk host log", {
      event: "agent_sdk_host_log",
      sessionId: session.id,
      reviewId: session.reviewId,
      level: typeof entry.level === "string" ? entry.level : undefined,
      message: message ? truncate(this.scrub(message), MAX_DETAIL_LENGTH) : undefined,
      cause: entry.cause ? this.safeDetail(entry.cause) : undefined,
    });
  }

  /** Scrub known secret values and authorization headers, then truncate. */
  private safeDetail(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    let raw: string;
    if (typeof value === "string") raw = value;
    else if (value instanceof Error) raw = value.message;
    else {
      try {
        raw = JSON.stringify(value);
      } catch {
        raw = String(value);
      }
    }
    if (!raw) return undefined;
    return truncate(this.scrub(raw), MAX_DETAIL_LENGTH);
  }

  private scrub(text: string): string {
    let out = text;
    const apiKey = process.env[this.config.provider.apiKeyEnv];
    if (apiKey) out = out.split(apiKey).join("[redacted]");
    const langfuseSecret = process.env.LANGFUSE_SECRET_KEY;
    if (langfuseSecret) out = out.split(langfuseSecret).join("[redacted]");
    out = out.replace(/(authorization|api[-_]?key|x-api-key)["'=:\s]+\S+/gi, "$1[redacted]");
    return out;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build the SDK runtime explicitly. Production callers should prefer the
 * flag-aware `createAgentRuntime` factory (`./factory.js`).
 */
export function createSdkAgentRuntime(
  config: AgentRuntimeConfigSource,
  options: SdkRuntimeOptions = {},
): AgentRuntime {
  return new OpenCodeSdkAgentRuntime(config, options);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sessionDirKey(sessionId: string, reviewId: string): string {
  const shortId = sessionId.replace(/^sess_/, "").slice(0, 8);
  const safeReviewId = reviewId.replace(/[^A-Za-z0-9._-]/g, "_");
  return `${safeReviewId}-${shortId}`;
}

function isUnsupportedNode(): boolean {
  return Number(process.versions.node.split(".")[0]) < REQUIRED_NODE_MAJOR;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…[truncated]`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}

function numberOrUndefined(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function normalizeUsage(value: unknown): NormalizedUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  const inner =
    obj.usage && typeof obj.usage === "object"
      ? (obj.usage as Record<string, unknown>)
      : obj;
  const inputTokens = numberOrUndefined(inner.input, inner.inputTokens);
  const outputTokens = numberOrUndefined(inner.output, inner.outputTokens);
  const reasoningTokens = numberOrUndefined(inner.reasoning, inner.reasoningTokens);
  if (inputTokens === undefined && outputTokens === undefined && reasoningTokens === undefined) {
    return undefined;
  }
  return { inputTokens, outputTokens, reasoningTokens };
}

function mergeUsage(
  current: NormalizedUsage | undefined,
  next: NormalizedUsage | undefined,
): NormalizedUsage | undefined {
  if (!next) return current;
  if (!current) return next;
  return {
    inputTokens: next.inputTokens ?? current.inputTokens,
    outputTokens: next.outputTokens ?? current.outputTokens,
    reasoningTokens: next.reasoningTokens ?? current.reasoningTokens,
  };
}

/** Resolve the installed SDK version without importing it at build time. */
function resolveSdkVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("@opencode/sdk/package.json") as { version?: unknown };
    if (typeof pkg.version === "string") return pkg.version;
  } catch {
    // Fall through to entry-point traversal.
  }
  try {
    const require = createRequire(import.meta.url);
    let dir = path.dirname(require.resolve("@opencode/sdk"));
    for (let i = 0; i < 6; i += 1) {
      const candidate = path.join(dir, "package.json");
      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, "utf8")) as {
          name?: unknown;
          version?: unknown;
        };
        if (pkg.name === "@opencode/sdk" && typeof pkg.version === "string") {
          return pkg.version;
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Unknown version is acceptable; health is still healthy once import works.
  }
  return "unknown";
}

/**
 * Snapshot the workspace with `git status --porcelain`. Returns undefined when
 * git is missing or the directory is not a work tree, matching the CLI adapter
 * (the integrity guard is then skipped).
 */
async function defaultGitStatus(workspacePath: string): Promise<string | undefined> {
  return await new Promise<string | undefined>((resolve) => {
    let settled = false;
    const done = (value: string | undefined) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    let child: import("node:child_process").ChildProcess;
    try {
      child = execFile(
        "git",
        ["status", "--porcelain"],
        { cwd: workspacePath, maxBuffer: 10 * 1024 * 1024 },
        (error, stdout) => {
          done(error ? undefined : stdout.split("\n").filter(Boolean).sort().join("\n"));
        },
      );
    } catch {
      done(undefined);
      return;
    }
    child.once("error", () => done(undefined));
    setTimeout(() => {
      if (!settled) {
        child.kill("SIGKILL");
        done(undefined);
      }
    }, 5_000).unref();
  });
}
