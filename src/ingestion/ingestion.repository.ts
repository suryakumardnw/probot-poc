import type { ReviewTypeValue } from "../contracts/queue.js";

/**
 * Ingestion repository ports and domain types (ARCHITECTURE.md §4, §12, §13.1).
 *
 * Repositories own the only Prisma interaction in this module. Services speak
 * the records below — plain domain values and string-literal enums — so a
 * Prisma row shape never crosses into orchestration logic.
 */

// ---------------------------------------------------------------------------
// Domain enumerations (mirror the Prisma enums without importing them)
// ---------------------------------------------------------------------------

export const REVIEW_STATES = [
  "queued",
  "preparing",
  "cloning",
  "analyzing",
  "investigating",
  "validating",
  "publishing",
  "completed",
  "completed_with_warnings",
  "failed",
  "cancelled",
  "superseded",
] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

export const REVIEW_TRIGGERS = ["opened", "synchronized", "ready_for_review", "manual"] as const;
export type ReviewTrigger = (typeof REVIEW_TRIGGERS)[number];

export const JOB_STATUSES = ["pending_outbox", "enqueued", "processing", "completed", "failed", "superseded"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const OUTBOX_STATUSES = ["pending", "published", "discarded"] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

// ---------------------------------------------------------------------------
// Domain records
// ---------------------------------------------------------------------------

export type InstallationRecord = {
  id: string;
  githubInstallationId: bigint;
  organization: string;
  status: "active" | "deleted";
  createdAt: Date;
  updatedAt: Date;
};

export type RepositoryRecord = {
  id: string;
  githubRepositoryId: bigint;
  installationId: string;
  fullName: string;
  defaultBranch: string | null;
  status: "active" | "disabled";
  createdAt: Date;
  updatedAt: Date;
};

export type PullRequestRecord = {
  id: string;
  repositoryId: string;
  githubPrNumber: number;
  headSha: string | null;
  baseSha: string | null;
  draft: boolean;
  status: "open" | "closed";
  createdAt: Date;
  updatedAt: Date;
};

export type ReviewRecord = {
  id: string;
  pullRequestId: string;
  githubInstallationId: bigint;
  githubRepositoryId: bigint;
  pullRequestNumber: number;
  headSha: string;
  baseSha: string | null;
  state: ReviewState;
  trigger: ReviewTrigger;
  reviewMode: string;
  reviewType: ReviewTypeValue;
  attempt: number;
  configurationHash: string | null;
  schemaVersion: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  completedAt: Date | null;
  supersededByReviewId: string | null;
  supersededAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ReviewJobRecord = {
  id: string;
  reviewId: string;
  status: JobStatus;
  attempts: number;
  lastError: string | null;
  queueJobId: string | null;
  jobKey: string;
  createdAt: Date;
  updatedAt: Date;
};

export type ReviewStateTransitionRecord = {
  id: string;
  reviewId: string;
  fromState: ReviewState | null;
  toState: ReviewState;
  createdAt: Date;
};

export type ReviewWithJob = {
  review: ReviewRecord;
  job: ReviewJobRecord | null;
};

export type ReviewStatusRecord = {
  review: ReviewRecord;
  job: ReviewJobRecord | null;
  transitions: ReviewStateTransitionRecord[];
};

export type ReviewListRecord = {
  id: string;
  state: ReviewState;
  repositoryFullName: string;
  pullRequestNumber: number;
  pullRequestId: string;
  headSha: string;
  reviewMode: string;
  trigger: ReviewTrigger;
  provider: string | null;
  model: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  errorCode: string | null;
  createdAt: Date;
};

export type ReviewListPageRecord = {
  total: number;
  reviews: ReviewListRecord[];
};

export type ReviewFindingSummaryRecord = {
  fingerprint: string;
  severity: string;
};

export type ReviewComparisonRecord = {
  id: string;
  reviewType: ReviewTypeValue;
  reviewMode: string;
  state: ReviewState;
  attempt: number;
  trigger: ReviewTrigger;
  headSha: string;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  publishSkipped: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  knowledgeSnapshot: unknown;
  errorCode: string | null;
  findings: ReviewFindingSummaryRecord[];
};

export type ListReviewPageInput = {
  /** Absent lists every state. */
  state?: ReviewState;
  limit: number;
  offset: number;
};

export type RepositoryWithInstallation = {
  repository: RepositoryRecord;
  installation: InstallationRecord;
};

export type ReviewJobWithReview = {
  job: ReviewJobRecord;
  review: ReviewRecord;
};

export type WebhookDeliveryRecord = {
  id: string;
  deliveryId: string;
  event: string;
  action: string | null;
  reviewJobId: string | null;
  processedAt: Date;
};

export type OutboxEventRecord = {
  id: string;
  reviewJobId: string;
  type: string;
  /** Validated against the outbox contract by the service before use. */
  payload: unknown;
  status: OutboxStatus;
  attempts: number;
  lastError: string | null;
  publishedAt: Date | null;
  createdAt: Date;
};

export type OutboxEventWithJob = OutboxEventRecord & {
  reviewJob: ReviewJobRecord;
};

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export type UpsertInstallationInput = {
  githubInstallationId: bigint;
  organization: string;
};

export type UpsertRepositoryInput = {
  githubRepositoryId: bigint;
  installationId: string;
  fullName: string;
  /** `null` clears nothing on update: an absent value preserves the stored branch. */
  defaultBranch: string | null;
};

export type UpsertPullRequestInput = {
  repositoryId: string;
  githubPrNumber: number;
  headSha: string;
  /** `null` never clobbers a known base SHA on update. */
  baseSha: string | null;
  draft: boolean;
};

export type FindReviewIdentityInput = {
  pullRequestId: string;
  headSha: string;
  reviewMode: string;
  reviewType: ReviewTypeValue;
  attempt: number;
};

export type FindInFlightReviewsInput = {
  pullRequestId: string;
  reviewType: ReviewTypeValue;
  /** States that are already terminal and therefore never superseded. */
  notInStates: readonly ReviewState[];
};

export type MaxReviewAttemptInput = {
  pullRequestId: string;
  headSha: string;
  reviewMode: string;
  reviewType: ReviewTypeValue;
};

export type CreateReviewInput = {
  pullRequestId: string;
  githubInstallationId: bigint;
  githubRepositoryId: bigint;
  pullRequestNumber: number;
  headSha: string;
  baseSha: string | null;
  state: ReviewState;
  trigger: ReviewTrigger;
  reviewMode: string;
  reviewType: ReviewTypeValue;
  attempt: number;
  configurationHash: string | null;
  schemaVersion: number | null;
};

export type ReviewStatePatch = {
  state: ReviewState;
  completedAt?: Date;
  errorCode?: string | null;
  errorMessage?: string | null;
  supersededByReviewId?: string | null;
  supersededAt?: Date | null;
};

export type CreateReviewJobInput = {
  reviewId: string;
  status: JobStatus;
  jobKey: string;
};

export type UpdateReviewJobInput = {
  status?: JobStatus;
  lastError?: string | null;
  queueJobId?: string | null;
};

export type FindIncompleteJobsInput = {
  statuses: readonly JobStatus[];
  notInReviewStates: readonly ReviewState[];
  limit: number;
};

export type CreateReviewStateTransitionInput = {
  reviewId: string;
  fromState: ReviewState | null;
  toState: ReviewState;
};

export type CreateWebhookDeliveryInput = {
  deliveryId: string;
  event: string;
  reviewJobId: string | null;
};

export type RepositoryFullNameRecord = {
  githubRepositoryId: bigint;
  fullName: string;
};

// ---------------------------------------------------------------------------
// Repository ports
// ---------------------------------------------------------------------------

export interface InstallationRepository {
  upsertActive(input: UpsertInstallationInput): Promise<InstallationRecord>;
}

export interface RepositoryRepository {
  upsertActive(input: UpsertRepositoryInput): Promise<RepositoryRecord>;
  findActiveByFullName(fullName: string): Promise<RepositoryWithInstallation | null>;
  /** Administrative lookup by full name, regardless of repository status. */
  findByFullName(fullName: string): Promise<RepositoryRecord | null>;
  /** Default branch for clone base resolution when no base SHA is known. */
  findDefaultBranchByGithubId(githubRepositoryId: bigint): Promise<string | null>;
  findFullNamesByGithubIds(githubRepositoryIds: readonly bigint[]): Promise<RepositoryFullNameRecord[]>;
}

export interface PullRequestRepository {
  upsertOpen(input: UpsertPullRequestInput): Promise<PullRequestRecord>;
  findByRepositoryAndNumber(repositoryId: string, githubPrNumber: number): Promise<PullRequestRecord | null>;
}

export interface ReviewRepository {
  findByIdentity(input: FindReviewIdentityInput): Promise<ReviewWithJob | null>;
  findInFlight(input: FindInFlightReviewsInput): Promise<ReviewWithJob[]>;
  maxAttempt(input: MaxReviewAttemptInput): Promise<number>;
  create(input: CreateReviewInput): Promise<ReviewRecord>;
  findById(reviewId: string): Promise<ReviewRecord | null>;
  findStateById(reviewId: string): Promise<ReviewState | null>;
  updateState(reviewId: string, patch: ReviewStatePatch): Promise<ReviewRecord>;
  resetForRecovery(reviewId: string): Promise<void>;
  markFailed(reviewId: string, errorCode: string, errorMessage: string | null): Promise<void>;
  findStatusById(reviewId: string): Promise<ReviewStatusRecord | null>;
  /** Newest-first administrative review list with repository names. */
  listPage(input: ListReviewPageInput): Promise<ReviewListPageRecord>;
  /** Reviews for one pull request with their finding fingerprints/severities. */
  findWithFindingsByPullRequest(pullRequestId: string): Promise<ReviewComparisonRecord[]>;
}

export interface ReviewJobRepository {
  create(input: CreateReviewJobInput): Promise<ReviewJobRecord>;
  update(reviewJobId: string, input: UpdateReviewJobInput): Promise<void>;
  markFailed(reviewJobId: string, lastError: string): Promise<void>;
  /** Restore a failed enqueue to `pending_outbox` only when nobody else owns the job. */
  restorePendingOutbox(reviewJobId: string): Promise<void>;
  findIncompleteWithReviews(input: FindIncompleteJobsInput): Promise<ReviewJobWithReview[]>;
  /** Durable row without its review (malformed-payload status checks). */
  findById(reviewJobId: string): Promise<ReviewJobRecord | null>;
  /** Durable row with its review (worker processing context). */
  findWithReview(reviewJobId: string): Promise<ReviewJobWithReview | null>;
  /**
   * Atomically claim a processable job (`pending_outbox`/`enqueued`/
   * `processing`) and increment its attempt counter. False when another worker
   * already owns it or it is terminal.
   */
  claimForProcessing(reviewJobId: string): Promise<boolean>;
}

export interface ReviewStateTransitionRepository {
  create(input: CreateReviewStateTransitionInput): Promise<ReviewStateTransitionRecord>;
}

export interface WebhookDeliveryRepository {
  findByDeliveryId(deliveryId: string): Promise<WebhookDeliveryRecord | null>;
  create(input: CreateWebhookDeliveryInput): Promise<void>;
}
