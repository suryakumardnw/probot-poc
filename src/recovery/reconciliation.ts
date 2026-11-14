/**
 * Startup reconciliation and recovery (ARCHITECTURE.md §12.2, §17.3).
 *
 * On worker startup (and periodically) every non-terminal review whose job is
 * stuck (Redis lost the job, worker crashed mid-review, DB write interrupted)
 * is reconciled:
 *
 *  1. Identify incomplete review records (non-terminal review state whose
 *     ReviewJob is still pending_outbox / enqueued / processing).
 *  2. Reconcile durable jobs with queue state (§17.3 step 5).
 *  3. Detect stale worker sessions (no progress for `staleThresholdMs`).
 *  4. Recover or fail incomplete reviews per policy:
 *     - recoverable and attempts remain → re-enqueue;
 *     - otherwise → transition the review to `failed`.
 *  5. Expired workspaces are swept (caller-provided cleanup hook).
 *
 * DUPLICATE-FREE GUARANTEE: re-enqueueing reuses the existing BullMQ job
 * identity — jobId equals ReviewJob.id (ticket 03 contract) — so a recovered
 * review can never produce a second queue job for the same review.
 */

import type { PrismaClient, Review, ReviewJob, ReviewState } from "@prisma/client";
import type { Queue } from "bullmq";
import type pino from "pino";
import { ERROR_CODES } from "../contracts/errors.js";
import { outboxPayloadSchema, reviewJobPayloadSchema, type ReviewJobPayload } from "../contracts/queue.js";
import { TERMINAL_REVIEW_STATES } from "../ingestion/review-state.js";
import { getMetricsRegistry } from "../observability/metrics.js";
import { AppError, ValidationError } from "../shared/errors/index.js";

export type RecoveryPolicy = "requeue" | "fail";

export interface ReconciliationDeps {
  prisma: PrismaClient;
  logger: pino.Logger;
  /** BullMQ queue used to re-enqueue recovered reviews. */
  queue?: Queue<ReviewJobPayload>;
  /** Recovery behavior for stale reviews (§17.3 step 7). Default "requeue". */
  policy?: RecoveryPolicy;
  /** A review with no progress for longer than this is considered stale. */
  staleThresholdMs?: number;
  /** Max total job attempts before recovery gives up and fails the review. */
  maxJobAttempts?: number;
  /** Fixed clock (tests). */
  now?: Date;
  /** Workspace cleanup hook (e.g. ReviewWorkspaceService.sweepExpired). */
  sweepExpiredWorkspaces?: () => Promise<number>;
  /** Retry budget comes from the durable job row when absent. */
}

export interface ReconciliationSummary {
  /** Non-terminal reviews with an unfinished durable job that were scanned. */
  scanned: number;
  /** Reviews re-enqueued for processing. */
  requeued: number;
  /** Reviews transitioned to failed (policy fail, or attempts exhausted). */
  failed: number;
  /** Reviews skipped (fresh enough to still be making progress). */
  fresh: number;
  /** Stale worker sessions detected (stuck past the threshold). */
  staleSessions: number;
  /** Workspaces cleaned by the cleanup hook. */
  workspacesSwept: number;
}

const DEFAULT_STALE_THRESHOLD_MS = 15 * 60_000;
const DEFAULT_MAX_JOB_ATTEMPTS = 3;

/**
 * Build the queue payload for a review from the durable rows.
 *
 * The rows are the source of truth for recovery. They are parsed through the
 * same contract as a published payload, so a row value outside the contract
 * fails loudly instead of being enqueued as an invalid job.
 */
function buildPayloadFromRows(review: Review, job: ReviewJob, repositoryFullName?: string): ReviewJobPayload {
  const parsed = reviewJobPayloadSchema.safeParse({
    reviewId: review.id,
    jobKey: job.jobKey,
    githubInstallationId: review.githubInstallationId.toString(),
    githubRepositoryId: review.githubRepositoryId.toString(),
    repositoryFullName: repositoryFullName ?? `${review.githubRepositoryId}/${review.pullRequestNumber}`,
    pullRequestNumber: review.pullRequestNumber,
    headSha: review.headSha,
    baseSha: review.baseSha,
    reviewMode: review.reviewMode,
    reviewType: review.reviewType,
    trigger: review.trigger,
    configurationHash: review.configurationHash,
  });
  if (!parsed.success) {
    throw new ValidationError("Durable review rows do not match the review job contract", {
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
 * Reset a review to `queued` for reprocessing (recovery path, §17.3). This
 * intentionally bypasses the forward-only state machine — recovery is the
 * one sanctioned way to move a review backwards — but still records a
 * durable transition row (`fromState -> queued`) so the history stays
 * auditable.
 */
export async function resetReviewForRecovery(prisma: PrismaClient, reviewId: string): Promise<void> {
  const review = await prisma.review.findUnique({ where: { id: reviewId }, select: { state: true } });
  if (!review) {
    throw new Error(`Review '${reviewId}' not found`);
  }
  await prisma.$transaction([
    prisma.review.update({
      where: { id: reviewId },
      data: { state: "queued", errorCode: null, errorMessage: null },
    }),
    prisma.reviewStateTransition.create({
      data: { reviewId, fromState: review.state as ReviewState, toState: "queued" },
    }),
  ]);
}

/**
 * Terminal recovery failure: reset the review to `queued` (so the transition
 * history remains auditable), mark it failed with the given stable code, and
 * fail the durable job row.
 */
async function failReviewForRecovery(
  prisma: PrismaClient,
  reviewId: string,
  jobId: string,
  reason: string,
  errorCode: string,
): Promise<void> {
  await resetReviewForRecovery(prisma, reviewId);
  await prisma.review.update({
    where: { id: reviewId },
    data: {
      state: "failed",
      errorCode,
      errorMessage: reason.slice(0, 500),
    },
  });
  await prisma.reviewStateTransition.create({
    data: { reviewId, fromState: "queued", toState: "failed" },
  });
  await prisma.reviewJob.update({
    where: { id: jobId },
    data: { status: "failed", lastError: reason.slice(0, 500) },
  });
}

/**
 * Reconcile incomplete reviews. Never throws per-review: individual failures
 * are logged and reflected in the summary; only a Prisma-level outage (which
 * the §12.4 postgres_unavailable policy treats as "recover state later")
 * surfaces through the returned summary of 0 with a warning.
 */
export async function reconcileIncompleteReviews(deps: ReconciliationDeps): Promise<ReconciliationSummary> {
  const {
    prisma,
    logger,
    queue,
    policy = "requeue",
    staleThresholdMs = DEFAULT_STALE_THRESHOLD_MS,
    maxJobAttempts = DEFAULT_MAX_JOB_ATTEMPTS,
    now = new Date(),
    sweepExpiredWorkspaces,
  } = deps;

  const summary: ReconciliationSummary = {
    scanned: 0,
    requeued: 0,
    failed: 0,
    fresh: 0,
    staleSessions: 0,
    workspacesSwept: 0,
  };

  let jobs: Array<ReviewJob & { review: Review }>;
  try {
    jobs = await prisma.reviewJob.findMany({
      where: {
        status: { in: ["pending_outbox", "enqueued", "processing"] },
        review: { state: { notIn: [...TERMINAL_REVIEW_STATES] } },
      },
      include: { review: true },
      orderBy: { createdAt: "asc" },
      take: 200,
    });
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      "Reconciliation could not read review jobs (PostgreSQL unavailable); will retry",
    );
    return summary;
  }

  summary.scanned = jobs.length;

  // Resolve real repository full names so the recovered payload matches the
  // original ingestion payload (falls back to the id/PR composite when the
  // repository row is gone).
  const fullNames = new Map<string, string>();
  try {
    const repositoryIds = [...new Set(jobs.map((j) => j.review.githubRepositoryId))];
    const repositories = await prisma.repository.findMany({
      where: { githubRepositoryId: { in: repositoryIds } },
      select: { githubRepositoryId: true, fullName: true },
    });
    for (const repository of repositories) {
      fullNames.set(repository.githubRepositoryId.toString(), repository.fullName);
    }
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      "Reconciliation could not resolve repository names; using composite fallback",
    );
  }

  for (const job of jobs) {
    const staleAt = new Date(job.updatedAt.getTime() + staleThresholdMs);
    const isStale = staleAt.getTime() <= now.getTime();
    if (!isStale) {
      summary.fresh += 1;
      continue;
    }
    summary.staleSessions += 1;
    const review = job.review;
    const staleForMs = now.getTime() - job.updatedAt.getTime();

    const attemptsExhausted = job.attempts >= maxJobAttempts;
    const shouldFail = policy === "fail" || attemptsExhausted || !queue;

    if (shouldFail) {
      const reason = attemptsExhausted
        ? `recovery attempts exhausted (${job.attempts}/${maxJobAttempts})`
        : policy === "fail"
          ? "recovery policy is fail"
          : "no queue available for re-enqueue";
      logger.warn(
        { reviewId: review.id, jobId: job.id, staleForMs, reason },
        "Failing stale incomplete review during reconciliation",
      );
      try {
        await failReviewForRecovery(prisma, review.id, job.id, reason, "recovery_exhausted");
        getMetricsRegistry().reviewsFailed.inc(1, { failure_class: "recovery_exhausted" });
        summary.failed += 1;
      } catch (error) {
        logger.error(
          { reviewId: review.id, err: error instanceof Error ? error.message : String(error) },
          "Reconciliation failed to fail stale review",
        );
      }
      continue;
    }

    // Recoverable: reset the durable state and re-enqueue with the SAME
    // BullMQ job id (ReviewJob.id) — no duplicate job can be created.
    try {
      const outboxEvent = await prisma.outboxEvent.findFirst({
        where: { reviewJobId: job.id },
        orderBy: { createdAt: "desc" },
      });
      const stored = outboxEvent ? outboxPayloadSchema.safeParse(outboxEvent.payload) : undefined;
      if (stored && !stored.success) {
        logger.warn(
          {
            reviewId: review.id,
            jobId: job.id,
            code: ERROR_CODES.OUTBOX_PAYLOAD_INVALID,
            issues: stored.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
          },
          "Stored outbox payload is invalid; rebuilding the queue payload from durable rows",
        );
      }
      const fallback = buildPayloadFromRows(review, job, fullNames.get(review.githubRepositoryId.toString()));
      const payload: ReviewJobPayload = stored?.success
        ? {
            ...fallback,
            repositoryFullName: stored.data.repositoryFullName,
            reviewMode: stored.data.reviewMode,
            trigger: stored.data.trigger,
            baseSha: stored.data.baseSha ?? fallback.baseSha,
            configurationHash: stored.data.configurationHash ?? fallback.configurationHash,
          }
        : fallback;

      // A terminal BullMQ job (completed/failed) with this id is retained by
      // removeOnComplete/removeOnFail, and `queue.add` with an existing jobId
      // is a silent no-op. Without clearing it, recovery would flip the review
      // back to `enqueued` while nothing ever runs — a permanent stale→requeue
      // loop. Only terminal jobs are removed; an active/waiting job still owns
      // the work and must not be touched.
      const existing = await queue.getJob(job.id);
      if (existing) {
        const state = await existing.getState();
        if (state === "completed" || state === "failed") {
          await existing.remove();
        }
      }

      await resetReviewForRecovery(prisma, review.id);
      await prisma.reviewJob.update({
        where: { id: job.id },
        data: { status: "enqueued" },
      });
      // Idempotent identity: jobId = ReviewJob.id (ticket 03 contract).
      await queue.add("review", payload, {
        jobId: job.id,
        attempts: Math.max(1, maxJobAttempts - job.attempts),
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      });
      logger.info(
        { reviewId: review.id, jobId: job.id, staleForMs, attempts: job.attempts },
        "Recovered stale incomplete review by re-enqueueing",
      );
      summary.requeued += 1;
    } catch (error) {
      if (error instanceof AppError && error.code === ERROR_CODES.REVIEW_JOB_PAYLOAD_INVALID) {
        // Durable rows outside the contract cannot produce a valid queue job.
        // Fail permanently instead of retrying the same invalid payload on
        // every reconciliation pass.
        const reason = `${error.code}: ${error.message}`;
        try {
          await failReviewForRecovery(prisma, review.id, job.id, reason, error.code);
          getMetricsRegistry().reviewsFailed.inc(1, { failure_class: "review_payload_invalid" });
          summary.failed += 1;
          logger.error(
            { reviewId: review.id, jobId: job.id, code: error.code },
            "Failing review with invalid durable payload",
          );
        } catch (failure) {
          logger.error(
            { reviewId: review.id, err: failure instanceof Error ? failure.message : String(failure) },
            "Reconciliation failed to fail invalid review",
          );
        }
        continue;
      }
      logger.error(
        { reviewId: review.id, err: error instanceof Error ? error.message : String(error) },
        "Reconciliation could not re-enqueue stale review",
      );
    }
  }

  if (sweepExpiredWorkspaces) {
    try {
      summary.workspacesSwept = await sweepExpiredWorkspaces();
    } catch {
      // Cleanup is best-effort (§12.4 workspace cleanup).
    }
  }

  return summary;
}
