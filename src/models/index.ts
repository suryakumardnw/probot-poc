/**
 * Model provider barrel (ARCHITECTURE.md §9). Tickets 06/07 import from
 * here: `import { createModelProviderFromConfig } from "../models/index.js"`.
 */
export { ModelProviderError, ProviderConfigError } from "./provider.js";
export type {
  ModelCapabilities,
  ModelErrorCode,
  ModelFinishReason,
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelUsage,
  ProviderHealth,
} from "./provider.js";
export { createModelProviderFromConfig, createOpenAICompatibleProvider } from "./openai-compatible.js";
export type { CreateModelProviderOptions, OpenAICompatibleProviderConfig } from "./openai-compatible.js";
