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
  buildChildEnv,
  buildPermissionRules,
  buildSessionConfig,
  resolveModelId,
  TOOL_ACTION_MAP,
  type AgentRuntimeConfigSource,
} from "./opencode-config.js";

export {
  extractJson,
  OpenCodeAgentRuntime,
  type AgentRuntimeLogger,
  type OpenCodeRuntimeOptions,
} from "./opencode-runtime.js";

export {
  createAgentRuntime,
  isSdkRuntimeEnabled,
  type AgentRuntimeFactoryConfig,
  type AgentRuntimeFactoryOptions,
  type AgentSdkConfig,
} from "./factory.js";

export {
  createSdkAgentRuntime,
  OpenCodeSdkAgentRuntime,
  type SdkRuntimeOptions,
} from "./opencode-sdk-runtime.js";

export {
  buildSdkInlineConfig,
  buildSdkPermissions,
  evaluateSdkPermission,
  SDK_MODEL_KEY,
  SDK_PROVIDER_ID,
  SDK_PROVIDER_PACKAGE,
  validateSdkPermissions,
  type SdkInlineConfigOptions,
  type SdkPermissionEffect,
  type SdkPermissionRule,
  type SdkPermissionValidation,
} from "./sdk/config.js";

export type {
  SdkCreateSessionInput,
  SdkHost,
  SdkHostOptions,
  SdkLoader,
  SdkLogEntry,
  SdkMessage,
  SdkMessageApi,
  SdkMessageListResult,
  SdkMessagePart,
  SdkModule,
  SdkPromptInput,
  SdkSessionRef,
  SdkSessionRow,
  SdkSessionsApi,
  SdkUsage,
} from "./sdk/types.js";
