import fs from "node:fs";
import { UnrecoverableError, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { AgentRuntimeError } from "../../agent/types.js";
import {
  createReviewLogger,
  startStage,
  type ReviewCorrelation,
  type StageTracker,
} from "../../observability/correlation.js";
import { getMetricsRegistry } from "../../observability/metrics.js";
import { classifyQueueFailure, type FailureClass, type RetryPolicyConfig } from "../../observability/retry.js";
import { DEFAULT_RETRY_POLICY_CONFIG } from "../../observability/retry.js";
import { endSpan, reviewSpanAttributes, startSpan } from "../../observability/tracing.js";
import type { Logger } from "../../ports/logger.js";
import { AppError } from "../../shared/errors/index.js";
import {
  isTerminalReviewState,
  parseReviewJobPayload,
  REVIEW_QUEUE_NAME,
  type IngestionRepositories,
  type ReviewJobPayload,
  type ReviewState,
  type ReviewStateService,
} from "../ingestion/index.js";
import { AppInstallationTokenProvider, NullTokenProvider, type InstallationTokenProvider } from "./credentials.js";
import { redactCredentials } from "./redact.js";
import {
  StaleCommitError,
  ReviewRetrievalError,
  type ReviewWorkspaceOperations,
  type WorkspaceResult,
} from "./workspace.js";

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
  /** Ingestion repository bundle; the worker never names a Prisma client. */
  repositories: IngestionRepositories;
  service: ReviewWorkspaceOperations;
  logger: Logger;
  /** Review-state transition boundary (durable, injected by bootstrap). */
  transitionReviewState: ReviewStateService["transitionReviewState"];
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

/**
 * A successful or deliberately skipped attempt. Every failure throws:
 *
 *  - retryable failures throw `ReviewJobRetryError` (BullMQ applies the
 *    configured attempts/backoff);
 *  - permanent failures and exhausted retries throw `UnrecoverableError`
 *    after the durable job/review are marked failed.
 *
 * The worker callback must never resolve a failed attempt, because BullMQ would
 * treat that as success and silently drop the retry budget.
 */
export type ProcessOutcome = "processed" | "skipped_superseded" | "skipped_status";

/** Attempt context supplied by the BullMQ callback (1-based). */
export interface ReviewJobAttempt {
  attempt: number;
  maxAttempts: number;
}

/** Direct callers (tests, scripts) process exactly one attempt. */
const SINGLE_ATTEMPT: ReviewJobAttempt = { attempt: 1, maxAttempts: 1 };

/**
 * Retryable attempt failure. BullMQ retries any ordinary Error, so this class
 * intentionally does not extend its `UnrecoverableError`.
 */
export class ReviewJobRetryError extends Error {
  readonly failureClass: FailureClass;

  constructor(message: string, failureClass: FailureClass) {
    super(message);
    this.name = "ReviewJobRetryError";
    this.failureClass = failureClass;
  }
}

export async function processReviewJob(
  jobId: string,
  payload: ReviewJobPayload,
  deps: ProcessReviewJobDeps,
  attempt: ReviewJobAttempt = SINGLE_ATTEMPT,
): Promise<ProcessOutcome> {
  const { repositories, logger } = deps;
  const foundJob = await repositories.reviewJobs.findWithReview(jobId);
  if (!foundJob) {
    logger.warn({ jobId }, "ReviewJob row missing for queue job; failing permanently");
    throw new UnrecoverableError(`ReviewJob '${jobId}' not found`);
  }
  const job = { ...foundJob.job, review: foundJob.review };

  // Stale/outdated job supersede check (ticket 03 §4.4 handoff): a superseded
  // job is dead on arrival — no workspace, no clone, no token minting.
  if (job.status === "superseded") {
    logger.info({ jobId, reviewId: job.reviewId }, "Review job superseded before processing; skipping");
    return "skipped_superseded";
  }
  // A terminal review is already decided; do not claim a processing slot for it.
  if (isTerminalReviewState(job.review.state)) {
    logger.info(
      { jobId, reviewId: job.reviewId, state: job.review.state },
      "Review already terminal before processing; skipping",
    );
    // Mirror the terminal review onto the durable job instead of leaving a
    // stale `enqueued`/`processing` row that no recovery scan can finish.
    await repositories.reviewJobs.update(job.id, { status: terminalJobStatus(job.review.state) }).catch(() => {
      /* row already gone or concurrently updated */
    });
    return "skipped_status";
  }
  // Claim the durable row atomically instead of trusting the snapshot read
  // above. The outbox publisher commits `enqueued` in Postgres and only then
  // (in the old ordering) made the queue job visible, so an idle worker could
  // legitimately observe `pending_outbox` for an in-flight job and discard it
  // as "not processable" — BullMQ then treats the skip as a successful run.
  // `processing` stays claimable so a stalled/retried delivery can resume.
  const claimed = await repositories.reviewJobs.claimForProcessing(job.id);
  if (!claimed) {
    logger.info({ jobId, status: job.status }, "Review job not in a processable state; skipping");
    return "skipped_status";
  }

  // A retry (or a stalled delivery) may resume with the review left in a
  // mid-pipeline state. Recovery is the only sanctioned backward move: reset
  // to `queued` (with an audit transition) before the forward state machine
  // runs again. A terminal review — e.g. concurrently superseded — is never
  // resurrected.
  const reviewState = await repositories.reviews.findStateById(job.reviewId);
  if (reviewState === null) {
    throw new UnrecoverableError(`Review '${job.reviewId}' not found`);
  }
  if (isTerminalReviewState(reviewState)) {
    logger.info({ jobId, reviewId: job.reviewId, state: reviewState }, "Review already terminal; skipping queue job");
    // Keep the durable row consistent with the review instead of leaving a
    // claimed `processing` row that no recovery scan can ever finish.
    await repositories.reviewJobs.update(job.id, { status: terminalJobStatus(reviewState) }).catch(() => {
      /* row already gone or concurrently updated */
    });
    return "skipped_status";
  }
  if (reviewState !== "queued") {
    await repositories.reviews.resetForRecovery(job.reviewId);
  }

  let span: ReturnType<typeof startSpan> | undefined;
  let activeStage: StageTracker | undefined;
  try {
    await deps.transitionReviewState(job.reviewId, "preparing");
    await deps.transitionReviewState(job.reviewId, "cloning");

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
    const baseRef = baseSha
      ? null
      : await repositories.repositories.findDefaultBranchByGithubId(job.review.githubRepositoryId);

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

    await deps.transitionReviewState(job.reviewId, "analyzing");

    // Ticket 07: the review engine runs inside the hook (workspace is still
    // present; it is disposed afterwards per repository.workspace config).
    const analyzeStage = startStage(reviewLogger, "analyze");
    activeStage = analyzeStage;
    await deps.onWorkspacePrepared?.({ payload, workspace });
    analyzeStage.end();
    activeStage = undefined;

    await deps.service.cleanupAfterReview(job.reviewId);
    // A successful retry must not retain the previous attempt's failure text.
    await repositories.reviewJobs.update(job.id, { status: "completed", lastError: null });
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
    // ONE decision point for queue retries: the shared `AppError` classifier
    // plus the configuration-aware observability policy (see retry.ts).
    const decision = classifyQueueFailure({
      error,
      errorCode: errorCode ?? null,
      message,
      policy: deps.retryPolicy ?? DEFAULT_RETRY_POLICY_CONFIG,
    });
    const retriesRemaining = decision.retryable && attempt.attempt < attempt.maxAttempts;
    const retriesExhausted = decision.retryable && !retriesRemaining;
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
        error_code: decision.errorCode,
        failure_class: decision.failureClass,
        attempt: attempt.attempt,
        max_attempts: attempt.maxAttempts,
        retry_decision: {
          retry: retriesRemaining,
          maxAttempts: decision.maxAttempts,
          backoff: decision.backoff,
          reason: decision.reason,
        },
      },
      retriesRemaining ? "Review attempt failed; BullMQ will retry" : "Review failed permanently",
    );
    if (span) {
      endSpan(span, error);
    }
    await deps.service.cleanupAfterFailure(job.reviewId, message).catch(() => {
      /* cleanup is best-effort */
    });

    // A concurrent supersede/completion may have made the review terminal while
    // this attempt was running. Never resurrect or overwrite that outcome.
    const currentState = await repositories.reviews.findStateById(job.reviewId).catch(() => null);
    if (currentState !== null && isTerminalReviewState(currentState)) {
      logger.info(
        { jobId, reviewId: job.reviewId, state: currentState },
        "Review became terminal during processing; not retrying",
      );
      throw new UnrecoverableError(message);
    }

    if (retriesRemaining) {
      // Keep the durable job claimable for the next BullMQ attempt and leave
      // the review in `queued` so the forward state machine can run again.
      await repositories.reviewJobs.update(job.id, { lastError: message.slice(0, 500) }).catch(() => {
        /* row already gone; the queue retry still owns the work */
      });
      if (currentState !== null && currentState !== "queued") {
        await repositories.reviews.resetForRecovery(job.reviewId).catch(() => {
          /* next attempt normalizes the state again */
        });
      }
      throw new ReviewJobRetryError(message, decision.failureClass);
    }

    // Terminal failure: permanent by classification, or the attempt budget is
    // exhausted. Record the stable code on both durable rows before failing the
    // queue job so reconciliation never has to guess why it stopped.
    getMetricsRegistry().reviewsFailed.inc(1, { failure_class: decision.failureClass });
    try {
      await deps.transitionReviewState(job.reviewId, "failed", {
        errorCode: retriesExhausted ? "retry_exhausted" : terminalErrorCode(error),
        errorMessage: message.slice(0, 500),
      });
    } catch {
      // Review may already be in a terminal state (e.g. superseded) — fine.
    }
    await repositories.reviewJobs.markFailedUnlessTerminal(job.id, message.slice(0, 500)).catch(() => {
      /* row already gone or already terminal */
    });
    throw new UnrecoverableError(message);
  }
}

/** Stable durable code for a terminal failure (no retry remains). */
function terminalErrorCode(error: unknown): string {
  if (error instanceof ReviewRetrievalError || error instanceof AgentRuntimeError) {
    return error.code;
  }
  if (error instanceof AppError) {
    return error.code;
  }
  return "retrieval_failed";
}

/** Mirror an already-terminal review onto a queue job that arrived late. */
function terminalJobStatus(state: ReviewState): "completed" | "failed" | "superseded" {
  if (state === "completed" || state === "completed_with_warnings") {
    return "completed";
  }
  if (state === "superseded") {
    return "superseded";
  }
  return "failed";
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
    const row = await deps.repositories.reviewJobs.findById(jobId);
    if (!row || row.status === "superseded" || row.status === "completed") {
      return;
    }
    await deps.repositories.reviewJobs.markFailedUnlessTerminal(jobId, reason);
    await deps
      .transitionReviewState(row.reviewId, "failed", {
        errorCode: error.code,
        errorMessage: reason,
      })
      .catch(() => {
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
 * Start the BullMQ review worker on a connection created by the composition
 * root. The connection is configured for blocking commands
 * (`maxRetriesPerRequest: null`); it is closed separately on shutdown.
 */
export function startReviewWorker(connection: Redis, deps: ProcessReviewJobDeps): Worker<ReviewJobPayload> {
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
      // BullMQ supplies the retry context: attemptsMade is the count of failed
      // attempts so far, so the current attempt is attemptsMade + 1.
      return processReviewJob(job.id, payload, deps, {
        attempt: job.attemptsMade + 1,
        maxAttempts: job.opts.attempts ?? 1,
      });
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
