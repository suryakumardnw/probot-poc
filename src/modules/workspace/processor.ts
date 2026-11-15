import type { Logger } from "../../ports/logger.js";
import { reviewSpanAttributes, type Observability, type ReviewSpan } from "../../ports/observability.js";
import type { ReviewJobAttempt, ReviewJobProcessor } from "../../ports/review-job-processor.js";
import {
  createReviewLogger,
  startStage,
  type ReviewCorrelation,
  type StageTracker,
} from "../../ports/review-logging.js";
import { AppError, AgentRuntimeError, UnrecoverableJobError } from "../../shared/errors/index.js";
import {
  classifyQueueFailure,
  DEFAULT_RETRY_POLICY_CONFIG,
  type FailureClass,
  type RetryPolicyConfig,
} from "../../shared/retry.js";
import {
  isTerminalReviewState,
  type ReviewJobPayload,
  type ReviewJobService,
  type ReviewResetResult,
  type ReviewState,
  type ReviewStateService,
} from "../ingestion/index.js";
import { redactCredentials } from "./redact.js";
import { ReviewRetrievalError, type ReviewWorkspaceOperations, type WorkspaceResult } from "./workspace.js";

/** Max characters of error detail attached to the structured failure log. */
const MAX_LOGGED_ERROR_DETAIL_CHARS = 4_000;

/**
 * Review worker job processor (ticket 04).
 *
 * Consumes durable review jobs from the BullMQ "review-jobs" queue through the
 * `ReviewJobProcessor` port; the queue adapter lives in
 * `src/platform/queue/review-worker.ts`. The BullMQ jobId equals the
 * ReviewJob.id (ticket 03 contract).
 *
 * IMPORTANT (ticket 03 handoff): before doing any work the processor checks
 * the DURABLE job status. A job whose ReviewJob.status is "superseded"
 * (replaced by a newer commit while it sat in the queue) must be skipped —
 * the review has already been superseded in Postgres and must never run.
 */
export interface ProcessReviewJobDeps {
  /** Public ingestion lifecycle service; the worker never names a repository. */
  jobs: ReviewJobService;
  service: ReviewWorkspaceOperations;
  logger: Logger;
  /** Metrics/tracing adapter injected by the composition root. */
  observability: Observability;
  /** Review-state transition boundary (durable, injected by bootstrap). */
  transitionReviewState: ReviewStateService["transitionReviewState"];
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
 *  - retryable failures throw `ReviewJobRetryError` (the queue adapter applies
 *    the configured attempts/backoff);
 *  - permanent failures and exhausted retries throw an unrecoverable error
 *    after the durable job/review are marked failed.
 *
 * The processor must never resolve a failed attempt, because the queue would
 * treat that as success and silently drop the retry budget.
 */
export type ProcessOutcome = "processed" | "skipped_superseded" | "skipped_status";

/** Direct callers (tests, scripts) process exactly one attempt. */
const SINGLE_ATTEMPT: ReviewJobAttempt = { attempt: 1, maxAttempts: 1 };

/**
 * Retryable attempt failure. The BullMQ adapter retries any ordinary Error, so
 * this class intentionally does not extend its `UnrecoverableError`.
 */
export class ReviewJobRetryError extends Error {
  readonly failureClass: FailureClass;

  constructor(message: string, failureClass: FailureClass) {
    super(message);
    this.name = "ReviewJobRetryError";
    this.failureClass = failureClass;
  }
}

/** Bounded retries when a concurrent writer advances the review mid-reset. */
const RECOVERY_RESET_MAX_ATTEMPTS = 3;

/**
 * Reset a mid-pipeline review before a retried attempt runs again. The
 * repository guard refuses terminal reviews and only resets the state it
 * observed, so a concurrent supersede/completion is never overwritten.
 */
async function resetReviewForProcessing(jobs: ReviewJobService, reviewId: string): Promise<ReviewResetResult> {
  let result = await jobs.resetForRecovery(reviewId);
  for (
    let attempt = 1;
    attempt < RECOVERY_RESET_MAX_ATTEMPTS &&
    result.outcome === "conflict" &&
    !isTerminalReviewState(result.currentState);
    attempt += 1
  ) {
    result = await jobs.resetForRecovery(reviewId);
  }
  return result;
}

export async function processReviewJob(
  jobId: string,
  payload: ReviewJobPayload,
  deps: ProcessReviewJobDeps,
  attempt: ReviewJobAttempt = SINGLE_ATTEMPT,
): Promise<ProcessOutcome> {
  const { jobs, logger } = deps;
  const job = await jobs.findWithReview(jobId);
  if (!job) {
    logger.warn({ jobId }, "ReviewJob row missing for queue job; failing permanently");
    throw new UnrecoverableJobError(`ReviewJob '${jobId}' not found`);
  }

  // Stale/outdated job supersede check (ticket 03 §4.4 handoff): a superseded
  // job is dead on arrival — no workspace, no clone, no token minting.
  if (job.jobStatus === "superseded") {
    logger.info({ jobId, reviewId: job.reviewId }, "Review job superseded before processing; skipping");
    return "skipped_superseded";
  }
  // A terminal review is already decided; do not claim a processing slot for it.
  if (isTerminalReviewState(job.reviewState)) {
    logger.info(
      { jobId, reviewId: job.reviewId, state: job.reviewState },
      "Review already terminal before processing; skipping",
    );
    // Mirror the terminal review onto the durable job instead of leaving a
    // stale `enqueued`/`processing` row that no recovery scan can finish.
    await jobs.update(job.jobId, { status: terminalJobStatus(job.reviewState) }).catch(() => {
      /* row already gone or concurrently updated */
    });
    return "skipped_status";
  }
  // Claim the durable row atomically instead of trusting the snapshot read
  // above. The outbox publisher commits `enqueued` in Postgres and only then
  // (in the old ordering) made the queue job visible, so an idle worker could
  // legitimately observe `pending_outbox` for an in-flight job and discard it
  // as "not processable" — the queue then treats the skip as a successful run.
  // `processing` stays claimable so a stalled/retried delivery can resume.
  const claimed = await jobs.claimForProcessing(job.jobId);
  if (!claimed) {
    logger.info({ jobId, status: job.jobStatus }, "Review job not in a processable state; skipping");
    return "skipped_status";
  }

  // A retry (or a stalled delivery) may resume with the review left in a
  // mid-pipeline state. Recovery is the only sanctioned backward move: reset
  // to `queued` (with an audit transition) before the forward state machine
  // runs again. A terminal review — e.g. concurrently superseded — is never
  // resurrected.
  const reviewState = await jobs.findReviewState(job.reviewId);
  if (reviewState === null) {
    throw new UnrecoverableJobError(`Review '${job.reviewId}' not found`);
  }
  if (isTerminalReviewState(reviewState)) {
    logger.info({ jobId, reviewId: job.reviewId, state: reviewState }, "Review already terminal; skipping queue job");
    // Keep the durable row consistent with the review instead of leaving a
    // claimed `processing` row that no recovery scan can ever finish.
    await jobs.update(job.jobId, { status: terminalJobStatus(reviewState) }).catch(() => {
      /* row already gone or concurrently updated */
    });
    return "skipped_status";
  }
  if (reviewState !== "queued") {
    const reset = await resetReviewForProcessing(jobs, job.reviewId);
    if (reset.outcome === "not_found") {
      throw new UnrecoverableJobError(`Review '${job.reviewId}' not found`);
    }
    if (reset.outcome === "conflict") {
      if (isTerminalReviewState(reset.currentState)) {
        logger.info(
          { jobId, reviewId: job.reviewId, state: reset.currentState },
          "Review became terminal before recovery reset; skipping queue job",
        );
        // Keep the durable row consistent with the decided review.
        await jobs.update(job.jobId, { status: terminalJobStatus(reset.currentState) }).catch(() => {
          /* row already gone or concurrently updated */
        });
        return "skipped_status";
      }
      // A concurrent writer kept advancing the review. Do not drive the
      // forward state machine from an unknown predecessor; let the queue retry.
      throw new ReviewJobRetryError(`review '${job.reviewId}' kept advancing before recovery reset`, "unknown");
    }
  }

  let span: ReviewSpan | undefined;
  let activeStage: StageTracker | undefined;
  try {
    await deps.transitionReviewState(job.reviewId, "preparing");
    await deps.transitionReviewState(job.reviewId, "cloning");

    const correlation: ReviewCorrelation = {
      review_id: job.reviewId,
      job_id: job.jobId,
      repository: payload.repositoryFullName,
      pull_request_number: payload.pullRequestNumber,
      head_sha: payload.headSha,
    };
    const reviewLogger = createReviewLogger(logger, correlation);
    const metrics = deps.observability.metrics;
    metrics.recordReviewStarted();
    const enqueuedAt = job.jobCreatedAt;
    metrics.observeQueueWait(Math.max(0, (Date.now() - enqueuedAt.getTime()) / 1000));

    span = deps.observability.tracing.startSpan("review.process", reviewSpanAttributes(correlation));

    const cloneStage = startStage(reviewLogger, "clone");
    activeStage = cloneStage;
    // Base commit resolution: prefer the exact base SHA captured at ingestion.
    // Manual `/review` requests (and older jobs) may have none, so fall back to
    // the repository's default branch instead of failing the clone outright.
    const baseSha = payload.baseSha ?? job.reviewBaseSha ?? null;
    const baseRef = baseSha ? null : await jobs.findDefaultBranch(job.githubRepositoryId);

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
    await jobs.update(job.jobId, { status: "completed", lastError: null });
    span.end();
    deps.observability.metrics.recordReviewCompleted("processed");
    deps.observability.metrics.observeReviewDuration((Date.now() - enqueuedAt.getTime()) / 1000);
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
      job_id: job.jobId,
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
      retriesRemaining ? "Review attempt failed; the queue will retry" : "Review failed permanently",
    );
    if (span) {
      span.end(error);
    }
    await deps.service.cleanupAfterFailure(job.reviewId, message).catch(() => {
      /* cleanup is best-effort */
    });

    // A concurrent supersede/completion may have made the review terminal while
    // this attempt was running. Never resurrect or overwrite that outcome.
    const currentState = await jobs.findReviewState(job.reviewId).catch(() => null);
    if (currentState !== null && isTerminalReviewState(currentState)) {
      logger.info(
        { jobId, reviewId: job.reviewId, state: currentState },
        "Review became terminal during processing; not retrying",
      );
      // Mirror the decided review onto the durable job before failing the
      // queue job, otherwise a stale-head/findings-persistence failure leaves
      // the job row stuck in `processing` forever.
      await jobs.update(job.jobId, { status: terminalJobStatus(currentState) }).catch(() => {
        /* row already gone or concurrently updated */
      });
      throw new UnrecoverableJobError(message);
    }

    if (retriesRemaining) {
      // Keep the durable job claimable for the next attempt and leave the
      // review in `queued` so the forward state machine can run again.
      await jobs.update(job.jobId, { lastError: message.slice(0, 500) }).catch(() => {
        /* row already gone; the queue retry still owns the work */
      });
      if (currentState !== null && currentState !== "queued") {
        const reset = await jobs.resetForRecovery(job.reviewId).catch(() => null);
        if (reset?.outcome === "conflict" && isTerminalReviewState(reset.currentState)) {
          logger.info(
            { jobId, reviewId: job.reviewId, state: reset.currentState },
            "Review became terminal before retry reset; not retrying",
          );
          // The claimed job row must not stay `processing` when the review is
          // already terminal; mirror the terminal review before failing.
          await jobs.update(job.jobId, { status: terminalJobStatus(reset.currentState) }).catch(() => {
            /* row already gone or concurrently updated */
          });
          throw new UnrecoverableJobError(message);
        }
      }
      throw new ReviewJobRetryError(message, decision.failureClass);
    }

    // Terminal failure: permanent by classification, or the attempt budget is
    // exhausted. Record the stable code on both durable rows before failing the
    // queue job so reconciliation never has to guess why it stopped.
    deps.observability.metrics.recordReviewFailed(decision.failureClass);
    try {
      await deps.transitionReviewState(job.reviewId, "failed", {
        errorCode: retriesExhausted ? "retry_exhausted" : terminalErrorCode(error),
        errorMessage: message.slice(0, 500),
      });
    } catch {
      // Review may already be in a terminal state (e.g. superseded) — fine.
    }
    await jobs.markFailedUnlessTerminal(job.jobId, message.slice(0, 500)).catch(() => {
      /* row already gone or already terminal */
    });
    throw new UnrecoverableJobError(message);
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
 * code and the queue adapter fails the job without retries. A
 * superseded/completed job is left untouched — its review already reached a
 * terminal state for another reason.
 */
async function failMalformedReviewJob(deps: ProcessReviewJobDeps, jobId: string, error: AppError): Promise<void> {
  const reason = `${error.code}: ${error.message}`.slice(0, 500);
  try {
    const row = await deps.jobs.findById(jobId);
    if (!row || row.status === "superseded" || row.status === "completed") {
      return;
    }
    await deps.jobs.markFailedUnlessTerminal(jobId, reason);
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
 * Bind the workspace processor to the queue-adapter port. The queue adapter
 * owns BullMQ; this factory owns what one attempt means.
 */
export function createReviewJobProcessor(deps: ProcessReviewJobDeps): ReviewJobProcessor {
  return {
    process: (jobId, payload, attempt) => processReviewJob(jobId, payload, deps, attempt),
    failInvalidPayload: (jobId, error) => failMalformedReviewJob(deps, jobId, error),
  };
}
