import { describe, expect, it } from "vitest";
import {
  createAgentRuntime,
  OpenCodeAgentRuntime,
  OpenCodeSdkAgentRuntime,
  type AgentRuntimeConfigSource,
} from "../../src/platform/agents/index.js";
import { AgentRuntimeError, AppError, ModelProviderError, type AgentErrorCode } from "../../src/shared/errors/index.js";
import { classifyQueueFailure, DEFAULT_RETRY_POLICY_CONFIG } from "../../src/shared/retry.js";

/**
 * Characterization tests for the agent/model boundary (PR 3.9).
 *
 * These pin the observable contract that must survive the move of both
 * runtimes behind `src/ports/`: runtime selection by configured type, the
 * normalized error codes, and the queue retry decisions those codes produce.
 * The behavioral assertions were run against the pre-move layout first; the
 * `AppError`/`retryable` assertions pin the new shared error base added by the
 * same PR.
 */

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

const providerRetryEnabled = {
  ...DEFAULT_RETRY_POLICY_CONFIG,
  providerUnavailable: { enabled: true },
};

function queueDecision(code: AgentErrorCode, policy = DEFAULT_RETRY_POLICY_CONFIG) {
  return classifyQueueFailure({
    error: new AgentRuntimeError(code, `runtime failure: ${code}`),
    errorCode: code,
    message: `runtime failure: ${code}`,
    policy,
  });
}

describe("agent runtime selection and error contract", () => {
  it("selects the adapter named by the configured runtime type", () => {
    expect(createAgentRuntime(baseConfig)).toBeInstanceOf(OpenCodeAgentRuntime);
    expect(
      createAgentRuntime({
        ...baseConfig,
        agent: {
          ...baseConfig.agent,
          runtime: { ...baseConfig.agent.runtime, type: "opencode-sdk" },
        },
      }),
    ).toBeInstanceOf(OpenCodeSdkAgentRuntime);
  });

  it("fails closed with the config code for an unregistered runtime type", () => {
    const error = (() => {
      try {
        createAgentRuntime({
          ...baseConfig,
          agent: {
            ...baseConfig.agent,
            runtime: { ...baseConfig.agent.runtime, type: "opencode-server" },
          },
        });
        return undefined;
      } catch (caught) {
        return caught;
      }
    })();

    expect(error).toBeInstanceOf(AgentRuntimeError);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ name: "AgentRuntimeError", code: "config", retryable: false });
  });

  it("preserves the normalized agent fields and cause", () => {
    const cause = new Error("child exited with code 1");
    const error = new AgentRuntimeError("crash", "agent runtime crashed", {
      detail: "exit code 1",
      sessionId: "session-42",
      cause,
    });

    expect(error).toMatchObject({
      name: "AgentRuntimeError",
      message: "agent runtime crashed",
      code: "crash",
      detail: "exit code 1",
      sessionId: "session-42",
      retryable: true,
    });
    expect(error).toBeInstanceOf(AppError);
    expect(error.cause).toBe(cause);
  });

  it("keeps crash and spawn retryable under the infrastructure policy", () => {
    expect(queueDecision("crash")).toMatchObject({
      failureClass: "agent_crash",
      retryable: true,
      maxAttempts: DEFAULT_RETRY_POLICY_CONFIG.infrastructure.maxAttempts,
    });
    expect(queueDecision("spawn")).toMatchObject({ failureClass: "agent_crash", retryable: true });
  });

  it("keeps provider_unavailable gated by the provider retry policy", () => {
    expect(queueDecision("provider_unavailable")).toMatchObject({
      failureClass: "model_unavailable",
      retryable: false,
    });
    expect(queueDecision("provider_unavailable", providerRetryEnabled)).toMatchObject({
      failureClass: "model_unavailable",
      retryable: true,
      maxAttempts: DEFAULT_RETRY_POLICY_CONFIG.infrastructure.maxAttempts,
    });
  });

  it("keeps timeout, invalid output, and security failures terminal", () => {
    expect(queueDecision("timeout")).toMatchObject({
      failureClass: "resource_limit_exceeded",
      retryable: false,
    });
    expect(queueDecision("invalid_output")).toMatchObject({
      failureClass: "invalid_model_output",
      retryable: false,
    });
    expect(queueDecision("permission_denied").retryable).toBe(false);
    expect(queueDecision("workspace_modified").retryable).toBe(false);
  });

  it("treats unknown agent runtime failures as terminal by code", () => {
    // Ruling: `unknown` means the runtime could not classify the failure.
    // Retrying is blind, so it is terminal regardless of the provider retry
    // setting (matching the §12.4 `unknown` row and the runtime's
    // fail-immediately policy).
    expect(queueDecision("unknown")).toMatchObject({ failureClass: "unknown", retryable: false });
    expect(queueDecision("unknown", providerRetryEnabled)).toMatchObject({
      failureClass: "unknown",
      retryable: false,
    });
  });

  it("does not fall back to message patterns for unknown AppError codes", () => {
    // Before PR 3.9 this error was outside the AppError family and the
    // classifier could retry it because "503" matched a transient message
    // pattern. Now the AppError code ("unknown") owns the disposition.
    const error = new AgentRuntimeError("unknown", "upstream returned 503 after retry");
    const decision = classifyQueueFailure({ error, message: error.message, policy: providerRetryEnabled });
    expect(decision).toMatchObject({ errorCode: "unknown", retryable: false });
    expect(decision.failureClass).toBe("github_api_transient");
  });

  it("falls back to the AppError code when no explicit errorCode is supplied", () => {
    const error = new AgentRuntimeError("crash", "agent runtime exited with code 1");
    const decision = classifyQueueFailure({ error, message: error.message });
    expect(decision).toMatchObject({
      errorCode: "crash",
      failureClass: "agent_crash",
      retryable: true,
      maxAttempts: DEFAULT_RETRY_POLICY_CONFIG.infrastructure.maxAttempts,
    });
  });
});

describe("model provider error contract", () => {
  it.each(["rate_limit", "network", "provider_unavailable"] as const)("marks %s retryable by default", (code) => {
    const error = new ModelProviderError(code, `provider failure: ${code}`);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ name: "ModelProviderError", code, retryable: true });
  });

  it.each([
    "auth_failure",
    "invalid_request",
    "invalid_json",
    "unexpected_format",
    "missing_usage",
    "unknown",
  ] as const)("marks %s non-retryable by default", (code) => {
    const error = new ModelProviderError(code, `provider failure: ${code}`);
    expect(error).toMatchObject({ code, retryable: false });
  });

  it("preserves the explicit retryability override", () => {
    const aborted = new ModelProviderError("network", "Model request aborted by the caller", {
      retryable: false,
    });
    expect(aborted.retryable).toBe(false);

    const forcedRetry = new ModelProviderError("timeout", "Retry this timeout", { retryable: true });
    expect(forcedRetry.retryable).toBe(true);
  });

  it("preserves status code, provider detail, and cause", () => {
    const cause = new Error("socket hang up");
    const error = new ModelProviderError("provider_unavailable", "Model request failed: provider unavailable", {
      statusCode: 503,
      providerDetail: "upstream overloaded",
      cause,
    });
    expect(error).toMatchObject({
      code: "provider_unavailable",
      statusCode: 503,
      providerDetail: "upstream overloaded",
    });
    expect(error.cause).toBe(cause);
  });
});
