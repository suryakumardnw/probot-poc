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
export {
  StaleHeadError,
  createGitHubOctokit,
  publishReview,
  recordPublicationFailure,
  withRetry,
  appendSummaryMarker,
  DEFAULT_RETRY,
  type PublisherOctokit,
  type ReviewCommentParams,
  type PublishOutcome,
  type PublishReviewResult,
  type PublishReviewInput,
  type RetryOptions,
} from "./publisher.js";
export {
  createReviewPipelineHook,
  type ReviewPipelineDeps,
  type ReviewPipelineHook,
} from "./pipeline.js";
