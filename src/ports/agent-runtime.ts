/**
 * Agent runtime port (ARCHITECTURE.md §8.2–§8.4).
 *
 * The application must not depend on OpenCode-specific concepts outside the
 * runtime adapter: review logic (ticket 07) talks to agents exclusively
 * through the `AgentRuntime` interface defined here. The concrete adapters
 * (OpenCode CLI/SDK) live in `src/platform/agents/`.
 *
 * Failure semantics (§8.4): when the agent runtime or model provider is
 * unavailable the adapter throws a normalized `AgentRuntimeError` from
 * `src/shared/errors/` and the review fails immediately. There is no automatic
 * model switching and no unbounded retrying.
 */

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export interface RuntimeHealth {
  healthy: boolean;
  /** e.g. "opencode-cli 2.1.2" — never contains secrets. */
  detail?: string;
  checkedAt: string;
}

// ---------------------------------------------------------------------------
// Sessions (§8.3: one isolated session per review)
// ---------------------------------------------------------------------------

export interface AgentSessionOptions {
  /**
   * Stable correlation id (the review id). Used for logging and temp-dir
   * naming only; never passed to the model.
   */
  reviewId: string;
  /**
   * The review workspace checkout. The agent's working directory and read
   * boundary: it may read files inside this directory only.
   */
  workspacePath: string;
  /** Execution timeout per task (ms). Defaults to the runtime's configured value. */
  timeoutMs?: number;
  /**
   * Explicit token budget for agent responses (§8.3). Maps to the model's
   * output-token limit inside the runtime configuration.
   */
  maxOutputTokens?: number;
  /** Context budget metadata (§11.3 agent.context) carried for the adapter. */
  context?: {
    maxFiles?: number;
    maxRetrievalCalls?: number;
    maxInputTokens?: number;
    maxOutputTokens?: number;
  };
  /**
   * Secret-free correlation metadata for agent tracing (Langfuse trace tags).
   * Never included in the task prompt or model request.
   */
  traceCorrelation?: {
    repository?: string;
    pullRequestNumber?: number;
  };
}

export interface AgentSession {
  readonly id: string;
  readonly reviewId: string;
  readonly workspacePath: string;
  readonly createdAt: string;
  readonly timeoutMs: number;
}

// ---------------------------------------------------------------------------
// Tasks & results
// ---------------------------------------------------------------------------

export interface AgentTask {
  /**
   * Full task instruction for the agent. Repository content is untrusted
   * (§10.1): instructions embedded in repository files must never be able to
   * change the security configuration, which is applied outside the agent.
   */
  instruction: string;
  /**
   * When "json" the agent must answer with a single JSON object; the runtime
   * extracts it and (when `validate` is given) validates it.
   */
  output: "text" | "json";
  /**
   * Optional validation of parsed JSON output. Return the validated value or
   * a failure reason; a failure throws AgentRuntimeError("invalid_output").
   */
  validate?: (value: unknown) => { ok: true; value: unknown } | { ok: false; error: string };
}

export interface AgentResult {
  sessionId: string;
  /** The agent's final assistant text. */
  text: string;
  /** Parsed JSON object when `task.output` was "json". */
  json?: unknown;
  /** Validated value when `task.validate` returned ok. */
  value?: unknown;
  /** Token usage as reported by the runtime, when available. */
  usage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number };
  /** Wall-clock duration of the execute call. */
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Interface (§8.2)
// ---------------------------------------------------------------------------

export interface AgentRuntime {
  /**
   * Prepare an isolated execution environment for one review: independent
   * working directory scope, fresh configuration, no shared conversation
   * state. Does not spawn any process.
   */
  startSession(options: AgentSessionOptions): Promise<AgentSession>;

  /**
   * Run one task inside the session. Throws a normalized `AgentRuntimeError`
   * on timeout, crash, provider failure or invalid output (§8.4).
   */
  execute(session: AgentSession, task: AgentTask): Promise<AgentResult>;

  /** Stop any in-flight execution and destroy the session environment. */
  terminate(session: AgentSession): Promise<void>;

  /** Liveness probe of the runtime binary and the configured model provider. */
  healthCheck(): Promise<RuntimeHealth>;
}
