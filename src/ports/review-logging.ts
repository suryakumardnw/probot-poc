import type { Logger } from "./logger.js";

/**
 * Review-lifecycle correlation logging (§16.1).
 *
 * Every log line emitted while a review is processed carries the full
 * correlation context: review_id, job_id, repository, pull_request_number,
 * head_sha — plus runtime/provider/model identity when known. Stage helpers
 * add `stage` and `duration_ms` automatically.
 */

export interface ReviewCorrelation {
  review_id: string;
  job_id: string;
  repository: string;
  pull_request_number: number;
  head_sha: string;
  runtime?: string;
  provider?: string;
  model?: string;
}

export type ReviewLogger = Logger;

/**
 * Build a pino child logger carrying the review correlation fields. All
 * downstream pipeline log calls inherit them automatically.
 */
export function createReviewLogger(logger: Logger, correlation: ReviewCorrelation): ReviewLogger {
  // Defensive: tolerate simplified logger stubs (no `child`) in tests.
  if (typeof (logger as unknown as { child?: unknown }).child !== "function") {
    return logger;
  }
  return logger.child(correlation);
}

/** Append runtime/provider/model identity once it is resolved mid-review. */
export function withRuntimeIdentity(
  correlation: ReviewCorrelation,
  identity: { runtime?: string; provider?: string; model?: string },
): ReviewCorrelation {
  return { ...correlation, ...identity };
}

export interface StageTracker {
  /** Log a stage completion with its duration. Returns the elapsed ms. */
  end(extra?: Record<string, unknown>): number;
  /**
   * Log a stage failure with the elapsed time and a sanitized, truncated
   * reason. Returns the elapsed ms. Safe to call at most once.
   */
  fail(error: unknown, extra?: Record<string, unknown>): number;
}

/**
 * Start a stage timer.
 *
 * Emits `review_stage_started` immediately so a long-running stage can never
 * look like a silent hang, then `review_stage_completed` /
 * `review_stage_failed` when the stage ends.
 */
export function startStage(logger: ReviewLogger, stage: string): StageTracker {
  const started = Date.now();
  logger.info({ event: "review_stage_started", stage }, `Review stage started: ${stage}`);
  return {
    end(extra?: Record<string, unknown>): number {
      const durationMs = Date.now() - started;
      logger.info(
        { event: "review_stage_completed", stage, duration_ms: durationMs, ...(extra ?? {}) },
        `Review stage completed: ${stage}`,
      );
      return durationMs;
    },
    fail(error: unknown, extra?: Record<string, unknown>): number {
      const durationMs = Date.now() - started;
      const message = error instanceof Error ? error.message : String(error);
      // Never log the raw error text here: callers pass a sanitized `error`
      // through `extra` (see processReviewJob). Only safe metadata is default.
      logger.error(
        {
          event: "review_stage_failed",
          stage,
          duration_ms: durationMs,
          error_name: error instanceof Error ? error.name : typeof error,
          error_chars: message.length,
          ...(extra ?? {}),
        },
        `Review stage failed: ${stage}`,
      );
      return durationMs;
    },
  };
}
