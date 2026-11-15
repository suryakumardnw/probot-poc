import { REVIEW_TYPES, outboxPayloadSchema, type ReviewModeValue, type ReviewTypeValue } from "../contracts/queue.js";
import type { Logger } from "../ports/logger.js";
import type { LoadedReviewConfig, ReviewConfigStore } from "../ports/review-config.js";
import type { TransitionReviewStateResult } from "./ingestion.repository.js";
import type { IngestReviewRequestInput, IngestReviewRequestResult } from "./ingestion.types.js";
import type { IngestionRepositories, IngestionUnitOfWork } from "./ingestion.unit-of-work.js";
import type { PublishResult } from "./outbox.service.js";
import { REVIEW_STATES, TERMINAL_REVIEW_STATES, canTransition } from "./review-state.service.js";

/**
 * Durable review intake (ARCHITECTURE.md §4, §12, §13.1). The full idempotency
 * contract is documented on the module entry point (`index.ts`).
 */

/** Non-terminal states the state machine permits a move into `superseded`. */
const SUPERSEDE_ALLOWED_FROM_STATES = REVIEW_STATES.filter((state) => canTransition(state, "superseded"));

/**
 * Supersede can lose a race to a worker that advances the review through a
 * non-terminal state. Retry against the winning state a bounded number of
 * times; a terminal winner is never overwritten.
 */
const SUPERSEDE_MAX_ATTEMPTS = 3;

async function transitionToSuperseded(
  repos: IngestionRepositories,
  input: { reviewId: string; replacementReviewId: string; supersededAt: Date },
): Promise<TransitionReviewStateResult> {
  const transition = {
    reviewId: input.reviewId,
    toState: "superseded" as const,
    patch: {
      supersededByReviewId: input.replacementReviewId,
      supersededAt: input.supersededAt,
    },
  };

  let result = await repos.reviews.transitionState({
    ...transition,
    allowedFromStates: SUPERSEDE_ALLOWED_FROM_STATES,
  });

  for (let attempt = 1; attempt < SUPERSEDE_MAX_ATTEMPTS; attempt += 1) {
    if (result.outcome !== "conflict" || !canTransition(result.currentState, "superseded")) {
      return result;
    }
    result = await repos.reviews.transitionState({
      ...transition,
      allowedFromStates: [result.currentState],
    });
  }

  return result;
}

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
  config: ReviewConfigStore;
  logger: Logger;
  /** Publish one committed outbox event; never throws. */
  publish: (eventId: string) => Promise<PublishResult>;
};

export interface IngestionService {
  ingestReviewRequest(input: IngestReviewRequestInput): Promise<IngestReviewRequestResult>;
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
        deps.logger.debug({ deliveryId: input.deliveryId }, "Duplicate webhook delivery ignored");
        return { outcome: "duplicate_delivery" };
      }
    }

    let loaded: LoadedReviewConfig;
    try {
      loaded = deps.config.load();
    } catch (error) {
      deps.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        "Review configuration unavailable; ignoring review request",
      );
      return { outcome: "configuration_unavailable", reason: "review configuration is invalid or unavailable" };
    }
    const config = loaded.config;
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
      deps.logger.info(
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
        configurationHash: loaded.snapshot.hash,
        schemaVersion: loaded.snapshot.schemaVersion,
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
        const superseded = await transitionToSuperseded(repos, {
          reviewId: outdated.review.id,
          replacementReviewId: review.id,
          supersededAt: new Date(),
        });

        // The in-flight snapshot can go stale while this transaction runs. A
        // review that completed first must never be overwritten, and a lost
        // race must never write a second audit row.
        if (superseded.outcome === "conflict") {
          deps.logger.info(
            { reviewId: outdated.review.id, currentState: superseded.currentState, replacementReviewId: review.id },
            "Skipped supersede: review kept advancing or reached a terminal state",
          );
          continue;
        }
        if (superseded.outcome === "not_found") {
          deps.logger.info(
            { reviewId: outdated.review.id, replacementReviewId: review.id },
            "Skipped supersede: review no longer exists",
          );
          continue;
        }
        if (superseded.outcome === "unchanged") {
          deps.logger.debug(
            { reviewId: outdated.review.id, replacementReviewId: review.id },
            "Supersede already applied by a concurrent writer",
          );
          continue;
        }

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
          configurationHash: loaded.snapshot.hash,
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
      deps.logger.info({ reviewId: result.reviewId }, "Review queued durably; enqueue deferred to outbox recovery");
    }

    return {
      outcome: "created",
      reviewId: result.reviewId,
      jobId: result.jobId,
      state: result.state,
      attempt: result.attempt,
    };
  }

  return { ingestReviewRequest };
}
