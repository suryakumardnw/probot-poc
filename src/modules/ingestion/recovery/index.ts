/**
 * Ingestion recovery (ARCHITECTURE.md §12.2, §17.3).
 *
 * Two loops keep durable ingestion work moving when Redis or the worker loses
 * execution state, so both live under one owner:
 *
 * - outbox recovery republishes committed outbox events that could not be
 *   enqueued;
 * - startup reconciliation re-enqueues incomplete reviews with the same
 *   BullMQ job identity (jobId = ReviewJob.id), so recovery never duplicates
 *   queue work.
 */

export {
  createOutboxRecoveryService,
  type OutboxRecoveryService,
  type OutboxRecoveryServiceDependencies,
  type OutboxRecoverySummary,
} from "./outbox-recovery.service.js";
export { REDIS_PERSISTENCE_COMMANDLINE } from "./redis-persistence.js";
export {
  reconcileIncompleteReviews,
  resetReviewForRecovery,
  type ReconciliationDependencies,
  type ReconciliationDeps,
  type ReconciliationSummary,
  type RecoveryPolicy,
} from "./reconciliation.service.js";
