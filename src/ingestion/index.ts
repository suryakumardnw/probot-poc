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
 * Persistence is behind repository ports and the ingestion unit of work; the
 * services receive them and never touch Prisma.
 */

import type { ReviewConfigStore } from "../ports/review-config.js";
import { createIngestionReadService, type IngestionReadService } from "./ingestion-read.service.js";
import { createIngestionService, type IngestionService } from "./ingestion.service.js";
import { createOutboxService, type OutboxService } from "./outbox.service.js";
import type { PrismaRootClient } from "./prisma-ingestion.repository.js";
import { createIngestionDependencies } from "./prisma-ingestion.unit-of-work.js";
import { closeReviewQueue } from "./queue.js";
import { createOutboxRecoveryService, type OutboxRecoveryService } from "./recovery.service.js";
import { createReviewStateService, type ReviewStateService } from "./review-state.service.js";

export { REVIEW_TYPES } from "../contracts/queue.js";
export type { IngestOutcome, ReviewTypeValue } from "../contracts/queue.js";
export {
  createIngestionReadService,
  getReviewStatus,
  ingestManualReview,
  type IngestionReadService,
  type IngestionReadServiceDependencies,
  type ReviewComparisonInput,
  type ReviewComparisonLookup,
  type ReviewListQueryInput,
  type ReviewListReport,
  type ReviewStatusReport,
} from "./ingestion-read.service.js";
export {
  buildJobKey,
  createIngestionService,
  ingestReviewRequest,
  type IngestionService,
  type IngestionServiceDependencies,
} from "./ingestion.service.js";
export {
  ManualIngestionError,
  type IngestReviewRequestInput,
  type IngestReviewRequestResult,
  type IngestTrigger,
  type ManualIngestionInput,
} from "./ingestion.types.js";
export type { IngestionRepositories, IngestionUnitOfWork } from "./ingestion.unit-of-work.js";
export {
  createOutboxService,
  publishOutboxEvent,
  type OutboxService,
  type OutboxServiceDependencies,
  type PublishResult,
} from "./outbox.service.js";
export {
  createOutboxRecoveryService,
  recoverOutbox,
  type OutboxRecoveryService,
  type OutboxRecoveryServiceDependencies,
  type OutboxRecoverySummary,
} from "./recovery.service.js";
export {
  InvalidStateTransitionError,
  REVIEW_STATES,
  TERMINAL_REVIEW_STATES,
  canTransition,
  createReviewStateService,
  isTerminalReviewState,
  transitionReviewState,
  type ReviewStateService,
  type ReviewStateServiceDependencies,
  type TransitionOptions,
} from "./review-state.service.js";

// ---------------------------------------------------------------------------
// Temporary module-edge composition (PR 2.1 → PR 2.6)
// ---------------------------------------------------------------------------

export interface IngestionServices
  extends IngestionService, IngestionReadService, OutboxService, OutboxRecoveryService, ReviewStateService {}

/**
 * Build the ingestion module's services for one Prisma client.
 *
 * Temporary for PR 2.1: the bootstrap composition root replaces this factory
 * in PR 2.6. Services themselves never read the Prisma singleton.
 */
export function createIngestionServices(prisma: PrismaRootClient, config?: ReviewConfigStore): IngestionServices {
  const dependencies = createIngestionDependencies(prisma, config);
  const { repositories } = dependencies;
  const outbox = createOutboxService(dependencies);
  const recovery = createOutboxRecoveryService({
    repositories,
    publish: (eventId, queue) => outbox.publishOutboxEvent(eventId, queue),
  });
  const reviewState = createReviewStateService({ unitOfWork: dependencies.unitOfWork });
  const ingestion = createIngestionService({
    ...dependencies,
    publish: (eventId) => outbox.publishOutboxEvent(eventId),
  });
  const read = createIngestionReadService({ repositories, ingestion });
  return { ...ingestion, ...read, ...outbox, ...recovery, ...reviewState };
}

/** Used by the worker on shutdown and tests on teardown. */
export async function closeIngestion(): Promise<void> {
  await closeReviewQueue();
}
