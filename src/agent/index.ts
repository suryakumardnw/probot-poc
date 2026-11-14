/**
 * Agent runtime module barrel (ARCHITECTURE.md §8).
 * Application code imports the abstraction from here, never the CLI adapter
 * directly, so the runtime implementation stays swappable.
 */

export {
  AgentRuntimeError,
  type AgentErrorCode,
  type AgentResult,
  type AgentRuntime,
  type AgentSession,
  type AgentSessionOptions,
  type AgentTask,
  type RuntimeHealth,
} from "./types.js";

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
