import { ERROR_CODES, errorEnvelopeSchema, type ErrorEnvelope } from "../../contracts/errors.js";
import { AppError } from "./app-error.js";
import { classifyAppFailure, type FailureContext, type FailureDisposition } from "./classify.js";
import { redactDetails, redactSecrets } from "./redact.js";

/**
 * HTTP and log projections for the shared error family.
 *
 * Both projections are deliberately allow-list based: only the stable code, a
 * safe message, the status, and safe details cross the boundary. Stack traces,
 * causes, SQL, and filesystem paths never do. The retry/fail decision comes
 * from `classifyAppFailure`; this module does not re-implement it.
 *
 * Defense in depth:
 * - 4xx messages and details pass through the redactors before serialization.
 * - 5xx envelopes collapse to the generic internal response, so a caller's SQL,
 *   path, or token cannot escape even if it is embedded in the message.
 * - Log payloads redact messages/details for 4xx and suppress both for 5xx;
 *   cause and stack are never logged.
 */

export interface HttpErrorEnvelope {
  statusCode: number;
  body: ErrorEnvelope;
}

export interface ErrorLogPayload {
  code: string;
  message: string;
  statusCode: number;
  retryable: boolean;
  disposition: FailureDisposition;
  reason: string;
  details?: unknown;
}

export function toHttpEnvelope(error: unknown): HttpErrorEnvelope {
  if (error instanceof AppError) {
    // Never expose caller-controlled 5xx text: it can carry SQL, paths, or
    // credentials even when the error code itself is stable.
    if (error.statusCode >= 500) {
      return internalEnvelope();
    }

    const classification = classifyAppFailure(error, "http");
    const body = safeEnvelope(
      redactSecrets(classification.code),
      redactSecrets(error.message),
      error.statusCode,
      redactDetails(error.details),
    );
    if (body !== undefined) {
      return { statusCode: body.statusCode, body };
    }
  }

  // Unknown errors and invalid envelopes never expose their message.
  return internalEnvelope();
}

export function toErrorLogPayload(error: unknown, context: FailureContext = "http"): ErrorLogPayload {
  if (!(error instanceof AppError)) {
    return internalLogPayload(context);
  }

  const classification = classifyAppFailure(error, context);
  const code = redactSecrets(classification.code);

  // 5xx messages/details can carry SQL, paths, or credentials. Keep the log
  // useful through code/status/retryability only, and suppress caller reasons.
  if (error.statusCode >= 500) {
    return {
      code,
      message: "Internal server error",
      statusCode: error.statusCode,
      retryable: error.retryable,
      disposition: classification.disposition,
      reason: `${code} failed with HTTP ${error.statusCode}; message and details suppressed`,
    };
  }

  const payload: ErrorLogPayload = {
    code,
    message: redactSecrets(error.message),
    statusCode: error.statusCode,
    retryable: error.retryable,
    disposition: classification.disposition,
    reason: redactSecrets(classification.reason),
  };
  if (error.details !== undefined) {
    payload.details = redactDetails(error.details);
  }
  return payload;
}

function safeEnvelope(code: string, message: string, statusCode: number, details: unknown): ErrorEnvelope | undefined {
  const withDetails: Record<string, unknown> = { code, message, statusCode };
  if (details !== undefined) {
    withDetails.details = details;
  }

  const parsedWithDetails = errorEnvelopeSchema.safeParse(withDetails);
  if (parsedWithDetails.success) {
    return parsedWithDetails.data;
  }

  // Preserve the original 4xx status/code when only the details are invalid.
  if (details !== undefined) {
    const parsedWithoutDetails = errorEnvelopeSchema.safeParse({ code, message, statusCode });
    if (parsedWithoutDetails.success) {
      return parsedWithoutDetails.data;
    }
  }

  return undefined;
}

function internalEnvelope(): HttpErrorEnvelope {
  return {
    statusCode: 500,
    body: {
      code: ERROR_CODES.INTERNAL_ERROR,
      message: "Internal server error",
      statusCode: 500,
    },
  };
}

function internalLogPayload(context: FailureContext): ErrorLogPayload {
  const classification = classifyAppFailure(undefined, context);
  return {
    code: classification.code,
    message: "Internal server error",
    statusCode: 500,
    retryable: false,
    disposition: classification.disposition,
    reason: classification.reason,
  };
}
