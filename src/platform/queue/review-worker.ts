import { UnrecoverableError, Worker } from "bullmq";
import type { Redis } from "ioredis";
import type { ReviewJobPayload } from "../../contracts/queue.js";
import type { Logger } from "../../ports/logger.js";
import type { ReviewJobProcessor } from "../../ports/review-job-processor.js";
import { AppError, UnrecoverableJobError } from "../../shared/errors/index.js";
import { parseReviewJobPayload, REVIEW_QUEUE_NAME } from "../../shared/queue-payload.js";

/**
 * BullMQ review worker adapter (ARCHITECTURE.md §12.4, §17.3).
 *
 * Owns transport concerns only: queue name, payload parsing, attempt context,
 * `UnrecoverableError`, and draining on shutdown. The application processing
 * behaviour is injected through the `ReviewJobProcessor` port, so
 * `modules/workspace` never imports BullMQ or ioredis.
 *
 * The connection is created by the composition root and configured for
 * blocking commands (`maxRetriesPerRequest: null`); it is closed separately on
 * shutdown.
 */

export interface ReviewWorkerDependencies {
  processor: ReviewJobProcessor;
  /** Concurrency from review.json `queue.concurrency`. */
  concurrency: number;
  logger: Logger;
}

export function startReviewWorker(connection: Redis, deps: ReviewWorkerDependencies): Worker<ReviewJobPayload> {
  const worker = new Worker<ReviewJobPayload>(
    REVIEW_QUEUE_NAME,
    async (job) => {
      if (!job.id) {
        throw new Error("BullMQ job has no id");
      }
      let payload: ReviewJobPayload;
      try {
        payload = parseReviewJobPayload(job.data);
      } catch (error) {
        if (!(error instanceof AppError)) {
          throw error;
        }
        deps.logger.error(
          { jobId: job.id, code: error.code, details: error.details },
          "Review job payload invalid; failing permanently",
        );
        await deps.processor.failInvalidPayload(job.id, error);
        // Permanent: do not consume the configured retry budget on a payload
        // that cannot become valid between attempts.
        throw new UnrecoverableError(`${error.code}: ${error.message}`);
      }
      // BullMQ supplies the retry context: attemptsMade is the count of failed
      // attempts so far, so the current attempt is attemptsMade + 1.
      try {
        return await deps.processor.process(job.id, payload, {
          attempt: job.attemptsMade + 1,
          maxAttempts: job.opts.attempts ?? 1,
        });
      } catch (error) {
        // The application signals a permanent failure without importing the
        // vendor; translate it into the class BullMQ uses to skip retries.
        if (error instanceof UnrecoverableJobError) {
          throw new UnrecoverableError(error.message);
        }
        throw error;
      }
    },
    { connection, concurrency: deps.concurrency },
  );
  return worker;
}

/**
 * Stop accepting new jobs and wait for in-flight work to finish.
 *
 * `close()` (without `force`) drains active jobs: a processor that is still
 * running is awaited, not abandoned. When the global shutdown deadline fires
 * first, the process exits without acknowledging the active job; BullMQ's
 * stalled-job recovery then makes it available again and reconciliation backs
 * that up from Postgres.
 */
export async function stopReviewWorker(worker: Worker<ReviewJobPayload>): Promise<void> {
  await worker.close(false);
}
