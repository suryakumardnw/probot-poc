import { ERROR_CODES, errorEnvelopeSchema, type ErrorEnvelope } from "../../contracts/errors.js";
import { AppError } from "../../shared/errors/app-error.js";
import { classifyFailure, type FailureContext, type FailureDisposition } from "../../shared/errors/classify.js";

/**
 * HTTP and log projections for the shared error family.
 *
 * Both projections are deliberately allow-list based: only the stable code, a
 * safe message, the status, and safe details cross the boundary. Stack traces,
 * causes, SQL, and filesystem paths never do. The retry/fail decision comes
 * from `classifyFailure`; this module does not re-implement it.
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
}

export function toHttpEnvelope(error: unknown): HttpErrorEnvelope {
  const classification = classifyFailure(error, "http");

  if (error instanceof AppError) {
    const body = safeEnvelope(classification.code, error.message, error.statusCode, error.details);
    if (body !== undefined) {
      return { statusCode: body.statusCode, body };
    }
  }

  // Unknown errors and invalid envelopes never expose their message.
  return internalEnvelope();
}

export function toErrorLogPayload(error: unknown, context: FailureContext = "http"): ErrorLogPayload {
  const classification = classifyFailure(error, context);

  if (error instanceof AppError) {
    return {
      code: classification.code,
      message: error.message,
      statusCode: error.statusCode,
      retryable: error.retryable,
      disposition: classification.disposition,
      reason: classification.reason,
    };
  }

  return {
    code: classification.code,
    message: "Internal server error",
    statusCode: 500,
    retryable: false,
    disposition: classification.disposition,
    reason: classification.reason,
  };
}

function safeEnvelope(code: string, message: string, statusCode: number, details: unknown): ErrorEnvelope | undefined {
  const candidate: Record<string, unknown> = { code, message, statusCode };
  if (details !== undefined) {
    candidate.details = details;
  }
  const parsed = errorEnvelopeSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
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
