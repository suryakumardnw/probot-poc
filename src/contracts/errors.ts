import { z } from "zod";

/**
 * Error contract shared by HTTP, queue, and outbox boundaries.
 *
 * The HTTP envelope is `{ code, message, statusCode, details? }`. `code` is a
 * stable, uppercase identifier; `message` is developer-authored and safe for
 * clients. Stack traces, SQL, filesystem paths, identifiers, and causes never
 * belong in an envelope.
 *
 * New codes are added with the endpoint or job that produces them. The common
 * family defaults live here so the error classes and the mapper agree.
 */

export const ERROR_CODES = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  RATE_LIMITED: "RATE_LIMITED",
  PROVIDER_ERROR: "PROVIDER_ERROR",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  REVIEW_JOB_PAYLOAD_INVALID: "REVIEW_JOB_PAYLOAD_INVALID",
  OUTBOX_PAYLOAD_INVALID: "OUTBOX_PAYLOAD_INVALID",
  ADMIN_NOT_CONFIGURED: "ADMIN_NOT_CONFIGURED",
  ADMIN_INVALID_BODY: "ADMIN_INVALID_BODY",
  ADMIN_INVALID_REQUEST: "ADMIN_INVALID_REQUEST",
  ADMIN_BODY_TOO_LARGE: "ADMIN_BODY_TOO_LARGE",
  ADMIN_CSRF_FAILED: "ADMIN_CSRF_FAILED",
  ADMIN_ACCESS_DENIED: "ADMIN_ACCESS_DENIED",
  ADMIN_ROUTE_NOT_FOUND: "ADMIN_ROUTE_NOT_FOUND",
  REVIEW_NOT_FOUND: "REVIEW_NOT_FOUND",
  REVIEW_TARGET_NOT_FOUND: "REVIEW_TARGET_NOT_FOUND",
  INVALID_STATE_TRANSITION: "INVALID_STATE_TRANSITION",
  REVIEW_TYPE_DISABLED: "REVIEW_TYPE_DISABLED",
  REPOSITORY_NOT_FOUND: "REPOSITORY_NOT_FOUND",
  PULL_REQUEST_NOT_FOUND: "PULL_REQUEST_NOT_FOUND",
  CONFIG_INVALID: "CONFIG_INVALID",
  CONFIG_ROLLBACK_UNAVAILABLE: "CONFIG_ROLLBACK_UNAVAILABLE",
  CONFIG_ROLLBACK_INVALID: "CONFIG_ROLLBACK_INVALID",
  GITHUB_OAUTH_FAILED: "GITHUB_OAUTH_FAILED",
} as const;

/** The stable codes that ship with the shared error family. */
export type KnownErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** A stable error code: uppercase snake case, e.g. `REVIEW_NOT_FOUND`. */
export const errorCodeSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Z][A-Z0-9_]*$/, "must be an uppercase snake_case code");

/** Safe, JSON-serializable details for an error envelope. */
export const errorEnvelopeSchema = z.object({
  code: errorCodeSchema,
  message: z.string().min(1),
  statusCode: z.number().int().min(400).max(599),
  details: z.json().optional(),
});

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
