import { ERROR_CODES } from "../../contracts/errors.js";
import { AppError } from "./app-error.js";

/**
 * The single error -> retry/fail mapping used by the HTTP mapper and the
 * queue/outbox policy.
 *
 * `http`: one request is never retried server-side, so the disposition is
 * always `fail`; the mapper uses the stable code and status.
 * `queue`/`outbox`: the error's `retryable` default decides the disposition.
 * Unknown errors (anything outside the `AppError` family) fail by default with
 * `INTERNAL_ERROR`; retrying an unclassified failure is blind.
 */

export type FailureContext = "http" | "queue" | "outbox";
export type FailureDisposition = "retry" | "fail";

export interface FailureClassification {
  disposition: FailureDisposition;
  code: string;
  reason: string;
}

const CONTEXT_DESCRIPTION: Readonly<Record<FailureContext, string>> = {
  http: "HTTP request",
  queue: "queue job",
  outbox: "outbox event",
};

export function classifyFailure(error: unknown, context: FailureContext): FailureClassification {
  if (!(error instanceof AppError)) {
    return {
      disposition: "fail",
      code: ERROR_CODES.INTERNAL_ERROR,
      reason: `Unrecognized error in ${CONTEXT_DESCRIPTION[context]}: mapped to INTERNAL_ERROR and not retried`,
    };
  }

  if (context === "http") {
    return {
      disposition: "fail",
      code: error.code,
      reason: `${error.code} maps to HTTP ${error.statusCode}; HTTP requests are not retried by the server`,
    };
  }

  const disposition: FailureDisposition = error.retryable ? "retry" : "fail";
  return {
    disposition,
    code: error.code,
    reason:
      error.retryableReason ??
      (error.retryable
        ? `${error.code} is retryable for the ${CONTEXT_DESCRIPTION[context]}`
        : `${error.code} is not retryable for the ${CONTEXT_DESCRIPTION[context]}`),
  };
}
