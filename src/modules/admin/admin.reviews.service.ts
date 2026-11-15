import type {
  CompareQuery,
  CompareReviewsResponse,
  ReviewComparisonRow,
  ReviewListQuery,
  ReviewListResponse,
  ReviewTriggerResponse,
  TriggerReviewBody,
} from "../../contracts/admin.js";
import { ERROR_CODES } from "../../contracts/errors.js";
import type { ReviewConfigStore } from "../../ports/review-config.js";
import { ConflictError, NotFoundError } from "../../shared/errors/index.js";
import type { IngestionReadService, ReviewComparisonInput, ReviewTypeValue } from "../ingestion/index.js";
import { summarizeKnowledgeMetrics, summarizeKnowledgeSnapshot } from "../knowledge/index.js";
import type { AdminLogger } from "./admin.types.js";
import type { AuditAction, AuditMetadata, AuditRepository } from "./audit.repository.js";

/**
 * Admin review use cases (ARCHITECTURE.md §4.1, §15).
 *
 * Maps ingestion read reports to the admin wire contracts and owns the audit
 * side effects of manual review triggering. No HTTP concerns live here.
 */

export interface AdminReviewServiceDeps {
  audit: AuditRepository;
  ingestion: IngestionReadService;
  config: ReviewConfigStore;
  logger: AdminLogger;
}

/**
 * Review-detail payload derived from the ingestion read report. The HTTP layer
 * parses it against `reviewStatusResponseSchema` before writing it.
 */
export interface ReviewDetailPayload {
  review: {
    id: string;
    state: string;
    trigger: string;
    reviewMode: string;
    headSha: string;
    configurationHash: string | null;
    createdAt: string;
    completedAt: string | null;
    errorCode: string | null;
  };
  job: {
    id: string;
    status: string;
    attempts: number;
    lastError: string | null;
    queueJobId: string | null;
    jobKey: string;
  } | null;
  transitions: Array<{ fromState: string | null; toState: string; at: string }>;
}

export interface AdminReviewService {
  listReviews(query: ReviewListQuery): Promise<ReviewListResponse>;
  getReviewDetail(reviewId: string): Promise<ReviewDetailPayload>;
  triggerReview(input: TriggerReviewBody, actor: string): Promise<ReviewTriggerResponse>;
  compareReviews(query: CompareQuery): Promise<CompareReviewsResponse>;
}

export function createAdminReviewService(deps: AdminReviewServiceDeps): AdminReviewService {
  async function audit(actor: string, action: AuditAction, resource: string, metadata?: AuditMetadata): Promise<void> {
    await deps.audit.record({ actor, action, resource, metadata });
  }

  async function listReviews(query: ReviewListQuery): Promise<ReviewListResponse> {
    const limit = query.limit ?? 20;
    const offset = query.offset ?? 0;
    const report = await deps.ingestion.listReviews({
      limit,
      offset,
      ...(query.state === undefined ? {} : { state: query.state }),
    });
    return {
      total: report.total,
      limit,
      offset,
      reviews: report.reviews.map((row) => ({
        id: row.id,
        state: row.state,
        repository: row.repositoryFullName,
        pullRequestNumber: row.pullRequestNumber,
        pullRequestId: row.pullRequestId,
        headSha: row.headSha,
        reviewMode: row.reviewMode,
        trigger: row.trigger,
        provider: row.provider,
        model: row.model,
        startedAt: row.startedAt?.toISOString() ?? null,
        completedAt: row.completedAt?.toISOString() ?? null,
        errorCode: row.errorCode,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  async function getReviewDetail(reviewId: string): Promise<ReviewDetailPayload> {
    const report = await deps.ingestion.getReviewStatus(reviewId);
    if (!report) {
      throw new NotFoundError("review not found", { code: ERROR_CODES.REVIEW_NOT_FOUND });
    }
    return {
      review: {
        ...report.review,
        createdAt: report.review.createdAt.toISOString(),
        completedAt: report.review.completedAt?.toISOString() ?? null,
      },
      job: report.job,
      transitions: report.transitions.map((transition) => ({
        fromState: transition.fromState,
        toState: transition.toState,
        at: transition.at.toISOString(),
      })),
    };
  }

  /** Resolve the review type, respecting the configured default and disabled types. */
  function resolveReviewType(input: TriggerReviewBody): ReviewTypeValue {
    let reviewType: ReviewTypeValue = input.reviewType ?? "standard";
    let disabled = false;
    try {
      const { config } = deps.config.load();
      reviewType = input.reviewType ?? config.github.defaultReviewType;
      const settings = config.review.types[reviewType];
      disabled = settings !== undefined && settings.enabled === false;
    } catch (error) {
      deps.logger.warn(
        { err: (error as Error).message },
        "Configuration unavailable for review trigger; defaulting type",
      );
      reviewType = input.reviewType ?? "standard";
    }
    if (disabled) {
      throw new ConflictError(`review type '${reviewType}' is disabled`, { code: ERROR_CODES.REVIEW_TYPE_DISABLED });
    }
    return reviewType;
  }

  async function triggerReview(input: TriggerReviewBody, actor: string): Promise<ReviewTriggerResponse> {
    const reviewType = resolveReviewType(input);
    const result = await deps.ingestion.ingestManualReview({ ...input, reviewType });
    await audit(actor, "review.trigger", "review", {
      repository: input.repository,
      pullRequestNumber: input.pullRequestNumber,
      reviewType,
      outcome: result.outcome,
      reviewId: result.reviewId,
    });
    return { ...result, reviewType };
  }

  /**
   * Per-type comparison rows for one PR (§4.1): review id, type, state,
   * attempt, trigger, timestamps, duration, finding counts by severity,
   * findings unique to this type (fingerprint not present in any other type's
   * review of the same commit) and persisted token usage (null when the run
   * predates token persistence).
   */
  async function compareReviews(query: CompareQuery): Promise<CompareReviewsResponse> {
    const repositoryName = query.repository;
    const prRaw = query.pr;
    const target: ReviewComparisonInput = { repositoryFullName: repositoryName, pullRequestNumber: prRaw };

    const lookup = await deps.ingestion.getReviewComparison(target);
    if (lookup.outcome === "repository_not_found") {
      throw new NotFoundError(`repository '${repositoryName}' is not registered`, {
        code: ERROR_CODES.REPOSITORY_NOT_FOUND,
      });
    }
    if (lookup.outcome === "pull_request_not_found") {
      throw new NotFoundError(`pull request #${prRaw} not found on '${repositoryName}'`, {
        code: ERROR_CODES.PULL_REQUEST_NOT_FOUND,
      });
    }

    const reviews = lookup.reviews;

    // Fingerprints seen by each review TYPE of the same PR/head SHA — used
    // to compute per-type unique findings (a fingerprint another type did
    // not report). A review's own type never counts against it.
    const fingerprintsByType = new Map<string, Map<string, Set<string>>>();
    for (const review of reviews) {
      let bySha = fingerprintsByType.get(review.reviewType);
      if (!bySha) {
        bySha = new Map<string, Set<string>>();
        fingerprintsByType.set(review.reviewType, bySha);
      }
      let set = bySha.get(review.headSha);
      if (!set) {
        set = new Set<string>();
        bySha.set(review.headSha, set);
      }
      for (const finding of review.findings) {
        set.add(finding.fingerprint);
      }
    }

    const rows: ReviewComparisonRow[] = reviews.map((review) => {
      const severityCounts: Record<string, number> = {};
      for (const finding of review.findings) {
        severityCounts[finding.severity] = (severityCounts[finding.severity] ?? 0) + 1;
      }
      const fingerprints = new Set(review.findings.map((f) => f.fingerprint));
      const others = new Set<string>();
      for (const [type, bySha] of fingerprintsByType) {
        if (type === review.reviewType) {
          continue;
        }
        for (const fingerprint of bySha.get(review.headSha) ?? []) {
          others.add(fingerprint);
        }
      }
      let uniqueCount = 0;
      for (const fingerprint of fingerprints) {
        if (!others.has(fingerprint)) {
          uniqueCount += 1;
        }
      }
      const completedAt = review.completedAt ?? null;
      const durationMs = review.startedAt && completedAt ? completedAt.getTime() - review.startedAt.getTime() : null;
      return {
        id: review.id,
        reviewType: review.reviewType,
        reviewMode: review.reviewMode,
        state: review.state,
        attempt: review.attempt,
        trigger: review.trigger,
        headSha: review.headSha,
        createdAt: review.createdAt.toISOString(),
        startedAt: review.startedAt?.toISOString() ?? null,
        completedAt: completedAt?.toISOString() ?? null,
        durationMs,
        publishSkipped: review.publishSkipped,
        findingCount: review.findings.length,
        severityCounts,
        uniqueFindings: uniqueCount,
        inputTokens: review.inputTokens,
        outputTokens: review.outputTokens,
        // Knowledge snapshot identity per review (§4/§16.1, additive): the
        // ref + content hash each type's injection actually ran with, so
        // comparisons can show e.g. "handbook@<sha7>".
        knowledgeSnapshot: summarizeKnowledgeSnapshot(review.knowledgeSnapshot),
        // Injection metrics per review (§16.1, additive): estimated injected
        // tokens + the retrieval funnel (candidates → relevant → selected)
        // and whether the token budget forced truncation. Null when the
        // review predates metrics or ran without knowledge injection.
        knowledgeMetrics: summarizeKnowledgeMetrics(review.knowledgeSnapshot),
        errorCode: review.errorCode,
      };
    });

    return {
      repository: repositoryName,
      pullRequestNumber: prRaw,
      headShas: [...new Set(reviews.map((r) => r.headSha))],
      reviews: rows,
    };
  }

  return { listReviews, getReviewDetail, triggerReview, compareReviews };
}
