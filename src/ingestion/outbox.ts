import type { OutboxEvent } from "@prisma/client";
import type { Queue } from "bullmq";
import type pino from "pino";
import { loadEnv } from "../config/env.js";
import { DEFAULT_CONFIG_PATH, loadReviewConfig } from "../config/review-loader.js";
import { ERROR_CODES } from "../contracts/errors.js";
import { outboxPayloadSchema, type ReviewJobPayload } from "../contracts/queue.js";
import { createLogger } from "../lib/logger.js";
import { getPrisma } from "../lib/prisma.js";
import { AppError, ValidationError } from "../shared/errors/index.js";
import { getReviewQueue } from "./queue.js";

/**
 * Transactional outbox publisher (ARCHITECTURE.md §12.2).
 *
 * Review requests are committed to Postgres first (review + job + pending
 * outbox event in one transaction), then published to BullMQ. If Redis is
 * unavailable, the event stays pending and `recoverOutbox()` retries later —
 * no review request is ever lost because of a Redis outage.
 *
 * Enqueue idempotency: the BullMQ jobId equals the ReviewJob.id, so repeated
 * publish attempts of the same event collapse into a single job.
 */

export type PublishResult = "published" | "discarded" | "skipped" | "failed";

const logger: pino.Logger = createLogger(loadEnv());

/**
 * Parse the stored outbox payload into the queue contract.
 *
 * The outbox row is the durable request snapshot: no field is defaulted from
 * the job row and no missing value is invented. An invalid snapshot is a
 * permanent failure (`OUTBOX_PAYLOAD_INVALID`), so the publisher discards the
 * event instead of retrying it forever; reconciliation still rebuilds the
 * queue payload from the durable review/job rows.
 */
function buildPayload(event: OutboxEvent): ReviewJobPayload {
  const parsed = outboxPayloadSchema.safeParse(event.payload);
  if (!parsed.success) {
    throw new ValidationError("Outbox event payload does not match the review job contract", {
      code: ERROR_CODES.OUTBOX_PAYLOAD_INVALID,
      details: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  // The queue job carries only the review-job contract; the producer-only
  // `reviewEnabled` snapshot flag stays in the outbox row.
  const { reviewEnabled: _reviewEnabled, ...payload } = parsed.data;
  return payload;
}

function jobRetryOptions(): { attempts: number; backoff: { type: "exponential" | "fixed"; delay: number } } {
  try {
    const { config } = loadReviewConfig(DEFAULT_CONFIG_PATH);
    const infra = config.queue.retry.infrastructure;
    return {
      attempts: infra.enabled ? infra.maxAttempts : 1,
      backoff: { type: infra.backoff, delay: 5000 },
    };
  } catch {
    // Configuration unavailable: safe defaults (§11.2 last-known-good also failed).
    return { attempts: 3, backoff: { type: "exponential", delay: 5000 } };
  }
}

/**
 * Publish a single outbox event to the BullMQ queue. Never throws: the
 * result reports what happened so the recovery loop can retry later.
 */
export async function publishOutboxEvent(
  eventId: string,
  queue: Queue<ReviewJobPayload> = getReviewQueue(),
): Promise<PublishResult> {
  const prisma = getPrisma();
  try {
    const event = await prisma.outboxEvent.findUnique({ where: { id: eventId }, include: { reviewJob: true } });
    if (!event || event.status !== "pending") {
      return "skipped";
    }
    const job = event.reviewJob;

    // A superseded job must not be enqueued; discard its pending event.
    if (job.status === "superseded") {
      await prisma.outboxEvent.update({
        where: { id: event.id },
        data: { status: "discarded", lastError: "review job superseded" },
      });
      return "discarded";
    }

    const payload = buildPayload(event);
    const retry = jobRetryOptions();

    // Commit the durable `enqueued` state BEFORE the job becomes visible to
    // consumers. Adding to Redis first opens a race where an idle worker picks
    // the job up while the row still says `pending_outbox`; the worker then
    // skips it, BullMQ records the skip as success, and the review never runs.
    // A failed publish is rolled back to `pending_outbox` below so the outbox
    // event and job row stay consistent for recovery.
    await prisma.reviewJob.update({
      where: { id: job.id },
      data: { status: "enqueued" },
    });

    const queueJob = await (async () => {
      try {
        return await queue.add("review", payload, {
          jobId: job.id, // idempotent: same ReviewJob.id never enqueued twice
          attempts: retry.attempts,
          backoff: retry.backoff,
          removeOnComplete: 1000,
          removeOnFail: 5000,
        });
      } catch (error) {
        // Publish failed (e.g. Redis down): restore the durable pre-publish
        // state so the outbox event and job row agree. The `queueJobId: null`
        // guard keeps a concurrent successful publisher's state intact.
        await prisma.reviewJob
          .updateMany({
            where: { id: job.id, status: "enqueued", queueJobId: null },
            data: { status: "pending_outbox" },
          })
          .catch(() => {
            /* Postgres may be unreachable too; recovery retries either way. */
          });
        throw error;
      }
    })();

    await prisma.$transaction([
      prisma.outboxEvent.update({
        where: { id: event.id },
        data: { status: "published", publishedAt: new Date(), lastError: null },
      }),
      prisma.reviewJob.update({
        where: { id: job.id },
        data: { queueJobId: queueJob.id ?? job.id },
      }),
    ]);
    return "published";
  } catch (error) {
    const code = error instanceof AppError ? error.code : undefined;
    const detail = error instanceof Error ? error.message : String(error);
    const message = code ? `${code}: ${detail}` : detail;

    if (error instanceof AppError && error.code === ERROR_CODES.OUTBOX_PAYLOAD_INVALID) {
      // A malformed durable snapshot can never become valid by retrying.
      // Discard it so the recovery loop stops rescanning it; reconciliation
      // rebuilds the queue payload from the review/job rows, which remain the
      // source of truth.
      try {
        const discarded = await prisma.outboxEvent.updateMany({
          where: { id: eventId, status: "pending" },
          data: { status: "discarded", lastError: message },
        });
        if (discarded.count > 0) {
          logger.error({ err: message, code, outboxEventId: eventId }, "Outbox payload invalid; event discarded");
          return "discarded";
        }
      } catch {
        // Postgres may be unreachable; fall through to the retryable failure.
      }
    }

    try {
      await prisma.outboxEvent.updateMany({
        where: { id: eventId, status: "pending" },
        data: { attempts: { increment: 1 }, lastError: message },
      });
    } catch {
      // Postgres may be unreachable too; the event stays pending.
    }
    logger.warn({ err: message, code, outboxEventId: eventId }, "Outbox publish failed; event stays pending");
    return "failed";
  }
}

export type OutboxRecoverySummary = {
  scanned: number;
  published: number;
  discarded: number;
  failed: number;
};

/**
 * Re-publish pending outbox events (oldest first). Called periodically by
 * the worker and right after startup. Never throws.
 */
export async function recoverOutbox(limit = 100, queue?: Queue<ReviewJobPayload>): Promise<OutboxRecoverySummary> {
  const prisma = getPrisma();
  const pending = await prisma.outboxEvent
    .findMany({
      where: { status: "pending" },
      orderBy: { createdAt: "asc" },
      take: limit,
      select: { id: true },
    })
    .catch(() => [] as Array<{ id: string }>);

  const summary: OutboxRecoverySummary = { scanned: pending.length, published: 0, discarded: 0, failed: 0 };
  for (const event of pending) {
    const result = await publishOutboxEvent(event.id, queue);
    if (result === "published") {
      summary.published += 1;
    } else if (result === "discarded") {
      summary.discarded += 1;
    } else if (result === "failed") {
      summary.failed += 1;
    }
  }
  return summary;
}
