import type { IngestOutcome, ReviewTriggerValue, ReviewTypeValue } from "../../contracts/queue.js";
import type { ReviewState } from "./ingestion.repository.js";

/**
 * Public request/result contracts for durable review ingestion
 * (ARCHITECTURE.md §4, §12, §13.1).
 */

export type IngestTrigger = ReviewTriggerValue;

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

export type ManualIngestionInput = {
  /** Full repository name, "owner/repo". */
  repository: string;
  pullRequestNumber: number;
  headSha?: string;
  /** Which review methodology runs (§4.1); defaults to "standard". */
  reviewType?: ReviewTypeValue;
};
