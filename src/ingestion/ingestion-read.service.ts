import type { ReviewState, ReviewTrigger } from "./ingestion.repository.js";
import { getDefaultIngestionService, type IngestionService } from "./ingestion.service.js";
import { ManualIngestionError, type IngestReviewRequestResult, type ManualIngestionInput } from "./ingestion.types.js";
import type { IngestionRepositories } from "./ingestion.unit-of-work.js";
import { getDefaultIngestionDependencies } from "./prisma-ingestion.unit-of-work.js";

/**
 * Read-side ingestion use cases: review status tracking and manual `/review`
 * resolution (ARCHITECTURE.md §4.3, §15).
 *
 * Manual ingestion only resolves the durable repository/pull-request rows and
 * delegates the write to the ingestion service; no review state is written
 * here.
 */

export type ReviewStatusReport = {
  review: {
    id: string;
    state: ReviewState;
    trigger: ReviewTrigger;
    reviewMode: string;
    headSha: string;
    configurationHash: string | null;
    createdAt: Date;
    completedAt: Date | null;
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
  transitions: Array<{ fromState: string | null; toState: string; at: Date }>;
};

export type IngestionReadServiceDependencies = {
  repositories: IngestionRepositories;
  ingestion: IngestionService;
};

export interface IngestionReadService {
  ingestManualReview(input: ManualIngestionInput): Promise<IngestReviewRequestResult>;
  getReviewStatus(reviewId: string): Promise<ReviewStatusReport | null>;
}

export function createIngestionReadService(deps: IngestionReadServiceDependencies): IngestionReadService {
  /**
   * Manual ingestion (no auth in this milestone; §15 notes hardening for
   * later).
   */
  async function ingestManualReview(input: ManualIngestionInput): Promise<IngestReviewRequestResult> {
    const found = await deps.repositories.repositories.findActiveByFullName(input.repository);
    if (!found) {
      throw new ManualIngestionError(`Repository '${input.repository}' is not registered`);
    }
    const pullRequest = await deps.repositories.pullRequests.findByRepositoryAndNumber(
      found.repository.id,
      input.pullRequestNumber,
    );
    if (!pullRequest) {
      throw new ManualIngestionError(`Pull request #${input.pullRequestNumber} not found on '${input.repository}'`);
    }
    const headSha = input.headSha ?? pullRequest.headSha;
    if (!headSha) {
      throw new ManualIngestionError(`No head SHA known for '${input.repository}'#${input.pullRequestNumber}`);
    }

    return deps.ingestion.ingestReviewRequest({
      trigger: "manual",
      reviewType: input.reviewType ?? "standard",
      installationId: found.installation.githubInstallationId.toString(),
      repositoryId: found.repository.githubRepositoryId.toString(),
      repositoryName: found.repository.fullName,
      owner: found.installation.organization,
      defaultBranch: found.repository.defaultBranch,
      pullRequestNumber: pullRequest.githubPrNumber,
      headSha,
      baseSha: pullRequest.baseSha,
      draft: pullRequest.draft,
    });
  }

  async function getReviewStatus(reviewId: string): Promise<ReviewStatusReport | null> {
    const status = await deps.repositories.reviews.findStatusById(reviewId);
    if (!status) {
      return null;
    }
    return {
      review: {
        id: status.review.id,
        state: status.review.state,
        trigger: status.review.trigger,
        reviewMode: status.review.reviewMode,
        headSha: status.review.headSha,
        configurationHash: status.review.configurationHash,
        createdAt: status.review.createdAt,
        completedAt: status.review.completedAt,
        errorCode: status.review.errorCode,
      },
      job: status.job
        ? {
            id: status.job.id,
            status: status.job.status,
            attempts: status.job.attempts,
            lastError: status.job.lastError,
            queueJobId: status.job.queueJobId,
            jobKey: status.job.jobKey,
          }
        : null,
      transitions: status.transitions.map((transition) => ({
        fromState: transition.fromState,
        toState: transition.toState,
        at: transition.createdAt,
      })),
    };
  }

  return { ingestManualReview, getReviewStatus };
}

let defaultReadService: IngestionReadService | undefined;

function getDefaultIngestionReadService(): IngestionReadService {
  defaultReadService ??= createIngestionReadService({
    repositories: getDefaultIngestionDependencies().repositories,
    ingestion: getDefaultIngestionService(),
  });
  return defaultReadService;
}

/**
 * Module-edge compatibility function for existing callers. PR 2.6 wires the
 * composition root and removes this wrapper.
 */
export async function ingestManualReview(input: ManualIngestionInput): Promise<IngestReviewRequestResult> {
  return getDefaultIngestionReadService().ingestManualReview(input);
}

/**
 * Module-edge compatibility function for existing callers. PR 2.6 wires the
 * composition root and removes this wrapper.
 */
export async function getReviewStatus(reviewId: string): Promise<ReviewStatusReport | null> {
  return getDefaultIngestionReadService().getReviewStatus(reviewId);
}
