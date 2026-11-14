import { ERROR_CODES } from "../../contracts/errors.js";
import { AppError } from "./app-error.js";

/**
 * Shared subclasses for the common failure categories.
 *
 * Each class supplies a default status code and retryability. Domain errors
 * extend the closest subclass and add their own stable code through the
 * `code` option rather than inventing a parallel error hierarchy.
 */

export interface AppErrorSubclassOptions {
  /** Override the class default with a domain-specific stable code. */
  code?: string;
  /** Safe, JSON-serializable details for an envelope. */
  details?: unknown;
  /** Original error; kept for logs, never for envelopes. */
  cause?: unknown;
}

export class ValidationError extends AppError {
  constructor(message: string, options: AppErrorSubclassOptions = {}) {
    super(message, {
      code: options.code ?? ERROR_CODES.VALIDATION_ERROR,
      statusCode: 400,
      retryable: false,
      details: options.details,
      cause: options.cause,
    });
  }
}

export class AuthError extends AppError {
  constructor(message: string, options: AppErrorSubclassOptions = {}) {
    super(message, {
      code: options.code ?? ERROR_CODES.UNAUTHORIZED,
      statusCode: 401,
      retryable: false,
      details: options.details,
      cause: options.cause,
    });
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string, options: AppErrorSubclassOptions = {}) {
    super(message, {
      code: options.code ?? ERROR_CODES.FORBIDDEN,
      statusCode: 403,
      retryable: false,
      details: options.details,
      cause: options.cause,
    });
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, options: AppErrorSubclassOptions = {}) {
    super(message, {
      code: options.code ?? ERROR_CODES.NOT_FOUND,
      statusCode: 404,
      retryable: false,
      details: options.details,
      cause: options.cause,
    });
  }
}

export class ConflictError extends AppError {
  constructor(message: string, options: AppErrorSubclassOptions = {}) {
    super(message, {
      code: options.code ?? ERROR_CODES.CONFLICT,
      statusCode: 409,
      retryable: false,
      details: options.details,
      cause: options.cause,
    });
  }
}

export class RateLimitError extends AppError {
  constructor(message: string, options: AppErrorSubclassOptions = {}) {
    super(message, {
      code: options.code ?? ERROR_CODES.RATE_LIMITED,
      statusCode: 429,
      retryable: true,
      details: options.details,
      cause: options.cause,
    });
  }
}

/** Retryability override must be paired with an explicit reason. */
type RetryOverride =
  { retryable?: undefined; retryableReason?: undefined } | { retryable: boolean; retryableReason: string };

export type InternalErrorOptions = AppErrorSubclassOptions & RetryOverride;

export class InternalError extends AppError {
  constructor(message: string, options: InternalErrorOptions = {}) {
    super(message, {
      code: options.code ?? ERROR_CODES.INTERNAL_ERROR,
      statusCode: 500,
      retryable: options.retryable ?? false,
      retryableReason: options.retryableReason,
      details: options.details,
      cause: options.cause,
    });
  }
}

/**
 * Normalized provider failure codes. Mirrors `ModelErrorCode` so the model
 * adapter can migrate onto this class without remapping its taxonomy.
 */
export type ProviderFailureCode =
  | "auth_failure"
  | "rate_limit"
  | "timeout"
  | "network"
  | "provider_unavailable"
  | "invalid_request"
  | "invalid_json"
  | "unexpected_format"
  | "missing_usage"
  | "unknown";

export type ProviderErrorOptions = {
  /** Upstream 5xx status; an explicit 5xx makes the failure retryable. */
  statusCode?: number;
  /** Safe, JSON-serializable details for an envelope. */
  details?: unknown;
  /** Original error; kept for logs, never for envelopes. */
  cause?: unknown;
} & RetryOverride;

/**
 * Provider/upstream failure. Defaults to 502 Bad Gateway, or 503 Service
 * Unavailable for transient availability failures.
 *
 * Only rate-limit, network, provider-unavailable, and explicit 5xx failures
 * are retryable by default. Any other override requires an explicit reason.
 */
export class ProviderError extends AppError {
  readonly providerCode: ProviderFailureCode;

  constructor(providerCode: ProviderFailureCode, message: string, options: ProviderErrorOptions = {}) {
    const explicitStatus = options.statusCode;
    const statusCode = explicitStatus ?? defaultProviderStatusCode(providerCode);
    const retryable = options.retryable ?? isProviderFailureRetryable(providerCode, explicitStatus);

    super(message, {
      code: ERROR_CODES.PROVIDER_ERROR,
      statusCode,
      retryable,
      retryableReason: options.retryableReason,
      details: options.details ?? { providerCode },
      cause: options.cause,
    });
    this.providerCode = providerCode;
  }
}

function defaultProviderStatusCode(providerCode: ProviderFailureCode): number {
  switch (providerCode) {
    case "rate_limit":
    case "provider_unavailable":
      return 503;
    default:
      return 502;
  }
}

/** Retry only rate-limit/network/provider-unavailable codes or an explicit 5xx. */
export function isProviderFailureRetryable(providerCode: ProviderFailureCode, statusCode?: number): boolean {
  if (statusCode !== undefined && statusCode >= 500 && statusCode <= 599) {
    return true;
  }
  return providerCode === "rate_limit" || providerCode === "network" || providerCode === "provider_unavailable";
}
