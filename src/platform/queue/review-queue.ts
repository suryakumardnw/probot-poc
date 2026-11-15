import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { type ReviewJobPayload } from "../../contracts/queue.js";
import type { ReviewQueue, ReviewQueueCounts, ReviewQueueEnqueueOptions } from "../../ports/review-queue.js";
import { REVIEW_QUEUE_NAME } from "../../shared/queue-payload.js";

/**
 * BullMQ review queue (ARCHITECTURE.md §4.4, §12.2).
 *
 * The queue lives in Redis; Postgres (Review/ReviewJob rows) is the durable
 * source of truth. Jobs are enqueued through the transactional outbox, so a
 * Redis outage never loses a review request — the outbox recovery loop
 * re-enqueues pending events.
 *
 * Concurrency is 1 (review.json queue.concurrency): reviews run one at a
 * time. The BullMQ jobId is the ReviewJob.id, which makes enqueue attempts
 * idempotent — re-enqueueing the same outbox event after a crash cannot
 * create a duplicate job.
 *
 * This module is a factory only: bootstrap constructs the queue once and
 * injects it into the ingestion outbox service.
 */

/**
 * Dedicated BullMQ connection. Unlike the shared health-check client
 * (`src/platform/redis.ts`), this one fails commands fast while disconnected
 * (enableOfflineQueue: false, bounded retries) so the outbox publisher
 * fails fast and leaves events pending instead of hanging.
 */
function createQueueConnection(redisUrl: string): Redis {
  return new Redis(redisUrl, {
    lazyConnect: false,
    connectTimeout: 2000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: (times: number) => (times > 3 ? null : Math.min(times * 200, 1000)),
  });
}

/**
 * A ready-to-use review queue plus its dedicated fast-fail connection.
 * `close()` shuts both down; bootstrap wires it into graceful shutdown.
 *
 * `queue`/`connection` stay exposed for recovery and alert evaluation;
 * business code depends on the `ReviewQueue` port.
 */
export interface BullMqReviewQueue extends ReviewQueue {
  queue: Queue<ReviewJobPayload>;
  connection: Redis;
}

export function createReviewQueue(redisUrl: string): BullMqReviewQueue {
  const connection = createQueueConnection(redisUrl);
  connection.on("error", () => {
    // Swallow connection errors: callers observe enqueue results and the
    // outbox recovery loop retries. Never crash the process.
  });
  const queue = new Queue<ReviewJobPayload>(REVIEW_QUEUE_NAME, { connection });
  return {
    queue,
    connection,
    enqueue(payload: ReviewJobPayload, options: ReviewQueueEnqueueOptions): Promise<{ id?: string }> {
      // The durable ReviewJob.id is the BullMQ jobId. Re-publishing the same
      // outbox event is therefore a silent no-op instead of a duplicate job.
      return queue.add("review", payload, {
        jobId: options.jobId,
        attempts: options.attempts,
        backoff: options.backoff,
        removeOnComplete: options.removeOnComplete ?? 1000,
        removeOnFail: options.removeOnFail ?? 5000,
      });
    },
    async removeTerminalJob(jobId: string): Promise<void> {
      // A terminal job retained by removeOnComplete/removeOnFail makes
      // `queue.add` with the same jobId a silent no-op. Recovery must clear it
      // or the review would flip to `enqueued` while nothing ever runs.
      const existing = await queue.getJob(jobId);
      if (!existing) {
        return;
      }
      const state = await existing.getState();
      if (state === "completed" || state === "failed") {
        await existing.remove();
      }
    },
    async getJobCounts(): Promise<ReviewQueueCounts> {
      const counts = await queue.getJobCounts("waiting", "active", "delayed");
      return {
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        delayed: counts.delayed ?? 0,
      };
    },
    async close(): Promise<void> {
      try {
        await queue.close();
      } catch {
        // Already closed.
      }
      try {
        await connection.quit();
      } catch {
        // Already disconnected.
      }
    },
  };
}

/**
 * Dedicated BullMQ worker connection. Workers need an offline queue and
 * unbounded command retries so a brief Redis outage does not kill in-flight
 * job processing.
 */
export function createWorkerConnection(redisUrl: string): Redis {
  const connection = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
  });
  connection.on("error", () => {
    // Swallow connection errors; BullMQ surfaces stalled/retry state itself.
  });
  return connection;
}
