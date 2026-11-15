import type { OutboxPayload } from "../contracts/queue.js";
import type { OutboxEventRecord, OutboxEventWithJob } from "./ingestion.repository.js";

/**
 * Transactional outbox repository port (ARCHITECTURE.md §12.2).
 *
 * The outbox row is the durable request snapshot: publication state and retry
 * bookkeeping live here, while the queue itself is execution state.
 */

export type CreateOutboxEventInput = {
  reviewJobId: string;
  type: string;
  payload: OutboxPayload;
};

export interface OutboxRepository {
  create(input: CreateOutboxEventInput): Promise<OutboxEventRecord>;
  findByIdWithJob(eventId: string): Promise<OutboxEventWithJob | null>;
  findLatestForJob(reviewJobId: string): Promise<OutboxEventRecord | null>;
  findPendingIds(limit: number): Promise<string[]>;
  markPublished(eventId: string, publishedAt: Date): Promise<void>;
  /** Unconditional discard (the caller already checked the status). */
  discard(eventId: string, lastError: string): Promise<void>;
  /** Discard only while pending; returns whether this caller won the race. */
  discardIfPending(eventId: string, lastError: string): Promise<boolean>;
  /** Discard every pending event of a superseded job. */
  discardPendingForJob(reviewJobId: string, lastError: string): Promise<void>;
  /** Record a retryable publish failure while the event is still pending. */
  incrementAttemptsIfPending(eventId: string, lastError: string): Promise<void>;
}
