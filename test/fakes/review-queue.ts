import type { ReviewJobPayload } from "../../src/contracts/queue.js";
import type { ReviewQueue, ReviewQueueEnqueueOptions } from "../../src/ports/review-queue.js";

export interface FakeEnqueuedReview {
  payload: ReviewJobPayload;
  options: ReviewQueueEnqueueOptions;
}

/**
 * In-memory review-queue port for unit tests.
 *
 * Enqueue is synchronous from the caller's perspective (the returned id is the
 * durable job id, matching the BullMQ adapter's `jobId` option) and failure
 * injection covers enqueue/close without a Redis connection.
 */
export class FakeReviewQueue implements ReviewQueue {
  readonly enqueued: FakeEnqueuedReview[] = [];
  closeCalls = 0;
  closed = false;
  private readonly enqueueErrors: unknown[] = [];
  private readonly closeErrors: unknown[] = [];

  queueEnqueueError(error: unknown): this {
    this.enqueueErrors.push(error);
    return this;
  }

  queueCloseError(error: unknown): this {
    this.closeErrors.push(error);
    return this;
  }

  async enqueue(payload: ReviewJobPayload, options: ReviewQueueEnqueueOptions): Promise<{ id?: string }> {
    const error = this.enqueueErrors.shift();
    if (error !== undefined) {
      throw error;
    }
    this.enqueued.push({ payload, options });
    return { id: options.jobId };
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    const error = this.closeErrors.shift();
    if (error !== undefined) {
      throw error;
    }
    this.closed = true;
  }
}
