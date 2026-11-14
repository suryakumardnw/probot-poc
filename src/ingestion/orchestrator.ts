import type { ReviewState, ReviewTrigger } from "@prisma/client";
import type pino from "pino";
import { loadEnv } from "../config/env.js";
import { DEFAULT_CONFIG_PATH, loadReviewConfig, type ConfigurationSnapshot } from "../config/review-loader.js";
import { createLogger } from "../lib/logger.js";
import { getPrisma } from "../lib/prisma.js";
import { publishOutboxEvent } from "./outbox.js";
import { closeReviewQueue } from "./queue.js";
import { TERMINAL_REVIEW_STATES } from "./review-state.js";

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
 */

const logger: pino.Logger = createLogger(loadEnv());

export type IngestTrigger = "opened" | "synchronized" | "ready_for_review" | "manual";

/** Review types (ARCHITECTURE.md §4.1). Mirrors the Prisma ReviewType enum. */
export const REVIEW_TYPES = ["standard", "skill", "handbook"] as const;
export type ReviewTypeValue = (typeof REVIEW_TYPES)[number];

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

export type IngestOutcome = "created" | "duplicate" | "skipped" | "duplicate_delivery" | "configuration_unavailable";

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
  reviewMode: string;
  reviewType: string;
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

/**
 * Ingest a review request durably. Never enqueues superseded reviews and
 * never creates a duplicate review for the same (PR, head SHA, mode).
 */
export async function ingestReviewRequest(input: IngestReviewRequestInput): Promise<IngestReviewRequestResult> {
  // Webhook delivery idempotency (§12.1): record the delivery first so
  // duplicate deliveries short-circuit before any transaction.
  if (input.deliveryId) {
    const existing = await getPrisma().webhookDelivery.findUnique({ where: { deliveryId: input.deliveryId } });
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

  const prisma = getPrisma();
  const result = await prisma.$transaction(async (tx) => {
    // 1. Upsert installation + repository + pull request (§13.1).
    const installation = await tx.installation.upsert({
      where: { githubInstallationId: installationId },
      create: { githubInstallationId: installationId, organization: input.owner, status: "active" },
      update: { status: "active", organization: input.owner },
    });
    const repository = await tx.repository.upsert({
      where: { githubRepositoryId: repositoryId },
      create: {
        githubRepositoryId: repositoryId,
        installationId: installation.id,
        fullName: input.repositoryName,
        defaultBranch: input.defaultBranch ?? null,
        status: "active",
      },
      update: {
        fullName: input.repositoryName,
        defaultBranch: input.defaultBranch ?? undefined,
        installationId: installation.id,
        status: "active",
      },
    });
    const pullRequest = await tx.pullRequest.upsert({
      where: { repositoryId_githubPrNumber: { repositoryId: repository.id, githubPrNumber: input.pullRequestNumber } },
      create: {
        repositoryId: repository.id,
        githubPrNumber: input.pullRequestNumber,
        headSha: input.headSha,
        baseSha: input.baseSha ?? null,
        draft: input.draft,
        status: "open",
      },
      update: {
        headSha: input.headSha,
        // Never clobber a known base SHA with null: manual `/review` ingestion
        // has no base SHA, and wiping the stored one leaves the workspace with
        // nothing to diff against.
        baseSha: input.baseSha ?? undefined,
        draft: input.draft,
        status: "open",
      },
    });

    // Manual `/review` requests carry no base SHA. Reuse the one captured from
    // the original pull_request webhook so the review can still compute a diff
    // (and so re-ingestion does not lose it again).
    const resolvedBaseSha = input.baseSha ?? pullRequest.baseSha ?? null;

    // 2. Review identity (§12.3): one review per (PR, head SHA, mode), unless
    //    the request is forced (manual `/review` re-review), which raises the
    //    attempt counter instead of collapsing into the existing review.
    const existingReview = input.force
      ? null
      : await tx.review.findUnique({
          where: {
            pullRequestId_headSha_reviewMode_reviewType_attempt: {
              pullRequestId: pullRequest.id,
              headSha: input.headSha,
              reviewMode,
              reviewType,
              attempt: 0,
            },
          },
          include: { job: true },
        });
    if (existingReview) {
      return {
        duplicate: true as const,
        reviewId: existingReview.id,
        jobId: existingReview.job?.id,
        state: existingReview.state,
        attempt: existingReview.attempt,
      };
    }

    // 3. Supersede outdated in-flight reviews of this PR (§4.4). Superseding
    //    is scoped to the SAME review type: standard/skill/handbook reviews
    //    of the same PR are independent identities (§4.1) and must never
    //    cancel each other.
    const inFlight = supersede
      ? await tx.review.findMany({
          where: { pullRequestId: pullRequest.id, reviewType, state: { notIn: [...TERMINAL_REVIEW_STATES] } },
          include: { job: true },
        })
      : [];

    // Forced re-reviews increment the attempt so (PR, head SHA, mode, type,
    // attempt) stays unique; automatic reviews always use attempt 0 and the
    // attempt counter is per type. A forced review is always attempt >= 1
    // (e.g. the first `/review type:skill` of a PR is attempt 1), so manual
    // runs never collide with the automatic attempt-0 identity.
    let attempt = 0;
    if (input.force) {
      const aggregate = await tx.review.aggregate({
        where: { pullRequestId: pullRequest.id, headSha: input.headSha, reviewMode, reviewType },
        _max: { attempt: true },
      });
      attempt = Math.max(aggregate._max.attempt ?? 0, 0) + 1;
    }

    const review = await tx.review.create({
      data: {
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
      },
    });
    await tx.reviewStateTransition.create({
      data: { reviewId: review.id, fromState: null, toState: "queued" },
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
    const job = await tx.reviewJob.create({
      data: { reviewId: review.id, status: "pending_outbox", jobKey },
    });

    for (const outdated of inFlight) {
      await tx.review.update({
        where: { id: outdated.id },
        data: { state: "superseded", supersededByReviewId: review.id, supersededAt: new Date() },
      });
      await tx.reviewStateTransition.create({
        data: { reviewId: outdated.id, fromState: outdated.state, toState: "superseded" },
      });
      if (outdated.job) {
        await tx.reviewJob.update({
          where: { id: outdated.job.id },
          data: { status: "superseded", lastError: `superseded by review ${review.id}` },
        });
        await tx.outboxEvent.updateMany({
          where: { reviewJobId: outdated.job.id, status: "pending" },
          data: { status: "discarded", lastError: `superseded by review ${review.id}` },
        });
      }
    }

    // 4. Transactional outbox event (§12.2).
    const outboxEvent = await tx.outboxEvent.create({
      data: {
        reviewJobId: job.id,
        type: "review.requested",
        payload: {
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
        },
      },
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
    await prisma.webhookDelivery
      .create({
        data: {
          deliveryId: input.deliveryId,
          event: input.deliveryEvent ?? `pull_request.${input.trigger}`,
          reviewJobId: result.jobId ?? null,
        },
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
  const publishResult = await publishOutboxEvent(result.outboxEventId);
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

// ---------------------------------------------------------------------------
// Manual ingestion (no auth in this milestone; §15 notes hardening for later)
// ---------------------------------------------------------------------------

export type ManualIngestionInput = {
  /** Full repository name, "owner/repo". */
  repository: string;
  pullRequestNumber: number;
  headSha?: string;
  /** Which review methodology runs (§4.1); defaults to "standard". */
  reviewType?: ReviewTypeValue;
};

export async function ingestManualReview(input: ManualIngestionInput): Promise<IngestReviewRequestResult> {
  const prisma = getPrisma();
  const repository = await prisma.repository.findFirst({
    where: { fullName: input.repository, status: "active" },
    include: { installation: true },
  });
  if (!repository) {
    throw new ManualIngestionError(`Repository '${input.repository}' is not registered`);
  }
  const pullRequest = await prisma.pullRequest.findUnique({
    where: { repositoryId_githubPrNumber: { repositoryId: repository.id, githubPrNumber: input.pullRequestNumber } },
  });
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
    installationId: repository.installation.githubInstallationId.toString(),
    repositoryId: repository.githubRepositoryId.toString(),
    repositoryName: repository.fullName,
    owner: repository.installation.organization,
    defaultBranch: repository.defaultBranch,
    pullRequestNumber: pullRequest.githubPrNumber,
    headSha,
    baseSha: pullRequest.baseSha,
    draft: pullRequest.draft,
  });
}

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

export async function getReviewStatus(reviewId: string): Promise<ReviewStatusReport | null> {
  const review = await getPrisma().review.findUnique({
    where: { id: reviewId },
    include: { job: true, transitions: { orderBy: { createdAt: "asc" } } },
  });
  if (!review) {
    return null;
  }
  return {
    review: {
      id: review.id,
      state: review.state,
      trigger: review.trigger,
      reviewMode: review.reviewMode,
      headSha: review.headSha,
      configurationHash: review.configurationHash,
      createdAt: review.createdAt,
      completedAt: review.completedAt,
      errorCode: review.errorCode,
    },
    job: review.job
      ? {
          id: review.job.id,
          status: review.job.status,
          attempts: review.job.attempts,
          lastError: review.job.lastError,
          queueJobId: review.job.queueJobId,
          jobKey: review.job.jobKey,
        }
      : null,
    transitions: review.transitions.map((t) => ({ fromState: t.fromState, toState: t.toState, at: t.createdAt })),
  };
}

/** Used by the worker on shutdown and tests on teardown. */
export async function closeIngestion(): Promise<void> {
  await closeReviewQueue();
}
