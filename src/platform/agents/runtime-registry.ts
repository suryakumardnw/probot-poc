/**
 * Runtime plugin registry (Task 5).
 *
 * `createAgentRuntime` is the single entry point application code uses to
 * build the configured `AgentRuntime`. Adapters are discovered through a
 * plugin registry keyed by runtime type rather than hard-coded in a factory:
 *
 * - The built-in `opencode` plugin registers `opencode-cli` and `opencode-sdk`.
 * - `agent.runtime.type` defaults to `opencode-cli`; unknown or reserved types
 *   (`opencode-server`, `custom`) fail closed with `AgentRuntimeError("config")`.
 * - There is no fallback between adapters: if a type has no plugin the call
 *   throws instead of silently selecting another runtime.
 * - Registering a runtime type that is already registered throws.
 */

import type { AgentRuntime } from "../../ports/agent-runtime.js";
import { AgentRuntimeError } from "../../shared/errors/index.js";
import type { AgentRuntimeConfigSource } from "./opencode-config.js";
import { OpenCodeAgentRuntime, type OpenCodeRuntimeOptions } from "./opencode-runtime.js";
import { OpenCodeSdkAgentRuntime, type SdkRuntimeOptions } from "./opencode-sdk-runtime.js";

export type AgentRuntimeFactoryOptions = OpenCodeRuntimeOptions & SdkRuntimeOptions;

export interface AgentRuntimePlugin {
  readonly id: string;
  readonly runtimeTypes: readonly string[];
  create(runtimeType: string, config: AgentRuntimeConfigSource, options: AgentRuntimeFactoryOptions): AgentRuntime;
}

const registry = new Map<string, AgentRuntimePlugin>();

export function registerAgentRuntimePlugin(plugin: AgentRuntimePlugin): void {
  if (!plugin.id) {
    throw new Error("agent runtime plugin id is required");
  }
  for (const runtimeType of plugin.runtimeTypes) {
    if (registry.has(runtimeType)) {
      throw new Error(`agent runtime plugin already registered for type "${runtimeType}"`);
    }
  }
  for (const runtimeType of plugin.runtimeTypes) {
    registry.set(runtimeType, plugin);
  }
}

export function listAgentRuntimePlugins(): Array<{
  id: string;
  runtimeTypes: readonly string[];
}> {
  const seen = new Set<string>();
  const plugins: Array<{ id: string; runtimeTypes: readonly string[] }> = [];
  for (const plugin of registry.values()) {
    if (seen.has(plugin.id)) {
      continue;
    }
    seen.add(plugin.id);
    plugins.push({ id: plugin.id, runtimeTypes: plugin.runtimeTypes });
  }
  return plugins;
}

export const openCodeRuntimePlugin: AgentRuntimePlugin = {
  id: "opencode",
  runtimeTypes: ["opencode-cli", "opencode-sdk"],
  create(runtimeType, config, options) {
    switch (runtimeType) {
      case "opencode-cli":
        return new OpenCodeAgentRuntime(config, options);
      case "opencode-sdk":
        return new OpenCodeSdkAgentRuntime(config, options);
      default:
        throw new AgentRuntimeError("config", `opencode plugin does not implement runtime type "${runtimeType}"`);
    }
  },
};

registerAgentRuntimePlugin(openCodeRuntimePlugin);

export function createAgentRuntime(
  config: AgentRuntimeConfigSource,
  options: AgentRuntimeFactoryOptions = {},
): AgentRuntime {
  const runtimeType = config.agent.runtime.type;
  const plugin = registry.get(runtimeType);
  if (!plugin) {
    throw new AgentRuntimeError("config", `no agent runtime plugin registered for type "${runtimeType}"`);
  }
  return plugin.create(runtimeType, config, options);
}
