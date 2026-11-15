export { AppError } from "./app-error.js";
export type { AppErrorOptions } from "./app-error.js";
export { AgentRuntimeError } from "./agent-runtime.js";
export type { AgentErrorCode, AgentRuntimeErrorOptions } from "./agent-runtime.js";
export { classifyAppFailure } from "./classify.js";
export type { FailureClassification, FailureContext, FailureDisposition } from "./classify.js";
export { ModelProviderError } from "./model-provider.js";
export type { ModelErrorCode, ModelProviderErrorOptions } from "./model-provider.js";
export { redactDetails, redactSecrets } from "./redact.js";
export {
  AuthError,
  ConflictError,
  ForbiddenError,
  InternalError,
  InvalidStateTransitionError,
  NotFoundError,
  ProviderError,
  RateLimitError,
  ValidationError,
  isProviderFailureRetryable,
} from "./subclasses.js";
export type {
  AppErrorSubclassOptions,
  InternalErrorOptions,
  ProviderErrorOptions,
  ProviderFailureCode,
} from "./subclasses.js";
