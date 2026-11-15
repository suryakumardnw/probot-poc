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

import type { Clock } from "../ports/clock.js";
import type { Logger } from "../ports/logger.js";
import type { ReviewConfigStore } from "../ports/review-config.js";
import { createIngestionReadService, type IngestionReadService } from "./ingestion-read.service.js";
import { createIngestionService, type IngestionService } from "./ingestion.service.js";
import type { IngestionRepositories, IngestionUnitOfWork } from "./ingestion.unit-of-work.js";
import { createOutboxService, type OutboxService } from "./outbox.service.js";
import type { ReviewQueueWriter } from "./queue.js";
import { createOutboxRecoveryService, type OutboxRecoveryService } from "./recovery.service.js";
import { createReviewStateService, type ReviewStateService } from "./review-state.service.js";

export { REVIEW_TYPES } from "../contracts/queue.js";
export type { IngestOutcome, ReviewTypeValue } from "../contracts/queue.js";
export {
  createIngestionReadService,
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
  type OutboxService,
  type OutboxServiceDependencies,
  type PublishResult,
} from "./outbox.service.js";
export {
  createOutboxRecoveryService,
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
  type ReviewStateService,
  type ReviewStateServiceDependencies,
  type TransitionOptions,
} from "./review-state.service.js";

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

export interface IngestionServices
  extends IngestionService, IngestionReadService, OutboxService, OutboxRecoveryService, ReviewStateService {}

export interface IngestionServicesDependencies {
  repositories: IngestionRepositories;
  unitOfWork: IngestionUnitOfWork;
  config: ReviewConfigStore;
  queue: ReviewQueueWriter;
  logger: Logger;
  clock: Clock;
}

/**
 * Build the ingestion module's services for one set of injected dependencies.
 *
 * Bootstrap constructs the repositories and the BullMQ queue once and passes
 * them in; tests use the same factory with their own clients. No service
 * reaches for a process-wide singleton.
 */
export function createIngestionServices(deps: IngestionServicesDependencies): IngestionServices {
  const { repositories, unitOfWork, config, queue, logger, clock } = deps;
  const outbox = createOutboxService({ repositories, unitOfWork, config, queue, logger });
  const recovery = createOutboxRecoveryService({
    repositories,
    publish: (eventId) => outbox.publishOutboxEvent(eventId),
  });
  const reviewState = createReviewStateService({ repositories, clock });
  const ingestion = createIngestionService({
    repositories,
    unitOfWork,
    config,
    logger,
    publish: (eventId) => outbox.publishOutboxEvent(eventId),
  });
  const read = createIngestionReadService({ repositories, ingestion });
  return { ...ingestion, ...read, ...outbox, ...recovery, ...reviewState };
}
