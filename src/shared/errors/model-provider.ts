import { AppError } from "./app-error.js";

/**
 * Normalized model-provider failures (ARCHITECTURE.md §9.2, §12.4).
 *
 * The provider contract lives in `src/ports/model-provider.ts`; this class is
 * the shared failure vocabulary for every adapter and caller. It extends
 * `AppError` so the HTTP/queue/outbox classifiers see it as part of the single
 * application error family while keeping the provider taxonomy untouched.
 */

export type ModelErrorCode =
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

/** Codes a retry can plausibly fix; every other code is terminal. */
const RETRYABLE_CODES: ReadonlySet<ModelErrorCode> = new Set<ModelErrorCode>([
  "rate_limit",
  "network",
  "provider_unavailable",
]);

export interface ModelProviderErrorOptions {
  statusCode?: number;
  /** False for errors that a retry cannot plausibly fix. */
  retryable?: boolean;
  /** Provider-supplied message, truncated and secret-free. */
  providerDetail?: string;
  cause?: unknown;
}

export class ModelProviderError extends AppError {
  declare readonly code: ModelErrorCode;
  /** Provider-supplied message, truncated and secret-free. */
  readonly providerDetail?: string;

  constructor(code: ModelErrorCode, message: string, options: ModelProviderErrorOptions = {}) {
    const retryable = options.retryable ?? RETRYABLE_CODES.has(code);
    super(message, {
      code,
      statusCode: options.statusCode ?? modelProviderStatusCode(code),
      retryable,
      retryableReason:
        options.retryable === undefined
          ? undefined
          : `Provider adapter classified ${code} as ${retryable ? "retryable" : "non-retryable"}`,
      cause: options.cause,
    });
    this.providerDetail = options.providerDetail;
  }
}

/**
 * Aligns with `ProviderError` (the shared HTTP-facing provider failure):
 * availability failures are 503, every other upstream failure is 502. An
 * explicit upstream status always wins.
 *
 * A provider-level timeout stays 502: the request reached an upstream endpoint
 * that did not answer in time. The agent-runtime timeout uses 504 instead
 * because the runtime is the execution gateway rather than the provider
 * endpoint. Neither status is projected to HTTP today; they exist for the
 * shared error family.
 */
function modelProviderStatusCode(code: ModelErrorCode): number {
  switch (code) {
    case "rate_limit":
    case "provider_unavailable":
      return 503;
    default:
      return 502;
  }
}
