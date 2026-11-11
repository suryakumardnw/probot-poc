/**
 * Flag-aware agent runtime factory (docs/architecture-sdk-runtime.md §14).
 *
 * Production stays on the OpenCode CLI runtime. The experimental SDK runtime is
 * selected only when `agent.sdk.enabled === true`; the default and every
 * existing configuration keeps `opencode-cli` unchanged.
 */

import type { AgentRuntime } from "./types.js";
import type { AgentRuntimeConfigSource } from "./opencode-config.js";
import {
  OpenCodeAgentRuntime,
  type OpenCodeRuntimeOptions,
} from "./opencode-runtime.js";
import {
  OpenCodeSdkAgentRuntime,
  type SdkRuntimeOptions,
} from "./opencode-sdk-runtime.js";

export interface AgentSdkConfig {
  enabled?: boolean;
  shadowMode?: boolean;
}

/** Config shape accepted by the factory: the CLI source plus the SDK flag. */
export type AgentRuntimeFactoryConfig = AgentRuntimeConfigSource & {
  agent: AgentRuntimeConfigSource["agent"] & { sdk?: AgentSdkConfig };
};

/** Options union: CLI-specific and SDK-specific test seams are both accepted. */
export interface AgentRuntimeFactoryOptions
  extends OpenCodeRuntimeOptions,
    SdkRuntimeOptions {}

export function isSdkRuntimeEnabled(config: AgentRuntimeFactoryConfig): boolean {
  return config.agent.sdk?.enabled === true;
}

/**
 * Build the configured agent runtime behind the `AgentRuntime` abstraction.
 * With the flag absent or false this is exactly the existing CLI runtime.
 */
export function createAgentRuntime(
  config: AgentRuntimeFactoryConfig,
  options: AgentRuntimeFactoryOptions = {},
): AgentRuntime {
  if (isSdkRuntimeEnabled(config)) {
    return new OpenCodeSdkAgentRuntime(config, options);
  }
  return new OpenCodeAgentRuntime(config, options);
}
