import type { ReviewTypeValue } from "../../contracts/queue.js";

/**
 * Publishing repository ports (ARCHITECTURE.md §7.4, §13.1).
 *
 * The publishing service and pipeline speak the records below. Prisma rows,
 * BigInt ids and transaction clients stay inside the adapter, so a storage
 * change never reaches publication logic.
 */

// ---------------------------------------------------------------------------
// Domain enumerations (mirror the Prisma enums without importing them)
// ---------------------------------------------------------------------------

export type ReviewCommentType = "summary" | "inline";
export type ReviewCommentStatus = "published" | "failed" | "superseded";

// ---------------------------------------------------------------------------
// Review-comment records
// ---------------------------------------------------------------------------

/** A published inline comment, keyed by the finding fingerprint. */
export type PublishedFingerprintRecord = {
  fingerprint: string;
  /** GitHub comment id from the earlier publication attempt, when known. */
  githubCommentId: number | null;
};

export type RecordSummaryPublication = {
  githubCommentId: number;
};

export type RecordInlinePublication = {
  findingId: string;
  fingerprint: string;
  /** GitHub echoes the comment body; the id is unknown when it did not. */
  githubCommentId: number | null;
};

export type RecordPublicationInput = {
  reviewId: string;
  /** Present only when a new summary row must be recorded. */
  summary: RecordSummaryPublication | null;
  inlineComments: readonly RecordInlinePublication[];
};

// ---------------------------------------------------------------------------
// Review publication-state records
// ---------------------------------------------------------------------------

export type ReviewPublicationContext = {
  reviewId: string;
  reviewType: ReviewTypeValue;
  /** Repository id needed by findings persistence. */
  repositoryId: string;
};

export type RecordReviewUsageInput = {
  reviewId: string;
  inputTokens: number;
  outputTokens: number;
};

// ---------------------------------------------------------------------------
// Repository ports
// ---------------------------------------------------------------------------

export interface ReviewCommentRepository {
  /**
   * Published inline-comment fingerprints for one review. Used to reconcile a
   * retry with comments created by an earlier attempt.
   */
  listPublishedFingerprints(reviewId: string): Promise<PublishedFingerprintRecord[]>;
  /** GitHub review id of the published summary row, if one was recorded. */
  findPublishedSummaryCommentId(reviewId: string): Promise<number | null>;
  /**
   * Record one completed publication. The summary and every inline row commit
   * or roll back together, so a retry never sees half a publication.
   */
  recordPublication(input: RecordPublicationInput): Promise<void>;
  /** Best-effort marker that publication failed (no GitHub id exists). */
  recordFailure(reviewId: string): Promise<void>;
}

export interface ReviewPublicationRepository {
  /** Review identity and repository needed after findings persistence. */
  findReviewContext(reviewId: string): Promise<ReviewPublicationContext | null>;
  /** Record that the review-type publishing gate skipped GitHub publication. */
  markPublishSkipped(reviewId: string): Promise<void>;
  /** Persist aggregate token usage once the review reaches a terminal state. */
  recordUsage(input: RecordReviewUsageInput): Promise<void>;
}

export interface PublishingRepositories {
  comments: ReviewCommentRepository;
  reviews: ReviewPublicationRepository;
}
