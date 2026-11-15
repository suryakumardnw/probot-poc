/**
 * Secure execution and resource isolation (ticket 11, ARCHITECTURE.md §10).
 *
 * Public API for the rest of the application (tool protocol, review engine,
 * admin tooling — and ticket 13's Docker Compose deployment):
 *
 *   const service = new ExecutionService({ prisma, execution: config.execution });
 *   const result = await service.runCommand({
 *     command: "git", args: ["log", "--oneline", "-5"],
 *     workspacePath, actor: "review-engine", reviewId,
 *   });
 *
 * Every command — allowed, denied, or failed — is validated by the policy
 * engine OUTSIDE the agent and audited in `command_execution_audits`.
 */

export { ExecutionService, type ExecutionServiceOptions } from "./service.js";
export {
  DockerSandboxExecutor,
  DEFAULT_SANDBOX_IMAGE,
  SANDBOX_USER,
  type DockerExecutorOptions,
} from "./docker-executor.js";
export { LocalSandboxExecutor, LOCAL_MAX_OUTPUT_BYTES, assertNoSecretsInAllowlistEnv } from "./local-executor.js";
export { evaluateCommand, buildEffectivePolicy, type EvaluateOptions } from "./policy.js";
export { buildExecutionEnv, EXECUTION_ENV_ALLOWLIST, FORBIDDEN_EXECUTION_ENV_VARS } from "./env.js";
export { resolveQuantity, diskUsageBytes, createDiskQuotaWatcher, type DiskQuotaWatcher } from "./limits.js";
export {
  ExecutionError,
  ExecutionPolicyError,
  type CommandRequest,
  type EffectivePolicy,
  type ExecutionDecision,
  type ExecutionMode,
  type ExecutionReason,
  type ExecutionResult,
  type NetworkMode,
  type PolicyDecision,
  type ReviewExecutionConfig,
  type SandboxExecutor,
} from "./types.js";
