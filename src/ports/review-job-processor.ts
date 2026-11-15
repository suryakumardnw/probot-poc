import type { ReviewJobPayload } from "../contracts/queue.js";
import type { AppError } from "../shared/errors/app-error.js";

/**
 * Review job processor port (ARCHITECTURE.md §12.4).
 *
 * The BullMQ worker adapter owns transport concerns (job ids, attempts,
 * `UnrecoverableError`); the application side owns what an attempt means.
 * Keeping the seam here lets `modules/workspace` implement processing without
 * importing BullMQ and lets `platform/queue` start a worker without importing
 * a module.
 */

/** Attempt context supplied by the queue worker (1-based). */
export interface ReviewJobAttempt {
  attempt: number;
  maxAttempts: number;
}

export interface ReviewJobProcessor {
  /** Process one attempt. Throwing keeps the queue's retry policy in charge. */
  process(jobId: string, payload: ReviewJobPayload, attempt: ReviewJobAttempt): Promise<unknown>;

  /**
   * Record a permanently invalid payload before the adapter fails the queue
   * job without consuming its retry budget.
   */
  failInvalidPayload(jobId: string, error: AppError): Promise<void>;
}
