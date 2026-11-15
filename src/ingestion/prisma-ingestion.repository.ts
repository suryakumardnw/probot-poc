import type {
  Installation,
  Prisma,
  PrismaClient,
  PullRequest,
  Repository,
  Review,
  ReviewJob,
  ReviewStateTransition,
  WebhookDelivery,
} from "@prisma/client";
import type {
  CreateReviewInput,
  CreateReviewJobInput,
  CreateReviewStateTransitionInput,
  CreateWebhookDeliveryInput,
  FindInFlightReviewsInput,
  FindIncompleteJobsInput,
  FindReviewIdentityInput,
  InstallationRecord,
  InstallationRepository,
  MaxReviewAttemptInput,
  PullRequestRecord,
  PullRequestRepository,
  RepositoryFullNameRecord,
  RepositoryRecord,
  RepositoryRepository,
  RepositoryWithInstallation,
  ReviewJobRecord,
  ReviewJobRepository,
  ReviewJobWithReview,
  ReviewRecord,
  ReviewRepository,
  ReviewState,
  ReviewStatePatch,
  ReviewStateTransitionRecord,
  ReviewStateTransitionRepository,
  ReviewStatusRecord,
  ReviewWithJob,
  UpdateReviewJobInput,
  UpsertInstallationInput,
  UpsertPullRequestInput,
  UpsertRepositoryInput,
  WebhookDeliveryRecord,
  WebhookDeliveryRepository,
} from "./ingestion.repository.js";
import type { IngestionRepositories } from "./ingestion.unit-of-work.js";
import { createOutboxRepository } from "./prisma-outbox.repository.js";

/**
 * Prisma implementation of the ingestion repository ports.
 *
 * Every factory accepts either the root client or a transaction client. The
 * mappers below convert Prisma rows/enums into the module's domain records, so
 * no Prisma type escapes this file or its outbox sibling.
 */

export type PrismaRootClient = PrismaClient;
export type PrismaDatabaseClient = PrismaClient | Prisma.TransactionClient;

type ReviewWithJobRow = Prisma.ReviewGetPayload<{ include: { job: true } }>;
type ReviewStatusRow = Prisma.ReviewGetPayload<{ include: { job: true; transitions: true } }>;
type ReviewJobWithReviewRow = Prisma.ReviewJobGetPayload<{ include: { review: true } }>;
type RepositoryWithInstallationRow = Prisma.RepositoryGetPayload<{ include: { installation: true } }>;

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function mapInstallation(row: Installation): InstallationRecord {
  return {
    id: row.id,
    githubInstallationId: row.githubInstallationId,
    organization: row.organization,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapRepository(row: Repository): RepositoryRecord {
  return {
    id: row.id,
    githubRepositoryId: row.githubRepositoryId,
    installationId: row.installationId,
    fullName: row.fullName,
    defaultBranch: row.defaultBranch,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapPullRequest(row: PullRequest): PullRequestRecord {
  return {
    id: row.id,
    repositoryId: row.repositoryId,
    githubPrNumber: row.githubPrNumber,
    headSha: row.headSha,
    baseSha: row.baseSha,
    draft: row.draft,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapReview(row: Review): ReviewRecord {
  return {
    id: row.id,
    pullRequestId: row.pullRequestId,
    githubInstallationId: row.githubInstallationId,
    githubRepositoryId: row.githubRepositoryId,
    pullRequestNumber: row.pullRequestNumber,
    headSha: row.headSha,
    baseSha: row.baseSha,
    state: row.state,
    trigger: row.trigger,
    reviewMode: row.reviewMode,
    reviewType: row.reviewType,
    attempt: row.attempt,
    configurationHash: row.configurationHash,
    schemaVersion: row.schemaVersion,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    completedAt: row.completedAt,
    supersededByReviewId: row.supersededByReviewId,
    supersededAt: row.supersededAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapReviewJob(row: ReviewJob): ReviewJobRecord {
  return {
    id: row.id,
    reviewId: row.reviewId,
    status: row.status,
    attempts: row.attempts,
    lastError: row.lastError,
    queueJobId: row.queueJobId,
    jobKey: row.jobKey,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapReviewStateTransition(row: ReviewStateTransition): ReviewStateTransitionRecord {
  return {
    id: row.id,
    reviewId: row.reviewId,
    fromState: row.fromState,
    toState: row.toState,
    createdAt: row.createdAt,
  };
}

function mapWebhookDelivery(row: WebhookDelivery): WebhookDeliveryRecord {
  return {
    id: row.id,
    deliveryId: row.deliveryId,
    event: row.event,
    action: row.action,
    reviewJobId: row.reviewJobId,
    processedAt: row.processedAt,
  };
}

function mapReviewWithJob(row: ReviewWithJobRow): ReviewWithJob {
  return {
    review: mapReview(row),
    job: row.job ? mapReviewJob(row.job) : null,
  };
}

function mapReviewStatus(row: ReviewStatusRow): ReviewStatusRecord {
  return {
    review: mapReview(row),
    job: row.job ? mapReviewJob(row.job) : null,
    transitions: row.transitions.map(mapReviewStateTransition),
  };
}

function mapRepositoryWithInstallation(row: RepositoryWithInstallationRow): RepositoryWithInstallation {
  return {
    repository: mapRepository(row),
    installation: mapInstallation(row.installation),
  };
}

function mapReviewJobWithReview(row: ReviewJobWithReviewRow): ReviewJobWithReview {
  return {
    job: mapReviewJob(row),
    review: mapReview(row.review),
  };
}

function reviewPatchData(patch: ReviewStatePatch): Prisma.ReviewUncheckedUpdateInput {
  return {
    state: patch.state,
    ...(patch.completedAt !== undefined ? { completedAt: patch.completedAt } : {}),
    ...(patch.errorCode !== undefined ? { errorCode: patch.errorCode } : {}),
    ...(patch.errorMessage !== undefined ? { errorMessage: patch.errorMessage } : {}),
    ...(patch.supersededByReviewId !== undefined ? { supersededByReviewId: patch.supersededByReviewId } : {}),
    ...(patch.supersededAt !== undefined ? { supersededAt: patch.supersededAt } : {}),
  };
}

function reviewCreateData(input: CreateReviewInput): Prisma.ReviewUncheckedCreateInput {
  return {
    pullRequestId: input.pullRequestId,
    githubInstallationId: input.githubInstallationId,
    githubRepositoryId: input.githubRepositoryId,
    pullRequestNumber: input.pullRequestNumber,
    headSha: input.headSha,
    baseSha: input.baseSha,
    state: input.state,
    trigger: input.trigger,
    reviewMode: input.reviewMode,
    reviewType: input.reviewType,
    attempt: input.attempt,
    configurationHash: input.configurationHash,
    schemaVersion: input.schemaVersion,
  };
}

// ---------------------------------------------------------------------------
// Repository factories
// ---------------------------------------------------------------------------

export function createInstallationRepository(client: PrismaDatabaseClient): InstallationRepository {
  return {
    async upsertActive(input: UpsertInstallationInput): Promise<InstallationRecord> {
      const row = await client.installation.upsert({
        where: { githubInstallationId: input.githubInstallationId },
        create: {
          githubInstallationId: input.githubInstallationId,
          organization: input.organization,
          status: "active",
        },
        update: { status: "active", organization: input.organization },
      });
      return mapInstallation(row);
    },
  };
}

export function createRepositoryRepository(client: PrismaDatabaseClient): RepositoryRepository {
  return {
    async upsertActive(input: UpsertRepositoryInput): Promise<RepositoryRecord> {
      const row = await client.repository.upsert({
        where: { githubRepositoryId: input.githubRepositoryId },
        create: {
          githubRepositoryId: input.githubRepositoryId,
          installationId: input.installationId,
          fullName: input.fullName,
          defaultBranch: input.defaultBranch,
          status: "active",
        },
        update: {
          fullName: input.fullName,
          // Never clobber a stored default branch with null.
          defaultBranch: input.defaultBranch ?? undefined,
          installationId: input.installationId,
          status: "active",
        },
      });
      return mapRepository(row);
    },

    async findActiveByFullName(fullName: string): Promise<RepositoryWithInstallation | null> {
      const row = await client.repository.findFirst({
        where: { fullName, status: "active" },
        include: { installation: true },
      });
      return row ? mapRepositoryWithInstallation(row) : null;
    },

    async findFullNamesByGithubIds(githubRepositoryIds: readonly bigint[]): Promise<RepositoryFullNameRecord[]> {
      const rows = await client.repository.findMany({
        where: { githubRepositoryId: { in: [...githubRepositoryIds] } },
        select: { githubRepositoryId: true, fullName: true },
      });
      return rows.map((row) => ({ githubRepositoryId: row.githubRepositoryId, fullName: row.fullName }));
    },
  };
}

export function createPullRequestRepository(client: PrismaDatabaseClient): PullRequestRepository {
  return {
    async upsertOpen(input: UpsertPullRequestInput): Promise<PullRequestRecord> {
      const row = await client.pullRequest.upsert({
        where: {
          repositoryId_githubPrNumber: {
            repositoryId: input.repositoryId,
            githubPrNumber: input.githubPrNumber,
          },
        },
        create: {
          repositoryId: input.repositoryId,
          githubPrNumber: input.githubPrNumber,
          headSha: input.headSha,
          baseSha: input.baseSha,
          draft: input.draft,
          status: "open",
        },
        update: {
          headSha: input.headSha,
          // Never clobber a known base SHA with null: manual `/review`
          // ingestion has no base SHA, and wiping the stored one leaves the
          // workspace with nothing to diff against.
          baseSha: input.baseSha ?? undefined,
          draft: input.draft,
          status: "open",
        },
      });
      return mapPullRequest(row);
    },

    async findByRepositoryAndNumber(repositoryId: string, githubPrNumber: number): Promise<PullRequestRecord | null> {
      const row = await client.pullRequest.findUnique({
        where: { repositoryId_githubPrNumber: { repositoryId, githubPrNumber } },
      });
      return row ? mapPullRequest(row) : null;
    },
  };
}

export function createReviewRepository(client: PrismaDatabaseClient): ReviewRepository {
  return {
    async findByIdentity(input: FindReviewIdentityInput): Promise<ReviewWithJob | null> {
      const row = await client.review.findUnique({
        where: {
          pullRequestId_headSha_reviewMode_reviewType_attempt: {
            pullRequestId: input.pullRequestId,
            headSha: input.headSha,
            reviewMode: input.reviewMode,
            reviewType: input.reviewType,
            attempt: input.attempt,
          },
        },
        include: { job: true },
      });
      return row ? mapReviewWithJob(row) : null;
    },

    async findInFlight(input: FindInFlightReviewsInput): Promise<ReviewWithJob[]> {
      const rows = await client.review.findMany({
        where: {
          pullRequestId: input.pullRequestId,
          reviewType: input.reviewType,
          state: { notIn: [...input.notInStates] },
        },
        include: { job: true },
      });
      return rows.map(mapReviewWithJob);
    },

    async maxAttempt(input: MaxReviewAttemptInput): Promise<number> {
      const aggregate = await client.review.aggregate({
        where: {
          pullRequestId: input.pullRequestId,
          headSha: input.headSha,
          reviewMode: input.reviewMode,
          reviewType: input.reviewType,
        },
        _max: { attempt: true },
      });
      return aggregate._max.attempt ?? 0;
    },

    async create(input: CreateReviewInput): Promise<ReviewRecord> {
      const row = await client.review.create({ data: reviewCreateData(input) });
      return mapReview(row);
    },

    async findById(reviewId: string): Promise<ReviewRecord | null> {
      const row = await client.review.findUnique({ where: { id: reviewId } });
      return row ? mapReview(row) : null;
    },

    async findStateById(reviewId: string): Promise<ReviewState | null> {
      const row = await client.review.findUnique({ where: { id: reviewId }, select: { state: true } });
      return row?.state ?? null;
    },

    async updateState(reviewId: string, patch: ReviewStatePatch): Promise<ReviewRecord> {
      const row = await client.review.update({ where: { id: reviewId }, data: reviewPatchData(patch) });
      return mapReview(row);
    },

    async resetForRecovery(reviewId: string): Promise<void> {
      await client.review.update({
        where: { id: reviewId },
        data: { state: "queued", errorCode: null, errorMessage: null },
      });
    },

    async markFailed(reviewId: string, errorCode: string, errorMessage: string | null): Promise<void> {
      await client.review.update({
        where: { id: reviewId },
        data: { state: "failed", errorCode, errorMessage },
      });
    },

    async findStatusById(reviewId: string): Promise<ReviewStatusRecord | null> {
      const row = await client.review.findUnique({
        where: { id: reviewId },
        include: { job: true, transitions: { orderBy: { createdAt: "asc" } } },
      });
      return row ? mapReviewStatus(row) : null;
    },
  };
}

export function createReviewJobRepository(client: PrismaDatabaseClient): ReviewJobRepository {
  return {
    async create(input: CreateReviewJobInput): Promise<ReviewJobRecord> {
      const row = await client.reviewJob.create({
        data: { reviewId: input.reviewId, status: input.status, jobKey: input.jobKey },
      });
      return mapReviewJob(row);
    },

    async update(reviewJobId: string, input: UpdateReviewJobInput): Promise<void> {
      await client.reviewJob.update({
        where: { id: reviewJobId },
        data: {
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.lastError !== undefined ? { lastError: input.lastError } : {}),
          ...(input.queueJobId !== undefined ? { queueJobId: input.queueJobId } : {}),
        },
      });
    },

    async markFailed(reviewJobId: string, lastError: string): Promise<void> {
      await client.reviewJob.update({
        where: { id: reviewJobId },
        data: { status: "failed", lastError },
      });
    },

    async restorePendingOutbox(reviewJobId: string): Promise<void> {
      // The `queueJobId: null` guard keeps a concurrent successful publisher's
      // state intact.
      await client.reviewJob.updateMany({
        where: { id: reviewJobId, status: "enqueued", queueJobId: null },
        data: { status: "pending_outbox" },
      });
    },

    async findIncompleteWithReviews(input: FindIncompleteJobsInput): Promise<ReviewJobWithReview[]> {
      const rows = await client.reviewJob.findMany({
        where: {
          status: { in: [...input.statuses] },
          review: { state: { notIn: [...input.notInReviewStates] } },
        },
        include: { review: true },
        orderBy: { createdAt: "asc" },
        take: input.limit,
      });
      return rows.map(mapReviewJobWithReview);
    },
  };
}

export function createReviewStateTransitionRepository(client: PrismaDatabaseClient): ReviewStateTransitionRepository {
  return {
    async create(input: CreateReviewStateTransitionInput): Promise<ReviewStateTransitionRecord> {
      const row = await client.reviewStateTransition.create({
        data: { reviewId: input.reviewId, fromState: input.fromState, toState: input.toState },
      });
      return mapReviewStateTransition(row);
    },
  };
}

export function createWebhookDeliveryRepository(client: PrismaDatabaseClient): WebhookDeliveryRepository {
  return {
    async findByDeliveryId(deliveryId: string): Promise<WebhookDeliveryRecord | null> {
      const row = await client.webhookDelivery.findUnique({ where: { deliveryId } });
      return row ? mapWebhookDelivery(row) : null;
    },

    async create(input: CreateWebhookDeliveryInput): Promise<void> {
      await client.webhookDelivery.create({
        data: { deliveryId: input.deliveryId, event: input.event, reviewJobId: input.reviewJobId },
      });
    },
  };
}

/**
 * Build the full ingestion repository bundle for one client (root or
 * transaction-scoped).
 */
export function createIngestionRepositories(client: PrismaDatabaseClient): IngestionRepositories {
  return {
    installations: createInstallationRepository(client),
    repositories: createRepositoryRepository(client),
    pullRequests: createPullRequestRepository(client),
    reviews: createReviewRepository(client),
    reviewJobs: createReviewJobRepository(client),
    stateTransitions: createReviewStateTransitionRepository(client),
    webhookDeliveries: createWebhookDeliveryRepository(client),
    outboxEvents: createOutboxRepository(client),
  };
}
