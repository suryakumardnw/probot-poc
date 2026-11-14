/**
 * OpenCode SDK agent runtime adapter (Task 4).
 *
 * Implements the existing `AgentRuntime` contract on top of the isolated SDK
 * host process: every session spawns the child through `SdkHostClient` (Task 3)
 * with `buildChildEnv` plus per-session XDG directories. The adapter never
 * creates the SDK host in-process.
 *
 * Key facts carried over from the Phase 2a spike:
 * - The host is built from inline configuration (`configContent`) with a
 *   per-session database and `models.fetch = false`.
 * - Completion is detected by polling `getSession(...).time.idle`; the event
 *   stream is not reliable enough to drive completion.
 * - Cleanup is an explicit `client.close()` in a `try/finally` plus `kill()`,
 *   never `await using`.
 * - Fail closed: there is no fallback to the CLI runtime.
 */

import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentRuntimeConfigSource } from "./opencode-config.js";
import { buildChildEnv } from "./opencode-config.js";
import { buildPrompt, extractJson, type AgentRuntimeLogger } from "./opencode-runtime.js";
import { createStdioSdkHostClient, probeSdkHost, type SdkHostClient, type SdkHostClientOptions } from "./sdk/client.js";
import { buildSdkInlineConfig, SDK_MODEL_KEY, SDK_PROVIDER_ID } from "./sdk/config.js";
import type { SdkMessage, SdkSessionRow } from "./sdk/types.js";
import {
  AgentRuntimeError,
  type AgentResult,
  type AgentRuntime,
  type AgentSession,
  type AgentSessionOptions,
  type AgentTask,
  type RuntimeHealth,
} from "./types.js";

const MAX_DETAIL_LENGTH = 4_000;
const MAX_LOG_LINE_CHARS = 500;
const DEFAULT_POLL_INTERVAL_MS = 250;
const SESSION_ROOT = "opencode-sdk-sessions";
const REQUIRED_NODE_MAJOR = 24;

type ProbeSdkHost = (options: {
  env: NodeJS.ProcessEnv;
  hostProcessPath: string;
  spawnImpl?: typeof spawn;
  requestTimeoutMs?: number;
}) => Promise<{ version: string }>;

export interface SdkRuntimeOptions {
  logger?: AgentRuntimeLogger;
  /** Client factory override (tests inject a fake client). */
  createHostClient?: (options: SdkHostClientOptions) => SdkHostClient;
  /** Liveness probe override (tests inject a fake probe). */
  probeSdkHost?: ProbeSdkHost;
  /** Node major version (test seam for the Node >= 24 check). */
  nodeMajorVersion?: () => number;
  /** Absolute path to the host process entry point. */
  hostProcessPath?: string;
  /** Spawn implementation forwarded to the client and the probe. */
  spawnImpl?: typeof spawn;
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
}

interface SessionState {
  options: AgentSessionOptions;
  session: AgentSession;
  dir: string;
  client?: SdkHostClient;
  sdkSessionId?: string;
  terminated: boolean;
}

type NormalizedUsage = { inputTokens?: number; outputTokens?: number; reasoningTokens?: number };

export class OpenCodeSdkAgentRuntime implements AgentRuntime {
  private readonly config: AgentRuntimeConfigSource;
  private readonly logger?: AgentRuntimeLogger;
  private readonly createHostClient: (options: SdkHostClientOptions) => SdkHostClient;
  private readonly probeSdkHost: ProbeSdkHost;
  private readonly nodeMajorVersion: () => number;
  private readonly hostProcessPath: string;
  private readonly spawnImpl: typeof spawn;
  private readonly gitStatusImpl: (workspacePath: string) => Promise<string | undefined>;
  private readonly rmImpl: (dir: string, options: { recursive: true; force: true }) => Promise<void>;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly pollIntervalMs: number;
  private readonly defaultTimeoutMs: number;
  private readonly sessions = new Map<string, SessionState>();
  private readonly terminated = new Set<string>();

  constructor(config: AgentRuntimeConfigSource, options: SdkRuntimeOptions = {}) {
    if (config.agent.runtime.type !== "opencode-sdk") {
      throw new AgentRuntimeError("config", `unsupported agent runtime type "${config.agent.runtime.type}"`);
    }
    this.config = config;
    this.logger = options.logger;
    this.createHostClient = options.createHostClient ?? createStdioSdkHostClient;
    this.probeSdkHost = options.probeSdkHost ?? probeSdkHost;
    this.nodeMajorVersion = options.nodeMajorVersion ?? (() => Number(process.versions.node.split(".")[0]));
    this.hostProcessPath = options.hostProcessPath ?? fileURLToPath(new URL("./sdk/host-process.js", import.meta.url));
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.gitStatusImpl = options.gitStatusImpl ?? defaultGitStatus;
    this.rmImpl = options.rmImpl ?? rm;
    this.sleepImpl = options.sleepImpl ?? sleep;
    this.now = options.now ?? Date.now;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? config.agent.runtime.timeoutMs;
  }

  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------

  async startSession(options: AgentSessionOptions): Promise<AgentSession> {
    const id = `sess_${randomUUID()}`;
    const dir = path.join(os.tmpdir(), SESSION_ROOT, sessionDirKey(id, options.reviewId));
    await mkdir(dir, { recursive: true });
    await mkdir(path.join(dir, "config"), { recursive: true });
    await mkdir(path.join(dir, "data"), { recursive: true });
    await mkdir(path.join(dir, "state"), { recursive: true });

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

    // Contract: startSession must not spawn. The host/client is created lazily
    // on the first execute().
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

    // The timeout bounds the ENTIRE execute lifecycle: host start, SDK session
    // creation, prompt admission, idle polling and message read. Polling alone
    // is not enough (a hung host/prompt/get would otherwise escape the
    // deadline). On the deadline, kill the client and reject "timeout" without
    // awaiting a close that might itself hang.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const totalTimeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => {
          timedOut = true;
          this.logTimeout(session);
          this.killClient(state);
          void this.closeClient(state);
          reject(this.timeoutError(session));
        },
        Math.max(0, session.timeoutMs),
      );
      timer.unref?.();
    });
    // A late loser must never surface as an unhandled rejection.
    totalTimeout.catch(() => {});

    try {
      const result = await Promise.race([this.runExecute(state, task, startedAt, deadline), totalTimeout]);
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
        detail: normalized.detail ? truncate(this.scrub(normalized.detail), MAX_DETAIL_LENGTH) : undefined,
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

    const client = state.client;
    const sdkSessionId = state.sdkSessionId;
    state.client = undefined;
    state.sdkSessionId = undefined;

    if (client) {
      try {
        if (sdkSessionId) await client.removeSession({ sessionID: sdkSessionId });
      } catch (cause) {
        this.logger?.warn("agent sdk session remove failed", {
          event: "agent_sdk_session_remove_failed",
          sessionId: session.id,
          reviewId: session.reviewId,
          detail: this.safeDetail(cause),
        });
      }
      try {
        await client.close();
      } catch (cause) {
        this.logger?.warn("agent sdk host close failed", {
          event: "agent_sdk_host_close_failed",
          sessionId: session.id,
          reviewId: session.reviewId,
          detail: this.safeDetail(cause),
        });
      }
      client.kill();
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
    if (this.nodeMajorVersion() < REQUIRED_NODE_MAJOR) {
      return {
        healthy: false,
        detail: `opencode-sdk requires Node >= ${REQUIRED_NODE_MAJOR}`,
        checkedAt,
      };
    }
    try {
      const { version } = await this.probeSdkHost({
        env: buildChildEnv(this.config, process.env),
        hostProcessPath: this.hostProcessPath,
        ...(this.spawnImpl ? { spawnImpl: this.spawnImpl } : {}),
      });
      return { healthy: true, detail: `opencode-sdk ${version}`, checkedAt };
    } catch (cause) {
      const reason = this.safeDetail(cause);
      return {
        healthy: false,
        detail: `opencode-sdk unavailable: ${reason ? truncate(reason, MAX_DETAIL_LENGTH) : "probe failed"}`,
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

    const client = await this.ensureHost(state);
    this.throwIfExpired(session, deadline);
    const sdkSessionId = await this.ensureSdkSession(state, client);
    this.throwIfExpired(session, deadline);

    const promptStarted = this.now();
    try {
      await client.prompt({ sessionID: sdkSessionId, text: buildPrompt(task) });
    } catch (cause) {
      if (this.now() >= deadline) this.throwTimeout(session);
      throw new AgentRuntimeError("crash", "opencode sdk prompt admission failed", {
        sessionId: session.id,
        detail: this.safeDetail(cause),
        cause,
      });
    }

    const finalRow = await this.waitForIdle(state, client, sdkSessionId, promptStarted, deadline);
    if (finalRow.outcome === "failed") {
      throw new AgentRuntimeError("provider_unavailable", "opencode sdk session finished with outcome=failed", {
        sessionId: session.id,
        detail: this.safeDetail(finalRow),
      });
    }

    this.throwIfExpired(session, deadline);
    const { text, textMessages, usage } = await this.collectOutput(state, client, sdkSessionId);
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
      // Try the newest assistant message first, then fall back to earlier
      // steps. This recovers the scenario where a step was cut off at the
      // output cap and the host immediately ran a second step that produced
      // the complete answer — matching the CLI adapter's behavior.
      const candidates = [...textMessages].reverse().filter((m) => m.trim().length > 0);
      let parseFailure: string | undefined;
      let validationFailure: string | undefined;
      let chosen: { text: string; value: unknown } | undefined;

      for (const candidate of candidates) {
        const extracted = extractJson(candidate);
        if (extracted === undefined) continue;
        let value: unknown;
        try {
          value = JSON.parse(extracted);
        } catch {
          parseFailure = extracted;
          continue;
        }
        if (task.validate) {
          const verdict = task.validate(value);
          if (!verdict.ok) {
            validationFailure = verdict.error;
            continue;
          }
          result.value = verdict.value;
        }
        chosen = { text: candidate, value };
        break;
      }

      if (!chosen) {
        if (validationFailure !== undefined) {
          throw new AgentRuntimeError("invalid_output", "agent output failed validation", {
            sessionId: session.id,
            detail: truncate(validationFailure, MAX_DETAIL_LENGTH),
          });
        }
        if (parseFailure !== undefined) {
          throw new AgentRuntimeError("invalid_output", "agent JSON output failed to parse", {
            sessionId: session.id,
            detail: truncate(this.scrub(parseFailure), MAX_DETAIL_LENGTH),
          });
        }
        throw new AgentRuntimeError("invalid_output", "agent output did not contain a JSON object", {
          sessionId: session.id,
          detail: truncate(this.scrub(candidates[0] ?? text), MAX_DETAIL_LENGTH),
        });
      }
      result.text = chosen.text.trim();
      result.json = chosen.value;
    }

    await this.assertWorkspaceUnchanged(state, baseline);
    return result;
  }

  private async ensureHost(state: SessionState): Promise<SdkHostClient> {
    if (state.client) return state.client;
    const session = state.session;

    const inlineConfig = buildSdkInlineConfig(this.config, process.env, {
      maxOutputTokens: state.options.maxOutputTokens ?? this.config.agent.context.maxOutputTokens,
      reviewId: session.reviewId,
      repository: state.options.traceCorrelation?.repository,
      pullRequestNumber: state.options.traceCorrelation?.pullRequestNumber,
    });
    const env = buildChildEnv(this.config, process.env, { reviewId: session.reviewId });
    env.XDG_CONFIG_HOME = path.join(state.dir, "config");
    env.XDG_DATA_HOME = path.join(state.dir, "data");
    env.XDG_STATE_HOME = path.join(state.dir, "state");

    let client: SdkHostClient | undefined;
    try {
      client = this.createHostClient({
        configContent: JSON.stringify(inlineConfig),
        databasePath: path.join(state.dir, "opencode.db"),
        workspacePath: session.workspacePath,
        env,
        hostProcessPath: this.hostProcessPath,
        sessionId: session.id,
        reviewId: session.reviewId,
        ...(this.spawnImpl ? { spawnImpl: this.spawnImpl } : {}),
        onStderr: (line) => this.logSdkStderr(session, line),
      });
      // Register the client before awaiting start so the total-deadline timer
      // can kill a child that hangs during the create handshake.
      state.client = client;
      await client.start();
    } catch (cause) {
      // A failed start must not leave a half-registered client behind. The
      // real client may have spawned a child before its create handshake
      // timed out; kill it before dropping the only reference.
      try {
        client?.kill();
      } catch {
        /* best-effort cleanup */
      }
      state.client = undefined;
      if (cause instanceof AgentRuntimeError) {
        // Preserve the normalized code/message but scrub/truncate the detail:
        // the client can attach raw protocol lines or spawn error messages.
        throw new AgentRuntimeError(cause.code, cause.message, {
          sessionId: session.id,
          detail: this.safeDetail(cause.detail),
          cause: cause.cause,
        });
      }
      throw new AgentRuntimeError("spawn", "failed to start opencode sdk host", {
        sessionId: session.id,
        detail: this.safeDetail(cause),
        cause,
      });
    }

    if (!client) {
      throw new AgentRuntimeError("spawn", "failed to create opencode sdk host", {
        sessionId: session.id,
      });
    }
    this.logger?.info("agent sdk host created", {
      event: "agent_sdk_host_created",
      sessionId: session.id,
      reviewId: session.reviewId,
      model: `${SDK_PROVIDER_ID}/${SDK_MODEL_KEY}`,
      providerType: this.config.provider.type,
    });
    return client;
  }

  private async ensureSdkSession(state: SessionState, client: SdkHostClient): Promise<string> {
    if (state.sdkSessionId) return state.sdkSessionId;
    const session = state.session;
    try {
      const row = await client.createSession({
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
   * Poll `getSession(...).time.idle` until the turn completes. The event stream
   * can miss the idle transition, so polling is authoritative.
   */
  private async waitForIdle(
    state: SessionState,
    client: SdkHostClient,
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
        row = await client.getSession({ sessionID: sdkSessionId });
      } catch {
        row = undefined; // transient; the deadline owns the failure
      }
      if (row && typeof row.time?.idle === "number" && row.time.idle >= promptStarted) {
        return row;
      }
      if (this.now() >= deadline) {
        this.killClient(state);
        void this.closeClient(state);
        this.logTimeout(session);
        throw new AgentRuntimeError("timeout", `opencode sdk execute timed out after ${session.timeoutMs}ms`, {
          sessionId: session.id,
        });
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
    return new AgentRuntimeError("timeout", `opencode sdk execute timed out after ${session.timeoutMs}ms`, {
      sessionId: session.id,
    });
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
    state: SessionState,
    client: SdkHostClient,
    sdkSessionId: string,
  ): Promise<{ text: string; textMessages: string[]; usage?: NormalizedUsage }> {
    let messages: SdkMessage[];
    try {
      messages = await client.listMessages({ sessionID: sdkSessionId, order: "asc" });
    } catch (cause) {
      throw new AgentRuntimeError("crash", "failed to read opencode sdk messages", {
        sessionId: state.session.id,
        detail: this.safeDetail(cause),
        cause,
      });
    }

    // Group text parts per assistant message so JSON tasks can choose the
    // newest complete message instead of blindly concatenating (a truncated
    // first step followed by a complete second step would otherwise corrupt
    // the payload).
    const textMessages: string[] = [];
    let usage: NormalizedUsage | undefined;
    for (const message of messages) {
      usage = mergeUsage(usage, normalizeUsage(message.usage ?? message.tokens));
      if (message.type !== "assistant" || !Array.isArray(message.content)) continue;
      const parts: string[] = [];
      for (const part of message.content) {
        usage = mergeUsage(usage, normalizeUsage(part.usage ?? part.tokens));
        if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
      }
      if (parts.length > 0) textMessages.push(parts.join("\n\n"));
    }
    return { text: textMessages.join("\n\n").trim(), textMessages, usage };
  }

  private async assertWorkspaceUnchanged(state: SessionState, baseline: string | undefined): Promise<void> {
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

  private async closeClient(state: SessionState): Promise<void> {
    const client = state.client;
    state.client = undefined;
    state.sdkSessionId = undefined;
    if (!client) return;
    try {
      await client.close();
    } catch (cause) {
      this.logger?.debug("agent sdk host close failed", {
        event: "agent_sdk_host_close_failed",
        sessionId: state.session.id,
        reviewId: state.session.reviewId,
        detail: this.safeDetail(cause),
      });
    }
  }

  private killClient(state: SessionState): void {
    const client = state.client;
    if (!client) return;
    client.kill();
  }

  // -------------------------------------------------------------------------
  // Secret hygiene
  // -------------------------------------------------------------------------

  private logSdkStderr(session: AgentSession, line: string): void {
    this.logger?.debug("agent sdk host stderr", {
      event: "agent_sdk_host_stderr",
      sessionId: session.id,
      reviewId: session.reviewId,
      message: truncate(this.scrub(line), MAX_LOG_LINE_CHARS),
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
    const otlpHeaders = process.env.OPENCODE_OTLP_HEADERS;
    if (otlpHeaders) {
      out = out.split(otlpHeaders).join("[redacted]");
      for (const pair of otlpHeaders.split(",")) {
        const separator = pair.indexOf("=");
        if (separator < 0) continue;
        const value = pair
          .slice(separator + 1)
          .trim()
          .replace(/^bearer\s+/i, "");
        if (value.length >= 8) out = out.split(value).join("[redacted]");
      }
    }
    out = out.replace(/(authorization|api[-_]?key|x-api-key)["'=:\s]+\S+/gi, "$1[redacted]");
    return out;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build the SDK runtime explicitly. The adapter fails closed: it is only
 * selected when the runtime type is "opencode-sdk"; there is no CLI fallback.
 */
export function createSdkAgentRuntime(config: AgentRuntimeConfigSource, options: SdkRuntimeOptions = {}): AgentRuntime {
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
  const inner = obj.usage && typeof obj.usage === "object" ? (obj.usage as Record<string, unknown>) : obj;
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
