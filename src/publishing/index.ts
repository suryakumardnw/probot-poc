/**
 * GitHub review publishing (ticket 09). Public surface used by the review
 * pipeline, the worker and downstream tickets.
 */
export {
  parseUnifiedDiff,
  resolveInlinePosition,
  newSideLines,
  oldSideLines,
  type DiffLine,
  type DiffHunk,
  type ParsedDiffFile,
  type InlinePosition,
  type InlineResolution,
} from "./diff-positions.js";
export {
  fingerprintMarker,
  extractFingerprint,
  buildReviewBody,
  buildInlineCommentBody,
  type FindingsBodyInput,
  type ReviewBodyMeta,
} from "./summary.js";
export type {
  CreatedReview,
  CreatedReviewResponse,
  PublisherOctokit,
  ReviewCommentParams,
} from "../ports/github-publisher.js";
export {
  StaleHeadError,
  createGitHubOctokit,
  publishReview,
  recordPublicationFailure,
  withRetry,
  appendSummaryMarker,
  DEFAULT_RETRY,
  isRetryableGitHubError,
  type PublishOutcome,
  type PublishReviewResult,
  type PublishReviewInput,
  type RetryOptions,
} from "./publisher.js";
export type {
  PublishedFingerprintRecord,
  PublishingRepositories,
  RecordInlinePublication,
  RecordPublicationInput,
  RecordReviewUsageInput,
  RecordSummaryPublication,
  ReviewCommentRepository,
  ReviewCommentStatus,
  ReviewCommentType,
  ReviewPublicationContext,
  ReviewPublicationRepository,
} from "./publishing.repository.js";
export { createPublishingRepositories } from "./prisma-publishing.repository.js";
export {
  createReviewPipelineHook,
  type ReviewKnowledgeDependencies,
  type ReviewPipelineDeps,
  type ReviewPipelineHook,
} from "./pipeline.js";
