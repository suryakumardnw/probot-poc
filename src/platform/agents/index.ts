/**
 * Agent runtime adapters (ARCHITECTURE.md §8).
 *
 * Composition roots and tooling construct the concrete OpenCode adapters from
 * here. Application modules depend only on the `AgentRuntime` port
 * (`src/ports/agent-runtime.ts`) and the shared `AgentRuntimeError`
 * (`src/shared/errors/`), so the runtime implementation stays swappable.
 */

export { AgentRuntimeError } from "../../shared/errors/index.js";
export type { AgentErrorCode } from "../../shared/errors/index.js";
export type {
  AgentResult,
  AgentRuntime,
  AgentSession,
  AgentSessionOptions,
  AgentTask,
  RuntimeHealth,
} from "../../ports/agent-runtime.js";

export {
  buildAgentTracingPlugin,
  buildChildEnv,
  buildPermissionRules,
  buildSessionConfig,
  resolveModelId,
  TOOL_ACTION_MAP,
  type AgentRuntimeConfigSource,
  type AgentTracingInput,
} from "./opencode-config.js";

export {
  buildPrompt,
  extractJson,
  OpenCodeAgentRuntime,
  type AgentRuntimeLogger,
  type OpenCodeRuntimeOptions,
} from "./opencode-runtime.js";

export {
  createAgentRuntime,
  listAgentRuntimePlugins,
  openCodeRuntimePlugin,
  registerAgentRuntimePlugin,
  type AgentRuntimeFactoryOptions,
  type AgentRuntimePlugin,
} from "./runtime-registry.js";

export { createSdkAgentRuntime, OpenCodeSdkAgentRuntime, type SdkRuntimeOptions } from "./opencode-sdk-runtime.js";
