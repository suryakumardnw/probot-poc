/**
 * Temporary compatibility re-export.
 *
 * The structured review result schemas moved to `src/contracts/review.ts`.
 * Import from there in new code; this shim keeps existing consumers working.
 */

export {
  analysisOutputSchema,
  findingSchema,
  reviewResultSchema,
  type ParsedAnalysisOutput,
  type ParsedReviewResult,
} from "../../contracts/review.js";
