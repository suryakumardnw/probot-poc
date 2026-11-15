/**
 * Model adapter barrel.
 *
 * Concrete OpenAI-compatible adapter factories live here. The provider
 * contract is `src/ports/model-provider.ts` and the normalized error family is
 * `src/shared/errors/`; both are re-exported for adapter consumers that used
 * this barrel before the PR 3.9 move.
 */
export { ModelProviderError } from "../../shared/errors/index.js";
export type { ModelErrorCode } from "../../shared/errors/index.js";
export { ProviderConfigError } from "./provider-config-error.js";
export type {
  ModelCapabilities,
  ModelFinishReason,
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelUsage,
  ProviderHealth,
} from "../../ports/model-provider.js";
export { createModelProviderFromConfig, createOpenAICompatibleProvider } from "./openai-compatible.js";
export type { CreateModelProviderOptions, OpenAICompatibleProviderConfig } from "./openai-compatible.js";
