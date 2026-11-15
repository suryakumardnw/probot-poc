import { ERROR_CODES } from "../contracts/errors.js";
import { outboxPayloadSchema, type ReviewJobPayload } from "../contracts/queue.js";
import type { Logger } from "../ports/logger.js";
import type { ReviewConfigStore } from "../ports/review-config.js";
import type { ReviewQueue } from "../ports/review-queue.js";
import { AppError, ValidationError } from "../shared/errors/index.js";
import type { OutboxEventRecord } from "./ingestion.repository.js";
import type { IngestionRepositories, IngestionUnitOfWork } from "./ingestion.unit-of-work.js";

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
 *
 * Persistence goes through the outbox/review-job repositories; the service
 * receives them (plus the unit of work) and never reads a Prisma singleton.
 */

export type PublishResult = "published" | "discarded" | "skipped" | "failed";

/**
 * Parse the stored outbox payload into the queue contract.
 *
 * The outbox row is the durable request snapshot: no field is defaulted from
 * the job row and no missing value is invented. An invalid snapshot is a
 * permanent failure (`OUTBOX_PAYLOAD_INVALID`), so the publisher discards the
 * event instead of retrying it forever; reconciliation still rebuilds the
 * queue payload from the durable review/job rows.
 */
function buildPayload(event: OutboxEventRecord): ReviewJobPayload {
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

function jobRetryOptions(config: ReviewConfigStore): {
  attempts: number;
  backoff: { type: "exponential" | "fixed"; delay: number };
} {
  try {
    const { config: loaded } = config.load();
    const infra = loaded.queue.retry.infrastructure;
    return {
      attempts: infra.enabled ? infra.maxAttempts : 1,
      backoff: { type: infra.backoff, delay: 5000 },
    };
  } catch {
    // Configuration unavailable: safe defaults (§11.2 last-known-good also failed).
    return { attempts: 3, backoff: { type: "exponential", delay: 5000 } };
  }
}

export type OutboxServiceDependencies = {
  repositories: IngestionRepositories;
  unitOfWork: IngestionUnitOfWork;
  config: ReviewConfigStore;
  /** Review queue bound by the composition root (BullMQ today). */
  queue: ReviewQueue;
  logger: Logger;
};

export interface OutboxService {
  /**
   * Publish a single outbox event to the BullMQ queue. Never throws: the
   * result reports what happened so the recovery loop can retry later.
   */
  publishOutboxEvent(eventId: string): Promise<PublishResult>;
}

export function createOutboxService(deps: OutboxServiceDependencies): OutboxService {
  /**
   * Publish a single outbox event to the BullMQ queue. Never throws: the
   * result reports what happened so the recovery loop can retry later.
   */
  async function publishOutboxEvent(eventId: string): Promise<PublishResult> {
    try {
      const event = await deps.repositories.outboxEvents.findByIdWithJob(eventId);
      if (!event || event.status !== "pending") {
        return "skipped";
      }
      const job = event.reviewJob;

      // A superseded job must not be enqueued; discard its pending event.
      if (job.status === "superseded") {
        await deps.repositories.outboxEvents.discard(event.id, "review job superseded");
        return "discarded";
      }

      const payload = buildPayload(event);
      const retry = jobRetryOptions(deps.config);

      // Commit the durable `enqueued` state BEFORE the job becomes visible to
      // consumers. Adding to Redis first opens a race where an idle worker picks
      // the job up while the row still says `pending_outbox`; the worker then
      // skips it, BullMQ records the skip as success, and the review never runs.
      // A failed publish is rolled back to `pending_outbox` below so the outbox
      // event and job row stay consistent for recovery.
      await deps.repositories.reviewJobs.update(job.id, { status: "enqueued" });

      const queueJob = await (async () => {
        try {
          return await deps.queue.enqueue(payload, {
            jobId: job.id, // idempotent: same ReviewJob.id never enqueued twice
            attempts: retry.attempts,
            backoff: retry.backoff,
          });
        } catch (error) {
          // Publish failed (e.g. Redis down): restore the durable pre-publish
          // state so the outbox event and job row agree. The `queueJobId: null`
          // guard keeps a concurrent successful publisher's state intact.
          await deps.repositories.reviewJobs.restorePendingOutbox(job.id).catch(() => {
            /* Postgres may be unreachable too; recovery retries either way. */
          });
          throw error;
        }
      })();

      // The outbox row and the job's queue identity commit together.
      await deps.unitOfWork.execute(async (repos) => {
        await repos.outboxEvents.markPublished(event.id, new Date());
        await repos.reviewJobs.update(job.id, { queueJobId: queueJob.id ?? job.id });
      });
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
          const discarded = await deps.repositories.outboxEvents.discardIfPending(eventId, message);
          if (discarded) {
            deps.logger.error(
              { err: message, code, outboxEventId: eventId },
              "Outbox payload invalid; event discarded",
            );
            return "discarded";
          }
        } catch {
          // Postgres may be unreachable; fall through to the retryable failure.
        }
      }

      try {
        await deps.repositories.outboxEvents.incrementAttemptsIfPending(eventId, message);
      } catch {
        // Postgres may be unreachable too; the event stays pending.
      }
      deps.logger.warn({ err: message, code, outboxEventId: eventId }, "Outbox publish failed; event stays pending");
      return "failed";
    }
  }

  return { publishOutboxEvent };
}
