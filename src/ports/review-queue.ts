import type { ReviewJobPayload } from "../contracts/queue.js";

/**
 * Review queue port (ARCHITECTURE.md §12.2, §12.4).
 *
 * The queue is an at-least-once transport; Postgres remains the durable source
 * of truth. Callers pass the durable `ReviewJob.id` as the job identity so a
 * repeated publish can never create a second logical job.
 *
 * BullMQ is the only adapter today (`src/ingestion/queue.ts`); the port keeps
 * module code from importing the client library before the platform move in
 * PR 3.10.
 */

export interface ReviewQueueBackoff {
  type: "exponential" | "fixed";
  delay: number;
}

export interface ReviewQueueEnqueueOptions {
  /** Durable job identity: always the ReviewJob.id. */
  jobId: string;
  /** Total attempts, including the first. `1` disables retries. */
  attempts: number;
  /** Delay strategy applied between failed attempts. */
  backoff: ReviewQueueBackoff;
  /** Keep this many completed jobs for inspection. */
  removeOnComplete?: number;
  /** Keep this many failed jobs for inspection. */
  removeOnFail?: number;
}

export interface ReviewQueue {
  enqueue(payload: ReviewJobPayload, options: ReviewQueueEnqueueOptions): Promise<{ id?: string }>;
  close(): Promise<void>;
}
