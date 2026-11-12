/**
 * End-to-end review pipeline wiring (ticket 09).
 *
 * Wraps the ticket 07 engine hook with the ticket 08 persistence step and the
 * ticket 09 publication step, driving the review state machine to a terminal
 * state:
 *
 *   analyzing → investigating → (engine run) → validating
 *     → findings persisted → publishing → completed | completed_with_warnings
 *
 * Failure semantics:
 *  - Findings persistence failure → `failed` (the review has no publishable
 *    data; §8.4 fail immediately).
 *  - Stale PR head at publish time → `failed` with code `stale_commit`; the
 *    results are rejected and nothing is published (§4.3/§4.4).
 *  - GitHub API failure after bounded retries → `completed_with_warnings`
 *    (the review data is retained; publication can be retried later).
 */
import type pino from "pino";
import type { PrismaClient } from "@prisma/client";
import type { AgentRuntime } from "../agent/types.js";
import type { ReviewConfig } from "../config/review-schema.js";
import { redactCredentials } from "../workspace/redact.js";
import { transitionReviewState } from "../ingestion/review-state.js";
import type { ReviewJobPayload } from "../ingestion/queue.js";
import type { WorkspaceResult } from "../workspace/workspace.js";
import type { InstallationTokenProvider } from "../workspace/credentials.js";
import { createReviewEngineHook } from "../review-engine/hook.js";
import { resolveReviewInjection } from "../review-engine/injection.js";
import type { RunReviewOutput } from "../review-engine/types.js";
import { getKnowledgeSnapshot, materializeReviewKnowledge, persistKnowledgeMetrics } from "../knowledge/index.js";
import { persistReviewFindings } from "../findings/index.js";
import {
  StaleHeadError,
  createGitHubOctokit,
  publishReview,
  recordPublicationFailure,
  type PublisherOctokit,
} from "./publisher.js";
import { endSpan, reviewSpanAttributes, startSpan } from "../observability/tracing.js";

export interface ReviewPipelineDeps {
  runtime: AgentRuntime;
  config: ReviewConfig;
  logger: pino.Logger;
  prisma: PrismaClient;
  /** Installation-token provider used to authenticate the GitHub API calls. */
  tokenProvider: InstallationTokenProvider;
  /** Octokit factory (tests inject a fake; default builds a real one). */
  octokitFactory?: (token: string) => PublisherOctokit;
  /** Bounded retry policy for GitHub API calls. */
  publishRetry?: { maxAttempts: number; baseDelayMs: number };
}

export type ReviewPipelineHook = (ctx: {
  payload: ReviewJobPayload;
  workspace: WorkspaceResult;
}) => Promise<RunReviewOutput>;

/**
 * Best-effort aggregate token usage persistence (§16.1). Returns whether the
 * write succeeded so the telemetry record can state it.
 */
async function persistReviewUsage(
  prisma: PrismaClient,
  reviewId: string,
  output: RunReviewOutput,
): Promise<boolean> {
  return prisma.review
    .update({
      where: { id: reviewId },
      data: {
        inputTokens: output.meta.usage.totalInputTokens,
        outputTokens: output.meta.usage.totalOutputTokens,
      },
    })
    .then(() => true)
    .catch(() => false);
}

/**
 * One structured telemetry record per terminal review.
 *
 * The engine computes per-stage token usage, but the pre-publish engine log
 * carried only totals and the pipeline's completion log carried only the
 * outcome — so "what did this review cost and where did it go" needed several
 * lines and still could not show the per-stage split or the inline/summary
 * publication split. This record is the join key: reviewId plus the engine
 * breakdown plus the publication result, emitted on success, skip and failure
 * (tokens burned by a failed publish are still cost).
 */
function buildReviewTelemetry(input: {
  config: ReviewConfig;
  payload: ReviewJobPayload;
  headSha: string;
  reviewType: string;
  output: RunReviewOutput;
  outcome: string;
  inlineCreated?: number;
  summaryOnlyFindings?: number;
  inlineDeduped?: number;
  reconciled?: number;
  usagePersisted?: boolean;
  errorCode?: string;
}): Record<string, unknown> {
  const { config, payload, output } = input;
  const calls = output.meta.usage.modelCalls.map((call) => ({
    stage: call.stage,
    input: call.inputTokens ?? 0,
    output: call.outputTokens ?? 0,
    reasoning: call.reasoningTokens ?? 0,
    durationMs: call.durationMs,
  }));
  const reasoningTokens = calls.reduce((sum, call) => sum + call.reasoning, 0);
  const inputTokens = output.meta.usage.totalInputTokens;
  const outputTokens = output.meta.usage.totalOutputTokens;
  const sdkEnabled = Boolean((config.agent as { sdk?: { enabled?: boolean } }).sdk?.enabled);
  const findings = output.result.findings;
  return {
    event: "review_telemetry",
    reviewId: payload.reviewId,
    repository: payload.repositoryFullName,
    pullRequestNumber: payload.pullRequestNumber,
    headSha: input.headSha,
    reviewType: input.reviewType,
    outcome: input.outcome,
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    runtime: sdkEnabled ? "opencode-sdk" : config.agent.runtime.type,
    provider: config.provider.type,
    model: config.provider.model,
    tier: output.meta.plan.tier,
    complexityScore: output.meta.plan.complexity.score,
    modelCalls: calls.length,
    inputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens: inputTokens + outputTokens + reasoningTokens,
    calls,
    engineDurationMs: output.meta.usage.durationMs,
    retrieval: {
      requested: output.meta.retrieval.requested,
      fulfilled: output.meta.retrieval.fulfilled,
      rejected: output.meta.retrieval.rejected,
      bytesDelivered: output.meta.retrieval.bytesDelivered,
      violations: output.meta.retrieval.violations.length,
    },
    findings: {
      total: findings.length,
      verified: findings.filter((finding) => finding.verified).length,
      uncertain: output.result.uncertainFindings.length,
      inline: input.inlineCreated ?? 0,
      summaryOnly: input.summaryOnlyFindings ?? 0,
      inlineDeduped: input.inlineDeduped ?? 0,
      reconciled: input.reconciled ?? 0,
    },
    ...(input.usagePersisted === undefined ? {} : { usagePersisted: input.usagePersisted }),
  };
}

/**
 * Persist the engine's findings and publish the review, driving the state
 * machine from `validating` to a terminal state. Exported for direct testing;
 * `createReviewPipelineHook` composes this after the engine hook.
 */
export async function finalizeReview(
  deps: ReviewPipelineDeps,
  ctx: { payload: ReviewJobPayload; workspace: WorkspaceResult },
  output: RunReviewOutput,
): Promise<void> {
  const { logger, prisma } = deps;
  const { payload, workspace } = ctx;
  const reviewId = payload.reviewId;

  // Findings persistence (ticket 08). The workspace is still present here —
  // verification needs the checked-out files; cleanup happens afterwards.
  const review = await prisma.review.findUnique({
    where: { id: reviewId },
    select: { id: true, reviewType: true, pullRequest: { select: { repositoryId: true } } },
  });
  if (!review) {
    throw new Error(`Review '${reviewId}' not found for findings persistence`);
  }
  try {
    await persistReviewFindings({
      repositoryId: review.pullRequest.repositoryId,
      repositoryFullName: payload.repositoryFullName,
      reviewId,
      workspacePath: workspace.workspacePath,
      findings: output.result.findings,
      uncertainFindings: output.result.uncertainFindings,
      config: deps.config,
      prisma,
      logger,
    });
  } catch (error) {
    const message = redactCredentials(error instanceof Error ? error.message : String(error));
    logger.error({ reviewId, err: message }, "Findings persistence failed");
    await transitionReviewState(reviewId, "failed", {
      errorCode: "findings_persist_failed",
      errorMessage: message.slice(0, 500),
    }).catch(() => {
      /* already terminal */
    });
    throw error;
  }

  await transitionReviewState(reviewId, "publishing");

  const publishSpan = startSpan("github.publishing", {
    attributes: reviewSpanAttributes({
      review_id: reviewId,
      repository: payload.repositoryFullName,
      pull_request_number: payload.pullRequestNumber,
      head_sha: workspace.headSha,
    }),
  });

  // Publishing gate (decision 7): only review types whose
  // review.types.<type>.publish flag is true post to GitHub. Experimental
  // types (skill/handbook by default) run, persist findings and complete —
  // the skip is recorded on the review row (publishSkipped) and logged.
  const typeSettings = deps.config.review.types[review.reviewType as keyof typeof deps.config.review.types];
  const publishable = typeSettings ? typeSettings.publish : review.reviewType === "standard";
  if (!publishable) {
    logger.info(
      { reviewId, reviewType: review.reviewType },
      "Publishing gate: review type is not publishable; findings persisted but GitHub publication skipped",
    );
    await prisma.review.update({ where: { id: reviewId }, data: { publishSkipped: true } }).catch(() => {
      /* row gone — ignore */
    });
    await transitionReviewState(reviewId, "completed");
    endSpan(publishSpan);
    logger.info(
      buildReviewTelemetry({
        config: deps.config,
        payload,
        headSha: workspace.headSha,
        reviewType: review.reviewType,
        output,
        outcome: "publish_skipped",
        usagePersisted: await persistReviewUsage(prisma, reviewId, output),
      }),
      "Review telemetry summary",
    );
    return;
  }

  try {
    const token = await deps.tokenProvider.getInstallationToken(
      BigInt(payload.githubInstallationId),
      payload.repositoryFullName,
    );
    const octokit = deps.octokitFactory
      ? deps.octokitFactory(token.token)
      : createGitHubOctokit(token.token, process.env.GITHUB_BASE_URL);

    const publish = await publishReview({
      prisma,
      octokit,
      reviewId,
      repositoryFullName: payload.repositoryFullName,
      pullNumber: payload.pullRequestNumber,
      headSha: workspace.headSha,
      diff: workspace.diff,
      summary: output.result.summary,
      findings: await prisma.finding.findMany({ where: { reviewId } }).then((rows) =>
        rows.map((row) => ({
          id: row.id,
          fingerprint: row.fingerprint,
          category: row.category,
          severity: row.severity,
          confidence: row.confidence,
          title: row.title,
          filePath: row.filePath,
          lineNumber: row.lineNumber,
          description: row.description,
          verified: row.verified,
          status: row.status as "new" | "existing" | "updated" | "uncertain",
          reopened: false,
        })),
      ),
      config: {
        publishUncertainInSummary: deps.config.review.findings.publishUncertainInSummary,
        publishCleanReview: deps.config.review.reporting.publishCleanReview,
      },
      meta: {
        reviewer: deps.config.application.name,
        source: `${payload.repositoryFullName}#${payload.pullRequestNumber} @ ${workspace.headSha.slice(0, 7)}`,
        reviewedAt: new Date(),
        timezone: deps.config.application.timezone,
      },
      ...(deps.publishRetry ? { retry: deps.publishRetry } : {}),
      logger,
    });

    // Persist aggregate token usage (§16.1 comparison endpoint).
    const usagePersisted = await persistReviewUsage(prisma, reviewId, output);

    await transitionReviewState(reviewId, "completed");
    endSpan(publishSpan);
    logger.info(
      buildReviewTelemetry({
        config: deps.config,
        payload,
        headSha: workspace.headSha,
        reviewType: review.reviewType,
        output,
        outcome: publish.outcome,
        inlineCreated: publish.inlineCreated,
        summaryOnlyFindings: publish.summaryOnlyFindings,
        inlineDeduped: publish.inlineDeduped,
        reconciled: publish.reconciled,
        usagePersisted,
      }),
      "Review telemetry summary",
    );
  } catch (error) {
    if (error instanceof StaleHeadError) {
      // §4.3/§4.4: reject the result, publish nothing.
      endSpan(publishSpan, error);
      logger.warn({ reviewId }, "PR head moved before publication; rejecting review results");
      await transitionReviewState(reviewId, "failed", {
        errorCode: "stale_commit",
        errorMessage: redactCredentials(error.message).slice(0, 500),
      }).catch(() => {
        /* already terminal */
      });
      logger.info(
        buildReviewTelemetry({
          config: deps.config,
          payload,
          headSha: workspace.headSha,
          reviewType: review.reviewType,
          output,
          outcome: "stale_commit",
          errorCode: "stale_commit",
          usagePersisted: await persistReviewUsage(prisma, reviewId, output),
        }),
        "Review telemetry summary",
      );
      throw error;
    }
    endSpan(publishSpan, error);
    const message = redactCredentials(error instanceof Error ? error.message : String(error));
    const usagePersisted = await persistReviewUsage(prisma, reviewId, output);
    logger.info(
      buildReviewTelemetry({
        config: deps.config,
        payload,
        headSha: workspace.headSha,
        reviewType: review.reviewType,
        output,
        outcome: "publication_failed",
        usagePersisted,
      }),
      "Review telemetry summary",
    );
    logger.error({ reviewId, err: message }, "GitHub publication failed");
    await recordPublicationFailure(prisma, reviewId);
    // The review data is intact and retained; only the GitHub write failed.
    await transitionReviewState(reviewId, "completed_with_warnings").catch(() => {
      /* already terminal */
    });
  }
}

/**
 * Build the `onWorkspacePrepared` hook that runs the engine, persists the
 * findings and publishes the review to GitHub.
 */
export function createReviewPipelineHook(deps: ReviewPipelineDeps): ReviewPipelineHook {
  const engineHook = createReviewEngineHook(deps);

  return async (ctx) => {
    const reviewType = ctx.payload.reviewType ?? "standard";
    // Review-type injection (§4.1): skill loads the playbook, handbook uses
    // the engineering handbook. Both run BEFORE the engine so missing
    // content fails the review fast (SKILL_PLAYBOOK_UNAVAILABLE /
    // HANDBOOK_UNCONFIGURED) instead of silently comparing against a
    // degraded standard review.
    //
    // Per-review reproducibility (§4): the review's OWN knowledge snapshot
    // copy is materialized into the workspace and its identity persisted on
    // the Review row; injection reads only those copies, never the shared
    // cache, so a worker restart refreshing the cache cannot change an
    // in-flight review.
    let promptInjection = null;
    if (reviewType !== "standard") {
      const materialized = await materializeReviewKnowledge({
        reviewId: ctx.payload.reviewId,
        reviewType,
        workspacePath: ctx.workspace.workspacePath,
        snapshot: getKnowledgeSnapshot(),
        prisma: deps.prisma,
        logger: deps.logger,
      });
      promptInjection = await resolveReviewInjection({
        reviewType,
        config: deps.config,
        changedFiles: ctx.workspace.changedFiles.map((file) => file.path),
        knowledgeDir: materialized.knowledgeDir,
        snapshot: materialized.snapshot,
        logger: deps.logger,
      });
      // Per-review knowledge metrics (§16.1, additive): the retrieval
      // funnel + estimated injected tokens, persisted on the Review row's
      // knowledgeSnapshot JSON. Best-effort — a metrics write failure must
      // never fail the review.
      if (promptInjection?.metrics) {
        await persistKnowledgeMetrics(
          deps.prisma,
          ctx.payload.reviewId,
          promptInjection.profile,
          promptInjection.metrics,
        ).catch((error) => {
          deps.logger.warn(
            { reviewId: ctx.payload.reviewId, err: redactCredentials(error instanceof Error ? error.message : String(error)) },
            "Failed to persist knowledge injection metrics (non-fatal)",
          );
        });
      }
    }
    // Engine run + state up to `validating` (ticket 07 hook).
    const output = await engineHook({ ...ctx, promptInjection });
    await finalizeReview(deps, ctx, output);
    return output;
  };
}
