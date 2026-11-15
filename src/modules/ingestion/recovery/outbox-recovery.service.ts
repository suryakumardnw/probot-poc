import type { IngestionRepositories } from "../ingestion.unit-of-work.js";
import type { PublishResult } from "../outbox.service.js";

/**
 * Outbox recovery loop (ARCHITECTURE.md §12.2).
 *
 * Pending outbox events are re-published oldest first. The worker calls this
 * periodically and right after startup; a Redis outage leaves events pending
 * until the next pass. Never throws.
 */

export type OutboxRecoverySummary = {
  scanned: number;
  published: number;
  discarded: number;
  failed: number;
};

export type OutboxRecoveryServiceDependencies = {
  repositories: IngestionRepositories;
  /** Publish one committed outbox event; never throws. */
  publish: (eventId: string) => Promise<PublishResult>;
};

export interface OutboxRecoveryService {
  /**
   * Re-publish pending outbox events (oldest first). Called periodically by
   * the worker and right after startup. Never throws.
   */
  recoverOutbox(limit?: number): Promise<OutboxRecoverySummary>;
}

export function createOutboxRecoveryService(deps: OutboxRecoveryServiceDependencies): OutboxRecoveryService {
  async function recoverOutbox(limit = 100): Promise<OutboxRecoverySummary> {
    let pending: string[] = [];
    try {
      pending = await deps.repositories.outboxEvents.findPendingIds(limit);
    } catch {
      pending = [];
    }

    const summary: OutboxRecoverySummary = { scanned: pending.length, published: 0, discarded: 0, failed: 0 };
    for (const eventId of pending) {
      const result = await deps.publish(eventId);
      if (result === "published") {
        summary.published += 1;
      } else if (result === "discarded") {
        summary.discarded += 1;
      } else if (result === "failed") {
        summary.failed += 1;
      }
    }
    return summary;
  }

  return { recoverOutbox };
}
