/**
 * Adaptive review planner (ARCHITECTURE.md §5.4, §6.1).
 *
 * Turns a complexity score into an investigation plan: which stages run,
 * which are skipped (with an auditable justification) and the budgets the
 * engine must enforce (model calls, retrievals, tokens, timeout).
 */

import type { ReviewConfig } from "../config/review-schema.js";
import type { ComplexityScore, PlannedStage, ReviewPlan, ReviewPlanBudgets, StageId } from "./types.js";

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Tier → budget multipliers (§5.4: complexity influences all budgets). */
const TIER_BUDGETS = {
  low: { maxModelCalls: 2, maxFileRetrievals: 4, tokenShare: 0.5, timeoutShare: 0.25, verify: false },
  medium: { maxModelCalls: 4, maxFileRetrievals: 12, tokenShare: 0.75, timeoutShare: 0.5, verify: true },
  high: { maxModelCalls: 6, maxFileRetrievals: 30, tokenShare: 1, timeoutShare: 1, verify: true },
} as const;

/**
 * Build the review plan. Stage skipping is always justified in the plan so
 * the decision is auditable (completion evidence for ticket 07).
 */
export function createReviewPlan(complexity: ComplexityScore, config: ReviewConfig): ReviewPlan {
  const tier = complexity.tier;
  const tierBudgets = TIER_BUDGETS[tier];

  // Absolute caps from agent.context always win over tier scaling (§11.3).
  const budgets: ReviewPlanBudgets = {
    maxModelCalls: Math.min(tierBudgets.maxModelCalls, Math.max(1, config.agent.context.maxRetrievalCalls)),
    maxFileRetrievals: Math.min(
      tierBudgets.maxFileRetrievals,
      config.agent.context.maxFiles,
      config.agent.context.maxRetrievalCalls,
    ),
    maxInputTokens: Math.max(1_000, Math.floor(config.agent.context.maxInputTokens * tierBudgets.tokenShare)),
    maxOutputTokens: Math.min(config.agent.context.maxOutputTokens, config.provider.maxOutputTokens),
    timeoutMs: clamp(
      Math.floor(config.agent.runtime.timeoutMs * tierBudgets.timeoutShare),
      30_000,
      config.agent.runtime.timeoutMs,
    ),
  };

  const risky = complexity.factors
    .filter((f) => ["riskyCode", "concurrency", "dataIntegrity"].includes(f.name))
    .reduce((sum, f) => sum + f.subscore, 0);

  const stages: PlannedStage[] = [
    {
      id: "initial-analysis",
      enabled: true,
      justification: "always runs: the diff must be understood before any plan",
    },
    {
      id: "context-investigation",
      enabled: tier !== "low" || risky > 0,
      justification:
        tier === "low" && risky === 0
          ? `skipped: low-complexity isolated change (score ${complexity.score}) with no risk-sensitive, concurrency or data-integrity signals`
          : `runs: tier '${tier}' (score ${complexity.score})${risky > 0 ? " with risk-sensitive signals" : ""}`,
    },
    {
      id: "finding-verification",
      enabled: config.review.strategy.verifyFindings && tierBudgets.verify,
      justification: !config.review.strategy.verifyFindings
        ? "skipped: review.strategy.verifyFindings is disabled in configuration"
        : tierBudgets.verify
          ? `runs: tier '${tier}' — findings are rechecked against retrieved source before publication`
          : "skipped: low-complexity change; findings are reported directly with derived confidence",
    },
    {
      id: "reporting-prep",
      enabled: true,
      justification: "always runs: the structured review result must be produced",
    },
  ];

  return { complexity, tier, stages, budgets };
}

export function skippedStageIds(plan: ReviewPlan): StageId[] {
  return plan.stages.filter((stage) => !stage.enabled).map((stage) => stage.id);
}
