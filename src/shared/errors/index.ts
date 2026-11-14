export { AppError } from "./app-error.js";
export type { AppErrorOptions } from "./app-error.js";
export { classifyFailure } from "./classify.js";
export type { FailureClassification, FailureContext, FailureDisposition } from "./classify.js";
export {
  AuthError,
  ConflictError,
  ForbiddenError,
  InternalError,
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
