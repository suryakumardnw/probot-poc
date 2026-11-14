import fs from "node:fs";
import type { PrismaClient } from "@prisma/client";
import { UnrecoverableError, Worker } from "bullmq";
import { Redis } from "ioredis";
import type pino from "pino";
import { AgentRuntimeError } from "../agent/types.js";
import { parseReviewJobPayload, REVIEW_QUEUE_NAME, type ReviewJobPayload } from "../ingestion/queue.js";
import { transitionReviewState } from "../ingestion/review-state.js";
import {
  createReviewLogger,
  startStage,
  type ReviewCorrelation,
  type StageTracker,
} from "../observability/correlation.js";
import { getMetricsRegistry } from "../observability/metrics.js";
import { classifyFailure, retryPolicyFor, type RetryPolicyConfig } from "../observability/retry.js";
import { DEFAULT_RETRY_POLICY_CONFIG } from "../observability/retry.js";
import { endSpan, reviewSpanAttributes, startSpan } from "../observability/tracing.js";
import { AppError } from "../shared/errors/index.js";
import { AppInstallationTokenProvider, NullTokenProvider, type InstallationTokenProvider } from "./credentials.js";
import { redactCredentials } from "./redact.js";
import { StaleCommitError, ReviewRetrievalError, type WorkspaceResult } from "./workspace.js";
import type { ReviewWorkspaceService } from "./workspace.js";

/** Max characters of error detail attached to the structured failure log. */
const MAX_LOGGED_ERROR_DETAIL_CHARS = 4_000;

/**
 * Review worker job processor (ticket 04).
 *
 * Consumes BullMQ queue "review-jobs" (concurrency from review.json
 * `queue.concurrency`, default 1). The BullMQ jobId equals the ReviewJob.id
 * (ticket 03 contract).
 *
 * IMPORTANT (ticket 03 handoff): before doing any work the processor checks
 * the DURABLE job status. A job whose ReviewJob.status is "superseded"
 * (replaced by a newer commit while it sat in the queue) must be skipped —
 * the review has already been superseded in Postgres and must never run.
 */
export interface ProcessReviewJobDeps {
  prisma: PrismaClient;
  service: ReviewWorkspaceService;
  logger: pino.Logger;
  concurrency: number;
  /**
   * Hook for the agent runtime (ticket 07): invoked with the prepared
   * workspace before cleanup. Never receives credentials. The default
   * wiring (`createReviewEngineHook`) runs the adaptive review engine and
   * advances the review state machine (analyzing → investigating → validating).
   */
  onWorkspacePrepared?: (ctx: { payload: ReviewJobPayload; workspace: WorkspaceResult }) => Promise<unknown>;
  /**
   * §12.4 retry policy (ticket 12): governs retry decisions per failure
   * class. Defaults to the §11.3 review.json-derived defaults when omitted.
   */
  retryPolicy?: RetryPolicyConfig;
}

export type ProcessOutcome = "processed" | "skipped_superseded" | "skipped_status" | "failed";

export async function processReviewJob(
  jobId: string,
  payload: ReviewJobPayload,
  deps: ProcessReviewJobDeps,
): Promise<ProcessOutcome> {
  const { prisma, logger } = deps;
  const job = await prisma.reviewJob.findUnique({ where: { id: jobId }, include: { review: true } });
  if (!job) {
    logger.warn({ jobId }, "ReviewJob row missing for queue job; discarding");
    return "failed";
  }

  // Stale/outdated job supersede check (ticket 03 §4.4 handoff): a superseded
  // job is dead on arrival — no workspace, no clone, no token minting.
  if (job.status === "superseded") {
    logger.info({ jobId, reviewId: job.reviewId }, "Review job superseded before processing; skipping");
    return "skipped_superseded";
  }
  // Claim the durable row atomically instead of trusting the snapshot read
  // above. The outbox publisher commits `enqueued` in Postgres and only then
  // (in the old ordering) made the queue job visible, so an idle worker could
  // legitimately observe `pending_outbox` for an in-flight job and discard it
  // as "not processable" — BullMQ then treats the skip as a successful run.
  // `processing` stays claimable so a stalled/retried delivery can resume.
  const claimed = await prisma.reviewJob.updateMany({
    where: {
      id: job.id,
      status: { in: ["pending_outbox", "enqueued", "processing"] },
    },
    data: { status: "processing", attempts: { increment: 1 } },
  });
  if (claimed.count === 0) {
    logger.info({ jobId, status: job.status }, "Review job not in a processable state; skipping");
    return "skipped_status";
  }

  let span: ReturnType<typeof startSpan> | undefined;
  let activeStage: StageTracker | undefined;
  try {
    await transitionReviewState(job.reviewId, "preparing");
    await transitionReviewState(job.reviewId, "cloning");

    const correlation: ReviewCorrelation = {
      review_id: job.reviewId,
      job_id: job.id,
      repository: payload.repositoryFullName,
      pull_request_number: payload.pullRequestNumber,
      head_sha: payload.headSha,
    };
    const reviewLogger = createReviewLogger(logger, correlation);
    const metrics = getMetricsRegistry();
    metrics.reviewsStarted.inc();
    const enqueuedAt = job.createdAt instanceof Date ? job.createdAt : new Date(job.createdAt);
    metrics.queueWait.observe(Math.max(0, (Date.now() - enqueuedAt.getTime()) / 1000));

    span = startSpan("review.process", { attributes: reviewSpanAttributes(correlation) });

    const cloneStage = startStage(reviewLogger, "clone");
    activeStage = cloneStage;
    // Base commit resolution: prefer the exact base SHA captured at ingestion.
    // Manual `/review` requests (and older jobs) may have none, so fall back to
    // the repository's default branch instead of failing the clone outright.
    const baseSha = payload.baseSha ?? job.review.baseSha ?? null;
    const repository = baseSha
      ? null
      : await prisma.repository.findUnique({
          where: { githubRepositoryId: job.review.githubRepositoryId },
          select: { defaultBranch: true },
        });
    const baseRef = baseSha ? null : (repository?.defaultBranch ?? null);

    const workspace = await deps.service.prepare({
      reviewId: job.reviewId,
      repositoryFullName: payload.repositoryFullName,
      installationId: BigInt(payload.githubInstallationId),
      pullRequestNumber: payload.pullRequestNumber,
      headSha: payload.headSha,
      baseSha,
      baseRef,
    });
    cloneStage.end();
    activeStage = undefined;

    await transitionReviewState(job.reviewId, "analyzing");

    // Ticket 07: the review engine runs inside the hook (workspace is still
    // present; it is disposed afterwards per repository.workspace config).
    const analyzeStage = startStage(reviewLogger, "analyze");
    activeStage = analyzeStage;
    await deps.onWorkspacePrepared?.({ payload, workspace });
    analyzeStage.end();
    activeStage = undefined;

    await deps.service.cleanupAfterReview(job.reviewId);
    await prisma.reviewJob.update({ where: { id: job.id }, data: { status: "completed" } });
    endSpan(span);
    const metricsRegistry = getMetricsRegistry();
    metricsRegistry.reviewsCompleted.inc(1, { outcome: "processed" });
    metricsRegistry.reviewDuration.observe((Date.now() - enqueuedAt.getTime()) / 1000);
    reviewLogger.info({ jobId, reviewId: job.reviewId }, "Review retrieval processed");
    return "processed";
  } catch (error) {
    const message = redactCredentials(error instanceof Error ? error.message : String(error));
    activeStage?.fail(error, { error: message });
    // AgentRuntimeError carries the sanitized provider/opencode detail; without
    // it the worker only reports a generic message and the root cause is lost.
    const rawDetail = (error as { detail?: unknown } | null)?.detail;
    const errorDetail =
      typeof rawDetail === "string" ? redactCredentials(rawDetail).slice(0, MAX_LOGGED_ERROR_DETAIL_CHARS) : undefined;
    // Both retrieval errors (`clone_failed`, …) and agent runtime errors
    // (`crash`, `timeout`, …) carry a normalized code. Dropping the agent code
    // made every runtime crash classify as "unknown" (no retry, no class in
    // metrics), so it must reach the classifier.
    const errorCode =
      error instanceof ReviewRetrievalError || error instanceof AgentRuntimeError ? error.code : undefined;
    const failureClass = classifyFailure({
      errorCode: errorCode ?? null,
      message,
    });
    const decision = retryPolicyFor(failureClass, deps.retryPolicy ?? DEFAULT_RETRY_POLICY_CONFIG);
    const reviewLogger2 = createReviewLogger(logger, {
      review_id: job.reviewId,
      job_id: job.id,
      repository: payload.repositoryFullName,
      pull_request_number: payload.pullRequestNumber,
      head_sha: payload.headSha,
    });
    reviewLogger2.error(
      {
        jobId,
        reviewId: job.reviewId,
        err: message,
        err_detail: errorDetail,
        error_code: typeof errorCode === "string" ? errorCode : undefined,
        failure_class: failureClass,
        retry_decision: decision,
      },
      "Review retrieval failed",
    );
    if (span) {
      endSpan(span, error);
    }
    getMetricsRegistry().reviewsFailed.inc(1, { failure_class: failureClass });
    await deps.service.cleanupAfterFailure(job.reviewId, message).catch(() => {
      /* cleanup is best-effort */
    });
    try {
      await transitionReviewState(job.reviewId, "failed", {
        errorCode: error instanceof ReviewRetrievalError ? error.code : "retrieval_failed",
        errorMessage: message.slice(0, 500),
      });
    } catch {
      // Review may already be in a terminal state (e.g. superseded) — fine.
    }
    await prisma.reviewJob
      .update({ where: { id: job.id }, data: { status: "failed", lastError: message.slice(0, 500) } })
      .catch(() => {
        /* row already gone */
      });
    return "failed";
  }
}

/**
 * Fail a queue job whose payload violates the contract.
 *
 * The payload is permanent input: retrying cannot change it, so the durable
 * job and review are marked failed with the stable `REVIEW_JOB_PAYLOAD_INVALID`
 * code and the BullMQ job is thrown as an `UnrecoverableError` (no retries).
 * A superseded/completed job is left untouched — its review already reached a
 * terminal state for another reason.
 */
async function failMalformedReviewJob(deps: ProcessReviewJobDeps, jobId: string, error: AppError): Promise<void> {
  const reason = `${error.code}: ${error.message}`.slice(0, 500);
  try {
    const row = await deps.prisma.reviewJob.findUnique({
      where: { id: jobId },
      select: { reviewId: true, status: true },
    });
    if (!row || row.status === "superseded" || row.status === "completed") {
      return;
    }
    await deps.prisma.reviewJob.update({
      where: { id: jobId },
      data: { status: "failed", lastError: reason },
    });
    await transitionReviewState(row.reviewId, "failed", {
      errorCode: error.code,
      errorMessage: reason,
    }).catch(() => {
      // The review may already be terminal (e.g. superseded concurrently).
    });
  } catch (failure) {
    deps.logger.warn(
      {
        jobId,
        err: failure instanceof Error ? failure.message : String(failure),
      },
      "Could not persist malformed review job failure; recovery will reconcile",
    );
  }
}

/**
 * Start the BullMQ review worker. Connection retries are unbounded for the
 * worker (long-lived process), unlike the outbox publisher's fast-fail
 * connection.
 */
export function startReviewWorker(redisUrl: string, deps: ProcessReviewJobDeps): Worker<ReviewJobPayload> {
  const connection = new Redis(redisUrl, {
    // Workers need an offline queue: a brief Redis outage must not kill
    // in-flight job processing.
    maxRetriesPerRequest: null,
  });
  connection.on("error", () => {
    // Swallow connection errors; BullMQ surfaces stalled/retry state itself.
  });
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
        await failMalformedReviewJob(deps, job.id, error);
        // Permanent: do not consume the configured retry budget on a payload
        // that cannot become valid between attempts.
        throw new UnrecoverableError(`${error.code}: ${error.message}`);
      }
      return processReviewJob(job.id, payload, deps);
    },
    { connection, concurrency: deps.concurrency },
  );
  return worker;
}

export async function stopReviewWorker(worker: Worker<ReviewJobPayload>): Promise<void> {
  await worker.close();
  const connection = (worker as unknown as { connection?: Redis }).connection;
  try {
    await connection?.quit();
  } catch {
    // Already disconnected.
  }
}

/**
 * Default installation-token provider built from environment credentials.
 * Falls back to a NullTokenProvider (throws on use) when no GitHub App
 * credentials are configured. Private key material never leaves this module.
 */
export function createDefaultTokenProvider(): InstallationTokenProvider {
  const appId = process.env.GITHUB_APP_ID;
  let privateKey = process.env.GITHUB_PRIVATE_KEY;
  if (!privateKey) {
    const privateKeyPath = process.env.GITHUB_PRIVATE_KEY_PATH;
    if (privateKeyPath) {
      privateKey = fs.readFileSync(privateKeyPath, "utf-8");
    }
  }
  if (!privateKey && process.env.GITHUB_PRIVATE_KEY_BASE64) {
    privateKey = Buffer.from(process.env.GITHUB_PRIVATE_KEY_BASE64.replace(/\s+/g, ""), "base64").toString("utf8");
  }
  if (!appId || !privateKey) {
    return new NullTokenProvider();
  }
  return new AppInstallationTokenProvider({
    appId,
    privateKey,
    baseUrl: process.env.GITHUB_BASE_URL,
  });
}

export { StaleCommitError };
