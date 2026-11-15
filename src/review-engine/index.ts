/**
 * Review engine module barrel (ARCHITECTURE.md §5.2–§5.4, §6, §7.1).
 *
 * Application code (worker wiring, downstream tickets 08/09) imports the
 * engine exclusively from here — internal modules are not part of the
 * public contract, only the types and the two entry points are.
 */

export { runReview, normalizeFindings, assertWorkspaceReviewable } from "./engine.js";
export { createReviewPlan, skippedStageIds } from "./plan.js";
export { scoreComplexity } from "./complexity.js";
export {
  RetrievalBudget,
  fulfillToolRequests,
  parseToolRequests,
  renderToolContext,
  MAX_CONTEXT_CHARS,
  type ToolName,
  type ToolRequest,
  type ToolResult,
} from "./tools.js";
export {
  analysisOutputSchema,
  findingSchema,
  reviewResultSchema,
  type ParsedAnalysisOutput,
  type ParsedReviewResult,
} from "../contracts/review.js";
export { createReviewEngineHook, type ReviewEngineHook, type ReviewEngineHookDeps } from "./hook.js";
export type {
  ComplexityFactor,
  ComplexityFactorName,
  ComplexityScore,
  ComplexityTier,
  Finding,
  FindingCategory,
  FindingEvidence,
  FindingSeverity,
  KnowledgeInjectionMetrics,
  ModelCallUsage,
  PlannedStage,
  PromptInjection,
  RetrievalUsage,
  ReviewInput,
  ReviewPlan,
  ReviewPlanBudgets,
  ReviewResult,
  ReviewRunMetadata,
  RunReviewOutput,
  StageId,
} from "./types.js";
export { FINDING_CATEGORIES, ReviewEngineError } from "./types.js";
