import type { JobStatus, ReviewState } from "./ingestion.repository.js";
import type { IngestionRepositories } from "./ingestion.unit-of-work.js";

/**
 * Durable review-job lifecycle service (ARCHITECTURE.md §4.4, §12.4).
 *
 * The workspace worker owns retrieval, not persistence. This service exposes
 * the narrow job/review operations it needs — read the job context, claim an
 * attempt, observe or reset review state, resolve the default branch, and mark
 * a terminal failure — so the workspace module never imports another module's
 * repository ports.
 */

/** Processing context for one durable job. */
export type ReviewJobContext = {
  jobId: string;
  reviewId: string;
  jobStatus: JobStatus;
  jobCreatedAt: Date;
  reviewState: ReviewState;
  reviewBaseSha: string | null;
  githubRepositoryId: bigint;
};

/** Minimal durable row used by the malformed-payload failure path. */
export type ReviewJobReference = {
  id: string;
  reviewId: string;
  status: JobStatus;
};

export type ReviewJobUpdate = {
  status?: JobStatus;
  lastError?: string | null;
};

export type ReviewResetResult =
  | { outcome: "reset" | "unchanged" }
  | { outcome: "not_found" }
  /** A terminal review won the race; recovery never moves it backwards. */
  | { outcome: "conflict"; currentState: ReviewState };

export interface ReviewJobService {
  /** Durable job plus the review fields needed to process one attempt. */
  findWithReview(jobId: string): Promise<ReviewJobContext | null>;
  /** Durable row without review context (malformed-payload checks). */
  findById(jobId: string): Promise<ReviewJobReference | null>;
  /**
   * Atomically claim a processable job (`pending_outbox`/`enqueued`/
   * `processing`) and increment its attempt counter. False when another worker
   * already owns it or it is terminal.
   */
  claimForProcessing(jobId: string): Promise<boolean>;
  findReviewState(reviewId: string): Promise<ReviewState | null>;
  /** Sanctioned recovery reset to `queued`; terminal reviews are refused. */
  resetForRecovery(reviewId: string): Promise<ReviewResetResult>;
  update(jobId: string, patch: ReviewJobUpdate): Promise<void>;
  /** Fail a job unless a concurrent actor already made it terminal. */
  markFailedUnlessTerminal(jobId: string, lastError: string): Promise<void>;
  /** Default branch for clone base resolution when no base SHA is known. */
  findDefaultBranch(githubRepositoryId: bigint): Promise<string | null>;
}

export type ReviewJobServiceDependencies = {
  repositories: IngestionRepositories;
};

export function createReviewJobService(deps: ReviewJobServiceDependencies): ReviewJobService {
  return {
    async findWithReview(jobId: string): Promise<ReviewJobContext | null> {
      const row = await deps.repositories.reviewJobs.findWithReview(jobId);
      if (!row) {
        return null;
      }
      return {
        jobId: row.job.id,
        reviewId: row.review.id,
        jobStatus: row.job.status,
        jobCreatedAt: row.job.createdAt,
        reviewState: row.review.state,
        reviewBaseSha: row.review.baseSha,
        githubRepositoryId: row.review.githubRepositoryId,
      };
    },

    async findById(jobId: string): Promise<ReviewJobReference | null> {
      const row = await deps.repositories.reviewJobs.findById(jobId);
      if (!row) {
        return null;
      }
      return { id: row.id, reviewId: row.reviewId, status: row.status };
    },

    claimForProcessing(jobId: string): Promise<boolean> {
      return deps.repositories.reviewJobs.claimForProcessing(jobId);
    },

    findReviewState(reviewId: string): Promise<ReviewState | null> {
      return deps.repositories.reviews.findStateById(reviewId);
    },

    async resetForRecovery(reviewId: string): Promise<ReviewResetResult> {
      const result = await deps.repositories.reviews.resetForRecovery(reviewId);
      switch (result.outcome) {
        case "reset":
        case "unchanged":
          return { outcome: result.outcome };
        case "not_found":
          return { outcome: "not_found" };
        case "conflict":
          return { outcome: "conflict", currentState: result.currentState };
      }
    },

    update(jobId: string, patch: ReviewJobUpdate): Promise<void> {
      return deps.repositories.reviewJobs.update(jobId, patch);
    },

    markFailedUnlessTerminal(jobId: string, lastError: string): Promise<void> {
      return deps.repositories.reviewJobs.markFailedUnlessTerminal(jobId, lastError);
    },

    findDefaultBranch(githubRepositoryId: bigint): Promise<string | null> {
      return deps.repositories.repositories.findDefaultBranchByGithubId(githubRepositoryId);
    },
  };
}
