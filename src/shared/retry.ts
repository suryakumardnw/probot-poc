/**
 * Failure classification and per-class retry policy (ARCHITECTURE.md §12.4).
 *
 * Every review failure is mapped to one failure class; each class carries the
 * recommended behavior from the §12.4 table:
 *
 * | Failure class            | Behavior                                   |
 * |--------------------------|--------------------------------------------|
 * | github_api_transient     | retry                                      |
 * | redis_unavailable        | infrastructure recovery                    |
 * | postgres_unavailable     | do not publish; recover state              |
 * | clone_failure            | configurable retry                         |
 * | model_unavailable        | fail immediately                           |
 * | invalid_model_output     | validation failure                         |
 * | agent_crash              | fail or recover per infrastructure policy  |
 * | resource_limit_exceeded  | terminate and record failure               |
 * | stale_commit             | no retry (results rejected, §4.3)          |
 * | unknown                  | no retry                                   |
 */

import type { ReviewConfig } from "../contracts/config.js";
import { ERROR_CODES } from "../contracts/errors.js";
import { AppError, classifyAppFailure } from "./errors/index.js";

export type FailureClass =
  | "github_api_transient"
  | "redis_unavailable"
  | "postgres_unavailable"
  | "clone_failure"
  | "model_unavailable"
  | "invalid_model_output"
  | "agent_crash"
  | "resource_limit_exceeded"
  | "stale_commit"
  | "unknown";

export interface RetryDecision {
  /** Whether the job may be re-attempted (BullMQ retry / reconciliation). */
  retry: boolean;
  /** Max total attempts when retrying. */
  maxAttempts: number;
  backoff: "fixed" | "exponential";
  /** §12.4 postgres_unavailable: recover durable state, never publish. */
  recoverState: boolean;
  /** Human-readable rationale (logged and persisted with the failure). */
  rationale: string;
}

const NO_RETRY = (rationale: string): RetryDecision => ({
  retry: false,
  maxAttempts: 1,
  backoff: "fixed",
  recoverState: false,
  rationale,
});

/**
 * Exact `AgentRuntimeError.code` values (§8.4) mapped onto failure classes.
 * Matched exactly so generic substrings (e.g. `provider_timeout` containing
 * "timeout") keep their existing meaning below.
 */
const AGENT_ERROR_CODE_CLASS: Readonly<Record<string, FailureClass>> = {
  crash: "agent_crash",
  spawn: "agent_crash",
  timeout: "resource_limit_exceeded",
  provider_unavailable: "model_unavailable",
  invalid_output: "invalid_model_output",
};

/** Patterns used to classify errors that arrive without an error code. */
const MESSAGE_PATTERNS: ReadonlyArray<[RegExp, FailureClass]> = [
  [
    /bad ?credentials|401|unauthorized|forbidden|rate limit|secondary rate|403|502|503|504|ECONNRESET|ETIMEDOUT|ENOTFOUND/i,
    "github_api_transient",
  ],
  [/redis|ECONNREFUSED.*6379|bull/i, "redis_unavailable"],
  [/postgres|postgresql|prisma|database|5432|p1001|p2002/i, "postgres_unavailable"],
  [/clone|checkout|git (failed|error)|shallow/i, "clone_failure"],
  [/model|provider|openai|completion|llm|endpoint/i, "model_unavailable"],
  [/invalid (model )?output|schema|parse|validation/i, "invalid_model_output"],
  [/agent (crashed|died)|agent runtime (exited|crashed)|exited with code|non-zero exit|signal/i, "agent_crash"],
  [/resource limit|out of memory|disk quota|timeout.*exceeded|oom/i, "resource_limit_exceeded"],
  [/stale.*commit|head moved/i, "stale_commit"],
];

/** Map an error (optionally with a durable error code) to a failure class. */
export function classifyFailure(input: { errorCode?: string | null; message?: string | null }): FailureClass {
  const code = (input.errorCode ?? "").toLowerCase();
  const message = input.message ?? "";

  const agentClass = AGENT_ERROR_CODE_CLASS[code];
  if (agentClass) {
    return agentClass;
  }

  if (code.includes("stale_commit") || /head moved|stale.*commit/i.test(message)) {
    return "stale_commit";
  }
  if (code.includes("github") || code.includes("403") || code.includes("401") || code.includes("rate_limit")) {
    return "github_api_transient";
  }
  if (code.includes("redis") || code.includes("queue")) {
    return "redis_unavailable";
  }
  if (
    code.includes("postgres") ||
    code.includes("database") ||
    code.includes("db") ||
    code.includes("findings_persist")
  ) {
    return "postgres_unavailable";
  }
  if (code.includes("invalid_model_output") || code.includes("schema") || code.includes("validation")) {
    return "invalid_model_output";
  }
  if (code.includes("clone") || code.includes("checkout") || code.includes("retrieval")) {
    return "clone_failure";
  }
  if (code.includes("model") || code.includes("provider") || code.includes("agent_runtime")) {
    return "model_unavailable";
  }
  if (code.includes("resource") || code.includes("quota") || code.includes("timeout") || code.includes("oom")) {
    return "resource_limit_exceeded";
  }

  for (const [pattern, cls] of MESSAGE_PATTERNS) {
    if (pattern.test(message)) {
      return cls;
    }
  }
  return "unknown";
}

export interface RetryPolicyConfig {
  infrastructure: { enabled: boolean; maxAttempts: number; backoff: "fixed" | "exponential" };
  providerUnavailable: { enabled: boolean };
}

/** Default policy derived from the §11.3 review.json defaults. */
export const DEFAULT_RETRY_POLICY_CONFIG: RetryPolicyConfig = {
  infrastructure: { enabled: true, maxAttempts: 3, backoff: "exponential" },
  providerUnavailable: { enabled: false },
};

export function retryPolicyConfigFromReviewConfig(config: ReviewConfig): RetryPolicyConfig {
  return {
    infrastructure: {
      enabled: config.queue.retry.infrastructure.enabled,
      maxAttempts: config.queue.retry.infrastructure.maxAttempts,
      backoff: config.queue.retry.infrastructure.backoff,
    },
    providerUnavailable: { enabled: config.queue.retry.providerUnavailable.enabled },
  };
}

/**
 * §12.4 retry policy for a failure class. Pure: no I/O, fully unit-testable.
 */
export function retryPolicyFor(
  failureClass: FailureClass,
  policy: RetryPolicyConfig = DEFAULT_RETRY_POLICY_CONFIG,
): RetryDecision {
  const infra = policy.infrastructure;
  switch (failureClass) {
    case "github_api_transient":
      return infra.enabled
        ? {
            retry: true,
            maxAttempts: infra.maxAttempts,
            backoff: infra.backoff,
            recoverState: false,
            rationale: "GitHub API transient error: retry (§12.4)",
          }
        : NO_RETRY("GitHub API transient error but retries are disabled");
    case "redis_unavailable":
      return {
        retry: true,
        maxAttempts: infra.maxAttempts,
        backoff: infra.backoff,
        recoverState: true,
        rationale: "Redis unavailable: infrastructure recovery keeps the event durable in the outbox (§12.2/§12.4)",
      };
    case "postgres_unavailable":
      return {
        retry: true,
        maxAttempts: infra.maxAttempts,
        backoff: infra.backoff,
        recoverState: true,
        rationale: "PostgreSQL unavailable: do not publish; recover durable state (§12.4)",
      };
    case "clone_failure":
      // "Configurable retry": governed entirely by queue.retry.infrastructure.
      return infra.enabled
        ? {
            retry: true,
            maxAttempts: infra.maxAttempts,
            backoff: infra.backoff,
            recoverState: false,
            rationale: "Clone failure: configurable retry via queue.retry.infrastructure (§12.4)",
          }
        : NO_RETRY("Clone failure with retry disabled in configuration");
    case "model_unavailable":
      return policy.providerUnavailable.enabled
        ? {
            retry: true,
            maxAttempts: infra.maxAttempts,
            backoff: infra.backoff,
            recoverState: false,
            rationale: "Model unavailable: provider retries explicitly enabled in configuration",
          }
        : NO_RETRY("Model unavailable: fail immediately (§12.4)");
    case "invalid_model_output":
      return NO_RETRY("Invalid model output: validation failure, retrying cannot fix it (§12.4)");
    case "agent_crash":
      return infra.enabled
        ? {
            retry: true,
            maxAttempts: infra.maxAttempts,
            backoff: infra.backoff,
            recoverState: false,
            rationale: "Agent crash: recover per infrastructure policy (§12.4)",
          }
        : NO_RETRY("Agent crash with infrastructure recovery disabled");
    case "resource_limit_exceeded":
      return NO_RETRY("Resource limit exceeded: terminate and record failure (§12.4)");
    case "stale_commit":
      return NO_RETRY("Stale PR head: results rejected, retrying the same commit is pointless (§4.3)");
    case "unknown":
      return NO_RETRY("Unclassified failure: fail immediately rather than retry blindly");
  }
}

export interface QueueFailureDecision {
  /** §12.4 failure class (metrics and structured logs). */
  failureClass: FailureClass;
  /** Whether BullMQ may re-attempt the job. */
  retryable: boolean;
  /** Total attempt budget; `1` when the failure is terminal. */
  maxAttempts: number;
  backoff: "fixed" | "exponential";
  /** Stable code recorded on the durable failure. */
  errorCode: string;
  /** Human-readable rationale for the structured failure log. */
  reason: string;
}

/**
 * One retry decision at the worker boundary.
 *
 * Two existing classifiers are authoritative for different error families and
 * must not be re-implemented here:
 *
 *  - `classifyAppFailure` owns every `AppError` (the shared HTTP/queue/outbox
 *    family), including the normalized agent and model runtime errors: its
 *    `retryable` flag decides whether the failure may be retried.
 *  - `classifyFailure`/`retryPolicyFor` own operational errors outside that
 *    family (`ReviewRetrievalError`, unknown throws) and supply the §12.4
 *    failure class plus the configuration-driven budget. Agent runtime errors
 *    contribute both: their normalized code selects the §12.4 class and their
 *    `AppError.retryable` flag preserves the same transient disposition.
 *
 * An `AppError` is retried only when both layers agree: the error is explicitly
 * transient *and* the checked-in configuration permits an infrastructure retry.
 * Everything else is terminal, matching the "unknown internal errors are not
 * retried" rule in design §6.9.
 */
export function classifyQueueFailure(input: {
  error: unknown;
  /** Normalized code carried by non-AppError runtime/retrieval failures. */
  errorCode?: string | null;
  message: string;
  policy?: RetryPolicyConfig;
}): QueueFailureDecision {
  const policy = input.policy ?? DEFAULT_RETRY_POLICY_CONFIG;
  const appFailure = classifyAppFailure(input.error, "queue");
  const errorCode = input.errorCode ?? (input.error instanceof AppError ? appFailure.code : ERROR_CODES.INTERNAL_ERROR);
  const failureClass = classifyFailure({ errorCode, message: input.message });
  const policyDecision = retryPolicyFor(failureClass, policy);
  const retryable =
    input.error instanceof AppError ? appFailure.disposition === "retry" && policyDecision.retry : policyDecision.retry;

  return {
    failureClass,
    retryable,
    maxAttempts: retryable ? policyDecision.maxAttempts : 1,
    backoff: retryable ? policyDecision.backoff : "fixed",
    errorCode,
    reason:
      input.error instanceof AppError ? `${appFailure.reason}; ${policyDecision.rationale}` : policyDecision.rationale,
  };
}
