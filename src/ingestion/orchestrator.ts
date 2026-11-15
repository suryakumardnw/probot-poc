import type pino from "pino";
import { loadEnv } from "../config/env.js";
import { DEFAULT_CONFIG_PATH, loadReviewConfig, type ConfigurationSnapshot } from "../config/review-loader.js";
import {
  REVIEW_TYPES,
  outboxPayloadSchema,
  type IngestOutcome,
  type ReviewModeValue,
  type ReviewTriggerValue,
  type ReviewTypeValue,
} from "../contracts/queue.js";
import { createLogger } from "../lib/logger.js";
import type { ReviewState, ReviewTrigger } from "./ingestion.repository.js";
import type { IngestionRepositories, IngestionUnitOfWork } from "./ingestion.unit-of-work.js";
import { createOutboxService, publishOutboxEvent, type OutboxService, type PublishResult } from "./outbox.js";
import { createIngestionRepositories, type PrismaRootClient } from "./prisma-ingestion.repository.js";
import { createIngestionUnitOfWork, getDefaultIngestionDependencies } from "./prisma-ingestion.unit-of-work.js";
import { closeReviewQueue } from "./queue.js";
import { createReviewStateService, TERMINAL_REVIEW_STATES, type ReviewStateService } from "./review-state.js";

/**
 * Durable review ingestion (ARCHITECTURE.md §4, §12, §13.1).
 *
 * Webhook handlers stay fast: all durable work happens in a single Postgres
 * transaction (installation/repository/PR upsert, review creation, job
 * identity, superseding, webhook-delivery dedupe, outbox event), followed by
 * one best-effort BullMQ enqueue. If Redis is down, the outbox event stays
 * pending and the worker's recovery loop publishes it later.
 *
 * Idempotency (§12.3):
 * - Webhook delivery: unique WebhookDelivery.deliveryId collapses duplicate
 *   webhook deliveries (GitHub retries with the same X-GitHub-Delivery id).
 * - Review identity: unique (pullRequestId, headSha, reviewMode, reviewType,
 *   attempt) means one review per commit per type; forced manual re-reviews
 *   (`/review` command) increment `attempt` instead of deduping.
 * - Job identity: unique jobKey
 *   `installation:repository:pr:sha:mode:type[:a<attempt>]`.
 * - Outdated commits: default queue.newCommitPolicy "supersede" (§4.4) — a
 *   newer push supersedes in-flight reviews for the same PR.
 *
 * Persistence is behind repository ports and the ingestion unit of work; this
 * service receives them and never touches Prisma.
 */

const logger: pino.Logger = createLogger(loadEnv());

export type IngestTrigger = ReviewTriggerValue;

export { REVIEW_TYPES };
export type { IngestOutcome, ReviewTypeValue };

export type IngestReviewRequestInput = {
  trigger: IngestTrigger;
  installationId: number | string;
  repositoryId: number | string;
  /** Full repository name, "owner/repo". */
  repositoryName: string;
  /** Repository owner login (organization). */
  owner: string;
  defaultBranch?: string | null;
  pullRequestNumber: number;
  headSha: string;
  baseSha?: string | null;
  draft: boolean;
  /** GitHub delivery id (X-GitHub-Delivery) for webhook idempotency. */
  deliveryId?: string;
  /**
   * Which review methodology runs (§4.1): standard | skill | handbook.
   * Independent of `review.mode` (the adaptive/fixed strategy): every type
   * runs the same engine; skill/handbook inject extra instructions.
   */
  reviewType?: ReviewTypeValue;
  /**
   * Force a brand-new review even when a review already exists for the same
   * (PR, head SHA, review mode, review type) — used by the manual `/review`
   * command (§12.3): the attempt counter is incremented so identity stays
   * unique.
   */
  force?: boolean;
  /** Webhook-delivery event label recorded for idempotency (§12.1). */
  deliveryEvent?: string;
};

export type IngestReviewRequestResult = {
  outcome: IngestOutcome;
  reason?: string;
  reviewId?: string;
  jobId?: string;
  state?: ReviewState;
  /** Attempt counter of the created review (forced re-reviews). */
  attempt?: number;
};

export class ManualIngestionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManualIngestionError";
  }
}

/** Load the effective review configuration; throws when unavailable. */
export function loadIngestionConfig(): {
  config: ReturnType<typeof loadReviewConfig>["config"];
  snapshot: ConfigurationSnapshot;
} {
  const loaded = loadReviewConfig(DEFAULT_CONFIG_PATH);
  return { config: loaded.config, snapshot: loaded.snapshot };
}

// ---------------------------------------------------------------------------
// Core ingestion
// ---------------------------------------------------------------------------

export function buildJobKey(parts: {
  installationId: string;
  repositoryId: string;
  pullRequestNumber: number;
  headSha: string;
  reviewMode: ReviewModeValue;
  reviewType: ReviewTypeValue;
}): string {
  return [
    parts.installationId,
    parts.repositoryId,
    parts.pullRequestNumber,
    parts.headSha,
    parts.reviewMode,
    parts.reviewType,
  ].join(":");
}

export type IngestionServiceDependencies = {
  repositories: IngestionRepositories;
  unitOfWork: IngestionUnitOfWork;
  /** Publish one committed outbox event; never throws. */
  publish: (eventId: string) => Promise<PublishResult>;
};

export interface IngestionService {
  ingestReviewRequest(input: IngestReviewRequestInput): Promise<IngestReviewRequestResult>;
  ingestManualReview(input: ManualIngestionInput): Promise<IngestReviewRequestResult>;
  getReviewStatus(reviewId: string): Promise<ReviewStatusReport | null>;
}

export function createIngestionService(deps: IngestionServiceDependencies): IngestionService {
  /**
   * Ingest a review request durably. Never enqueues superseded reviews and
   * never creates a duplicate review for the same (PR, head SHA, mode).
   */
  async function ingestReviewRequest(input: IngestReviewRequestInput): Promise<IngestReviewRequestResult> {
    // Webhook delivery idempotency (§12.1): record the delivery first so
    // duplicate deliveries short-circuit before any transaction.
    if (input.deliveryId) {
      const existing = await deps.repositories.webhookDeliveries.findByDeliveryId(input.deliveryId);
      if (existing) {
        logger.debug({ deliveryId: input.deliveryId }, "Duplicate webhook delivery ignored");
        return { outcome: "duplicate_delivery" };
      }
    }

    let snapshot: ConfigurationSnapshot;
    try {
      snapshot = loadIngestionConfig().snapshot;
    } catch (error) {
      logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        "Review configuration unavailable; ignoring review request",
      );
      return { outcome: "configuration_unavailable", reason: "review configuration is invalid or unavailable" };
    }
    const config = snapshot.configuration;
    const reviewMode = config.review.strategy.mode;
    const reviewType: ReviewTypeValue = input.reviewType ?? "standard";
    const reviewEnabled = config.review.enabled;
    const supersede = config.queue.newCommitPolicy === "supersede";

    // Unknown review types are rejected explicitly — never silently coerced to
    // standard, which would corrupt type comparison.
    if (!REVIEW_TYPES.includes(reviewType)) {
      return { outcome: "skipped", reason: `unknown review type '${reviewType}'` };
    }

    // Draft pull requests are skipped unless explicitly enabled (§4.1).
    if (input.draft && !config.github.draftPullRequests.enabled) {
      logger.info(
        { pr: input.pullRequestNumber, repo: input.repositoryName },
        "Draft pull request skipped: github.draftPullRequests.enabled is false",
      );
      return { outcome: "skipped", reason: "draft pull requests are disabled" };
    }

    const installationId = BigInt(input.installationId);
    const repositoryId = BigInt(input.repositoryId);

    const result = await deps.unitOfWork.execute(async (repos) => {
      // 1. Upsert installation + repository + pull request (§13.1).
      const installation = await repos.installations.upsertActive({
        githubInstallationId: installationId,
        organization: input.owner,
      });
      const repository = await repos.repositories.upsertActive({
        githubRepositoryId: repositoryId,
        installationId: installation.id,
        fullName: input.repositoryName,
        defaultBranch: input.defaultBranch ?? null,
      });
      const pullRequest = await repos.pullRequests.upsertOpen({
        repositoryId: repository.id,
        githubPrNumber: input.pullRequestNumber,
        headSha: input.headSha,
        baseSha: input.baseSha ?? null,
        draft: input.draft,
      });

      // Manual `/review` requests carry no base SHA. Reuse the one captured
      // from the original pull_request webhook so the review can still compute
      // a diff (and so re-ingestion does not lose it again).
      const resolvedBaseSha = input.baseSha ?? pullRequest.baseSha ?? null;

      // 2. Review identity (§12.3): one review per (PR, head SHA, mode),
      //    unless the request is forced (manual `/review` re-review), which
      //    raises the attempt counter instead of collapsing into the existing
      //    review.
      const existingReview = input.force
        ? null
        : await repos.reviews.findByIdentity({
            pullRequestId: pullRequest.id,
            headSha: input.headSha,
            reviewMode,
            reviewType,
            attempt: 0,
          });
      if (existingReview) {
        return {
          duplicate: true as const,
          reviewId: existingReview.review.id,
          jobId: existingReview.job?.id,
          state: existingReview.review.state,
          attempt: existingReview.review.attempt,
        };
      }

      // 3. Supersede outdated in-flight reviews of this PR (§4.4).
      //    Superseding is scoped to the SAME review type: standard/skill/
      //    handbook reviews of the same PR are independent identities (§4.1)
      //    and must never cancel each other.
      const inFlight = supersede
        ? await repos.reviews.findInFlight({
            pullRequestId: pullRequest.id,
            reviewType,
            notInStates: TERMINAL_REVIEW_STATES,
          })
        : [];

      // Forced re-reviews increment the attempt so (PR, head SHA, mode, type,
      // attempt) stays unique; automatic reviews always use attempt 0 and the
      // attempt counter is per type. A forced review is always attempt >= 1
      // (e.g. the first `/review type:skill` of a PR is attempt 1), so manual
      // runs never collide with the automatic attempt-0 identity.
      let attempt = 0;
      if (input.force) {
        const maxAttempt = await repos.reviews.maxAttempt({
          pullRequestId: pullRequest.id,
          headSha: input.headSha,
          reviewMode,
          reviewType,
        });
        attempt = Math.max(maxAttempt, 0) + 1;
      }

      const review = await repos.reviews.create({
        pullRequestId: pullRequest.id,
        githubInstallationId: installationId,
        githubRepositoryId: repositoryId,
        pullRequestNumber: input.pullRequestNumber,
        headSha: input.headSha,
        baseSha: resolvedBaseSha,
        state: "queued",
        trigger: input.trigger,
        reviewMode,
        reviewType,
        attempt,
        configurationHash: snapshot.hash,
        schemaVersion: snapshot.schemaVersion,
      });
      await repos.stateTransitions.create({
        reviewId: review.id,
        fromState: null,
        toState: "queued",
      });

      const jobKeyBase = buildJobKey({
        installationId: String(installationId),
        repositoryId: String(repositoryId),
        pullRequestNumber: input.pullRequestNumber,
        headSha: input.headSha,
        reviewMode,
        reviewType,
      });
      // Attempt > 0 (forced re-review) gets a distinct durable job identity.
      const jobKey = attempt > 0 ? `${jobKeyBase}:a${attempt}` : jobKeyBase;
      const job = await repos.reviewJobs.create({
        reviewId: review.id,
        status: "pending_outbox",
        jobKey,
      });

      for (const outdated of inFlight) {
        await repos.reviews.updateState(outdated.review.id, {
          state: "superseded",
          supersededByReviewId: review.id,
          supersededAt: new Date(),
        });
        await repos.stateTransitions.create({
          reviewId: outdated.review.id,
          fromState: outdated.review.state,
          toState: "superseded",
        });
        if (outdated.job) {
          await repos.reviewJobs.update(outdated.job.id, {
            status: "superseded",
            lastError: `superseded by review ${review.id}`,
          });
          await repos.outboxEvents.discardPendingForJob(outdated.job.id, `superseded by review ${review.id}`);
        }
      }

      // 4. Transactional outbox event (§12.2). The snapshot is parsed through
      // the outbox contract before it is committed, so ingestion can never
      // write a payload the publisher would later reject.
      const outboxEvent = await repos.outboxEvents.create({
        reviewJobId: job.id,
        type: "review.requested",
        payload: outboxPayloadSchema.parse({
          reviewId: review.id,
          jobKey,
          githubInstallationId: String(installationId),
          githubRepositoryId: String(repositoryId),
          repositoryFullName: input.repositoryName,
          pullRequestNumber: input.pullRequestNumber,
          headSha: input.headSha,
          baseSha: resolvedBaseSha,
          reviewMode,
          reviewType,
          trigger: input.trigger,
          configurationHash: snapshot.hash,
          reviewEnabled,
        }),
      });

      return {
        duplicate: false as const,
        reviewId: review.id,
        jobId: job.id,
        outboxEventId: outboxEvent.id,
        state: "queued" as const,
        attempt,
      };
    });

    // Record the webhook delivery only once durable state is committed.
    if (input.deliveryId) {
      await deps.repositories.webhookDeliveries
        .create({
          deliveryId: input.deliveryId,
          event: input.deliveryEvent ?? `pull_request.${input.trigger}`,
          reviewJobId: result.jobId ?? null,
        })
        .catch(() => {
          // Concurrent duplicate delivery: the review identity check above
          // still guarantees a single review.
        });
    }

    if (result.duplicate) {
      return {
        outcome: "duplicate",
        reason: "a review already exists for this commit",
        reviewId: result.reviewId,
        jobId: result.jobId,
        state: result.state,
      };
    }

    // 5. Post-commit best-effort enqueue. On failure the outbox event stays
    // pending and recoverOutbox() retries (§12.2).
    const publishResult = await deps.publish(result.outboxEventId);
    if (publishResult === "failed") {
      logger.info({ reviewId: result.reviewId }, "Review queued durably; enqueue deferred to outbox recovery");
    }

    return {
      outcome: "created",
      reviewId: result.reviewId,
      jobId: result.jobId,
      state: result.state,
      attempt: result.attempt,
    };
  }

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

    return ingestReviewRequest({
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

  return { ingestReviewRequest, ingestManualReview, getReviewStatus };
}

// ---------------------------------------------------------------------------
// Manual ingestion input
// ---------------------------------------------------------------------------

export type ManualIngestionInput = {
  /** Full repository name, "owner/repo". */
  repository: string;
  pullRequestNumber: number;
  headSha?: string;
  /** Which review methodology runs (§4.1); defaults to "standard". */
  reviewType?: ReviewTypeValue;
};

// ---------------------------------------------------------------------------
// Job / review status tracking
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Temporary module-edge composition (PR 2.1 → PR 2.6)
// ---------------------------------------------------------------------------

export interface IngestionServices extends IngestionService, OutboxService, ReviewStateService {}

/**
 * Build the ingestion module's services for one Prisma client.
 *
 * Temporary for PR 2.1: the bootstrap composition root replaces this factory
 * in PR 2.6. Services themselves never read the Prisma singleton.
 */
export function createIngestionServices(prisma: PrismaRootClient): IngestionServices {
  const repositories = createIngestionRepositories(prisma);
  const unitOfWork = createIngestionUnitOfWork(prisma);
  const outbox = createOutboxService({ repositories, unitOfWork });
  const reviewState = createReviewStateService({ unitOfWork });
  const ingestion = createIngestionService({
    repositories,
    unitOfWork,
    publish: (eventId) => outbox.publishOutboxEvent(eventId),
  });
  return { ...ingestion, ...outbox, ...reviewState };
}

let defaultIngestionService: IngestionService | undefined;

function getDefaultIngestionService(): IngestionService {
  defaultIngestionService ??= createIngestionService({
    ...getDefaultIngestionDependencies(),
    publish: (eventId) => publishOutboxEvent(eventId),
  });
  return defaultIngestionService;
}

/**
 * Module-edge compatibility functions for existing callers. PR 2.6 wires the
 * composition root and removes these wrappers.
 */
export async function ingestReviewRequest(input: IngestReviewRequestInput): Promise<IngestReviewRequestResult> {
  return getDefaultIngestionService().ingestReviewRequest(input);
}

export async function ingestManualReview(input: ManualIngestionInput): Promise<IngestReviewRequestResult> {
  return getDefaultIngestionService().ingestManualReview(input);
}

export async function getReviewStatus(reviewId: string): Promise<ReviewStatusReport | null> {
  return getDefaultIngestionService().getReviewStatus(reviewId);
}

/** Used by the worker on shutdown and tests on teardown. */
export async function closeIngestion(): Promise<void> {
  await closeReviewQueue();
}
