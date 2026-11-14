import { ERROR_CODES } from "../../contracts/errors.js";

/**
 * One error family for HTTP and queue/outbox decisions.
 *
 * `statusCode` and `retryable` are separate axes: a failure can be a client
 * error that is never retried, or a transient failure whose HTTP status is
 * still 5xx. The classifier (see `classify.ts`) is the only place that turns
 * these fields into a retry/fail disposition.
 *
 * `details` must contain safe, JSON-serializable values only. `cause` may carry
 * the original error for logs, but it is never serialized into an HTTP
 * envelope or a structured log payload.
 */

export interface AppErrorOptions {
  /** Stable identifier; defaults to `INTERNAL_ERROR` on the base class. */
  code?: string;
  /** HTTP status default; defaults to 500 on the base class. */
  statusCode?: number;
  /** Queue/outbox retry default; defaults to false on the base class. */
  retryable?: boolean;
  /** Human-readable justification when retryability is overridden. */
  retryableReason?: string;
  /** Safe, JSON-serializable details for an envelope. */
  details?: unknown;
  /** Original error; kept for logs, never for envelopes. */
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly retryable: boolean;
  readonly retryableReason?: string;
  readonly details?: unknown;

  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code ?? ERROR_CODES.INTERNAL_ERROR;
    this.statusCode = options.statusCode ?? 500;
    this.retryable = options.retryable ?? false;
    this.retryableReason = options.retryableReason;
    this.details = options.details;
  }
}
