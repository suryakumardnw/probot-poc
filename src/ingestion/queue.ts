import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { ERROR_CODES } from "../contracts/errors.js";
import { reviewJobPayloadSchema, type ReviewJobPayload } from "../contracts/queue.js";
import { ValidationError } from "../shared/errors/index.js";

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
 */

export const REVIEW_QUEUE_NAME = "review-jobs";

export {
  INGEST_OUTCOMES,
  REVIEW_MODES,
  REVIEW_TRIGGERS,
  REVIEW_TYPES,
  ingestOutcomeSchema,
  outboxPayloadSchema,
  reviewJobPayloadSchema,
} from "../contracts/queue.js";
export type {
  IngestOutcome,
  OutboxPayload,
  ReviewJobPayload,
  ReviewModeValue,
  ReviewTriggerValue,
  ReviewTypeValue,
} from "../contracts/queue.js";

let queue: Queue<ReviewJobPayload> | undefined;

/**
 * Parse a BullMQ job's `data` at the worker boundary.
 *
 * A failure here is permanent: retrying cannot repair the stored payload, so
 * the worker records the stable code durably and lets BullMQ fail the job
 * without consuming its retry budget.
 */
export function parseReviewJobPayload(data: unknown): ReviewJobPayload {
  const parsed = reviewJobPayloadSchema.safeParse(data);
  if (!parsed.success) {
    throw new ValidationError("Review job payload does not match the queue contract", {
      code: ERROR_CODES.REVIEW_JOB_PAYLOAD_INVALID,
      details: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}

/**
 * Dedicated BullMQ connection. Unlike the shared health-check client
 * (src/lib/redis.ts), this one fails commands fast while disconnected
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

let connection: Redis | undefined;

export function getReviewQueue(redisUrl?: string): Queue<ReviewJobPayload> {
  if (!queue) {
    connection = createQueueConnection(redisUrl ?? process.env.REDIS_URL ?? "redis://localhost:6379");
    connection.on("error", () => {
      // Swallow connection errors: callers observe enqueue results and the
      // outbox recovery loop retries. Never crash the process.
    });
    queue = new Queue<ReviewJobPayload>(REVIEW_QUEUE_NAME, { connection });
  }
  return queue;
}

export function getQueueConnection(): Redis | undefined {
  return connection;
}

export async function closeReviewQueue(): Promise<void> {
  try {
    await queue?.close();
  } catch {
    // Already closed.
  }
  queue = undefined;
  try {
    await connection?.quit();
  } catch {
    // Already disconnected.
  }
  connection = undefined;
}
