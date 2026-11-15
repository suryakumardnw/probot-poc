/**
 * Temporary compatibility re-export.
 *
 * The structured review result schemas moved to `src/contracts/review.ts`.
 * Import from there in new code; this shim keeps existing consumers working
 * until PR 3.12 removes the review-module-local compatibility module.
 */

export {
  analysisOutputSchema,
  findingSchema,
  reviewResultSchema,
  type ParsedAnalysisOutput,
  type ParsedReviewResult,
} from "../../contracts/review.js";
