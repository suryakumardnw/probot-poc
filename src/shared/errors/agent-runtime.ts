import { AppError } from "./app-error.js";

/**
 * Normalized agent-runtime failures (ARCHITECTURE.md §8.4).
 *
 * The runtime contract lives in `src/ports/agent-runtime.ts`; this class is
 * the shared failure vocabulary every adapter and caller uses, so modules can
 * branch on a stable code without importing a concrete runtime. It extends
 * `AppError` so the HTTP/queue/outbox classifiers see it as part of the single
 * application error family.
 */

export type AgentErrorCode =
  | "config" // Invalid runtime configuration.
  | "spawn" // The runtime binary could not be launched.
  | "crash" // The runtime process exited abnormally.
  | "timeout" // Execution exceeded the configured timeout.
  | "provider_unavailable" // The model provider rejected or could not serve the request.
  | "invalid_output" // Missing, malformed or failed-validation structured output.
  | "permission_denied" // A mandatory tool permission blocked the task.
  | "workspace_modified" // The agent modified the review workspace (integrity guard).
  | "unknown";

/**
 * Codes whose disposition is "transient" for the queue classifier. The
 * configuration-aware policy still decides whether a retry is actually
 * allowed and for how many attempts (see `shared/retry.ts`); this only
 * preserves the pre-existing §12.4 behavior now that the class is an
 * `AppError`.
 */
const RETRYABLE_CODES: ReadonlySet<AgentErrorCode> = new Set<AgentErrorCode>([
  "spawn",
  "crash",
  "provider_unavailable",
]);

export interface AgentRuntimeErrorOptions {
  /** Secret-free detail from the runtime, truncated. */
  detail?: string;
  sessionId?: string;
  cause?: unknown;
}

export class AgentRuntimeError extends AppError {
  declare readonly code: AgentErrorCode;
  /** Secret-free detail from the runtime, truncated. */
  readonly detail?: string;
  readonly sessionId?: string;

  constructor(code: AgentErrorCode, message: string, options: AgentRuntimeErrorOptions = {}) {
    super(message, {
      code,
      statusCode: agentRuntimeStatusCode(code),
      retryable: RETRYABLE_CODES.has(code),
      cause: options.cause,
    });
    this.detail = options.detail;
    this.sessionId = options.sessionId;
  }
}

/**
 * No agent-runtime failure is projected to an HTTP response today; the status
 * is the closest safe default for the shared failure family. Timeouts and
 * provider outages are transient availability failures (504/503); everything
 * else is an internal execution failure. The model-provider taxonomy differs
 * deliberately: a provider-level timeout is 502, because it is an upstream
 * request failure, not the gateway deadline represented by an agent timeout.
 */
function agentRuntimeStatusCode(code: AgentErrorCode): number {
  switch (code) {
    case "timeout":
      return 504;
    case "provider_unavailable":
      return 503;
    default:
      return 500;
  }
}
