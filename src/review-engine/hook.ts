/**
 * Wiring of the adaptive review engine into the review worker lifecycle
 * (ticket 07). The hook consumes the prepared workspace (ticket 04), drives
 * the staged engine over the AgentRuntime (ticket 06) and advances the
 * durable review state machine:
 *
 *   analyzing → investigating → (engine run) → validating
 *
 * Publication (publishing → completed) is ticket 09; finding persistence is
 * ticket 08 — the hook only reports the redacted run summary here.
 *
 * Failure semantics: any AgentRuntimeError / ReviewEngineError propagates so
 * the processor fails the review immediately (fail-immediately; §8.4).
 */
import type pino from "pino";
import type { AgentRuntime } from "../agent/types.js";
import type { ReviewConfig } from "../config/review-schema.js";
import type { ReviewJobPayload } from "../ingestion/queue.js";
import { transitionReviewState } from "../ingestion/review-state.js";
import { recordProviderCall, recordReviewFindings } from "../observability/metrics.js";
import { endSpan, reviewSpanAttributes, startSpan } from "../observability/tracing.js";
import { redactCredentials } from "../workspace/redact.js";
import type { WorkspaceResult } from "../workspace/workspace.js";
import { runReview } from "./engine.js";
import type { PromptInjection, RunReviewOutput } from "./types.js";

export interface ReviewEngineHookDeps {
  runtime: AgentRuntime;
  config: ReviewConfig;
  logger: pino.Logger;
}

/**
 * Hook signature matching `ProcessReviewJobDeps.onWorkspacePrepared`
 * (ticket 04 contract).
 */
export type ReviewEngineHook = (ctx: {
  payload: ReviewJobPayload;
  workspace: WorkspaceResult;
  /**
   * Review-type injection (§4.1), resolved by the pipeline before the
   * engine runs; omitted/null for standard reviews.
   */
  promptInjection?: PromptInjection | null;
}) => Promise<RunReviewOutput>;

/**
 * Build the `onWorkspacePrepared` hook that runs the review engine.
 */
export function createReviewEngineHook(deps: ReviewEngineHookDeps): ReviewEngineHook {
  return async (ctx) => {
    const { logger } = deps;
    const { workspace } = ctx;
    const reviewId = ctx.payload.reviewId;
    await transitionReviewState(reviewId, "investigating");

    const span = startSpan("agent.started", {
      attributes: {
        ...reviewSpanAttributes({
          review_id: reviewId,
          repository: ctx.payload.repositoryFullName,
          pull_request_number: ctx.payload.pullRequestNumber,
          head_sha: ctx.payload.headSha,
        }),
        "agent.runtime": deps.config.agent.runtime.type,
      },
    });

    const modelSpan = startSpan("model.request", {
      attributes: { "agent.runtime": deps.config.agent.runtime.type },
    });

    let output;
    try {
      output = await runReview(
        {
          reviewId,
          workspace,
          promptInjection: ctx.promptInjection ?? null,
          correlation: {
            repository: ctx.payload.repositoryFullName,
            pullRequestNumber: ctx.payload.pullRequestNumber,
          },
        },
        { runtime: deps.runtime, config: deps.config },
      );
    } catch (error) {
      endSpan(modelSpan, error);
      endSpan(span, error);
      throw error;
    }
    endSpan(modelSpan);
    await transitionReviewState(reviewId, "validating");

    // Ticket 12: provider latency / token usage metrics, one record per
    // model call reported by the engine.
    for (const call of output.meta.usage.modelCalls) {
      recordProviderCall({
        durationMs: call.durationMs,
        inputTokens: call.inputTokens,
        outputTokens: call.outputTokens,
      });
    }
    recordReviewFindings({
      findings: output.result.findings,
      uncertainCount: output.result.uncertainFindings.length,
    });
    endSpan(span);

    // Redacted, secret-free run summary. Findings are persisted by
    // ticket 08; publication is ticket 09.
    logger.info(
      {
        reviewId,
        tier: output.meta.plan.tier,
        complexityScore: output.meta.plan.complexity.score,
        skippedStages: output.meta.skippedStages,
        findings: output.result.findings.length,
        uncertainFindings: output.result.uncertainFindings.length,
        modelCalls: output.meta.usage.modelCalls.length,
        totalInputTokens: output.meta.usage.totalInputTokens,
        totalOutputTokens: output.meta.usage.totalOutputTokens,
        durationMs: output.meta.usage.durationMs,
        retrievals: {
          requested: output.meta.retrieval.requested,
          fulfilled: output.meta.retrieval.fulfilled,
          rejected: output.meta.retrieval.rejected,
        },
        violations: output.meta.retrieval.violations.map((v) => redactCredentials(v)),
      },
      "Review engine run completed",
    );
    return output;
  };
}
