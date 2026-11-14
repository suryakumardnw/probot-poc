import type { OutboxEvent, ReviewJob } from "@prisma/client";
import type { Queue } from "bullmq";
import type pino from "pino";
import { loadEnv } from "../config/env.js";
import { DEFAULT_CONFIG_PATH, loadReviewConfig } from "../config/review-loader.js";
import { createLogger } from "../lib/logger.js";
import { getPrisma } from "../lib/prisma.js";
import { getReviewQueue, type ReviewJobPayload } from "./queue.js";

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

function buildPayload(event: OutboxEvent, job: ReviewJob): ReviewJobPayload {
  const payload = event.payload as Partial<ReviewJobPayload>;
  return {
    reviewId: payload.reviewId ?? job.reviewId,
    jobKey: job.jobKey,
    githubInstallationId: payload.githubInstallationId ?? "",
    githubRepositoryId: payload.githubRepositoryId ?? "",
    repositoryFullName: payload.repositoryFullName ?? "",
    pullRequestNumber: payload.pullRequestNumber ?? 0,
    headSha: payload.headSha ?? "",
    baseSha: payload.baseSha ?? null,
    reviewMode: payload.reviewMode ?? "adaptive",
    reviewType: payload.reviewType ?? "standard",
    trigger: payload.trigger ?? "opened",
    configurationHash: payload.configurationHash ?? null,
  };
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

    const payload = buildPayload(event, job);
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
    const message = error instanceof Error ? error.message : String(error);
    try {
      await prisma.outboxEvent.updateMany({
        where: { id: eventId, status: "pending" },
        data: { attempts: { increment: 1 }, lastError: message },
      });
    } catch {
      // Postgres may be unreachable too; the event stays pending.
    }
    logger.warn({ err: message, outboxEventId: eventId }, "Outbox publish failed; event stays pending");
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
