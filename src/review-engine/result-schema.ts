/**
 * Temporary compatibility re-export.
 *
 * The structured review result schemas moved to `src/contracts/review.ts`.
 * Import from there in new code; this shim keeps existing review-engine
 * consumers working until PR 3.4 removes the review-engine-local module.
 */

export {
  analysisOutputSchema,
  findingSchema,
  reviewResultSchema,
  type ParsedAnalysisOutput,
  type ParsedReviewResult,
} from "../contracts/review.js";
