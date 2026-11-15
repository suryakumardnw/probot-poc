import { z } from "zod";

/**
 * Queue, outbox, and ingestion-outcome contracts.
 *
 * A review request is committed to Postgres first (review + job + outbox
 * event), then published to BullMQ. The same immutable request snapshot moves
 * across all three boundaries, so there is exactly one schema and one inferred
 * type per payload.
 *
 * Backward compatibility: `baseSha` and `configurationHash` are optional and
 * nullable because manual `/review` requests and payloads written before this
 * contract may omit them. `reviewMode` also accepts the legacy `standard` and
 * `full` names written before the adaptive/fixed split (see
 * `LEGACY_REVIEW_MODES`), so old non-terminal rows can still be recovered. No
 * field that existing queued payloads already omit is required here. Values
 * that were previously filled with silent defaults (empty installation id,
 * empty SHA, pull request number 0) are now rejected: a malformed payload fails
 * loudly instead of running a review against an invented identity.
 */

/** Review strategy stored on the Review row (`review.strategy.mode`). */
export const REVIEW_MODES = ["adaptive", "fixed"] as const;

/**
 * Legacy review-mode names still present on rows and outbox payloads written
 * before the adaptive/fixed strategy split. `standard` was the old column
 * default and `full` was the old full-review mode. They remain accepted at the
 * queue boundary so reconciliation can recover old non-terminal reviews
 * instead of rejecting them forever; new ingestion only writes `adaptive` or
 * `fixed` (the current `review.strategy.mode` values).
 */
export const LEGACY_REVIEW_MODES = ["standard", "full"] as const;

/** Every value the durable/queue boundary accepts (current + legacy). */
export const REVIEW_MODE_VALUES = [...REVIEW_MODES, ...LEGACY_REVIEW_MODES] as const;

export type ReviewModeValue = (typeof REVIEW_MODE_VALUES)[number];

/** Review methodology (§4.1). Mirrors the Prisma ReviewType enum. */
export const REVIEW_TYPES = ["standard", "skill", "handbook"] as const;
export type ReviewTypeValue = (typeof REVIEW_TYPES)[number];

/** Ingestion triggers. Mirrors the Prisma ReviewTrigger enum. */
export const REVIEW_TRIGGERS = ["opened", "synchronized", "ready_for_review", "manual"] as const;
export type ReviewTriggerValue = (typeof REVIEW_TRIGGERS)[number];

const reviewModeSchema = z.enum(REVIEW_MODE_VALUES);
const reviewTypeSchema = z.enum(REVIEW_TYPES);
const reviewTriggerSchema = z.enum(REVIEW_TRIGGERS);

/**
 * The queue payload consumed by the review worker. Every field except the two
 * backward-compatible optional ones is required: the worker refuses a job it
 * cannot identify completely.
 */
export const reviewJobPayloadSchema = z.object({
  reviewId: z.string().min(1),
  jobKey: z.string().min(1),
  githubInstallationId: z.string().min(1),
  githubRepositoryId: z.string().min(1),
  repositoryFullName: z.string().min(1),
  pullRequestNumber: z.number().int().positive(),
  headSha: z.string().min(1),
  /** Absent for manual reviews and older payloads; the worker falls back to the default branch. */
  baseSha: z.string().min(1).nullable().optional(),
  reviewMode: reviewModeSchema,
  reviewType: reviewTypeSchema,
  trigger: reviewTriggerSchema,
  /** Absent when the configuration snapshot had no hash. */
  configurationHash: z.string().min(1).nullable().optional(),
});

export type ReviewJobPayload = z.infer<typeof reviewJobPayloadSchema>;

/**
 * The payload stored on an outbox event. It is the queue payload plus the
 * ingestion-time `reviewEnabled` snapshot flag. Unknown fields are stripped by
 * the schema; `reviewEnabled` is kept so the stored shape stays complete.
 */
export const outboxPayloadSchema = reviewJobPayloadSchema.extend({
  reviewEnabled: z.boolean().optional(),
});

export type OutboxPayload = z.infer<typeof outboxPayloadSchema>;

/**
 * Outcome returned by review ingestion. It crosses the HTTP boundary in the
 * manual-review response (`POST /api/reviews`), so it has a schema too.
 */
export const INGEST_OUTCOMES = [
  "created",
  "duplicate",
  "skipped",
  "duplicate_delivery",
  "configuration_unavailable",
] as const;
export const ingestOutcomeSchema = z.enum(INGEST_OUTCOMES);
export type IngestOutcome = z.infer<typeof ingestOutcomeSchema>;
