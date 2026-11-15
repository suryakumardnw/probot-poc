import { ERROR_CODES } from "../contracts/errors.js";
import { reviewJobPayloadSchema, type ReviewJobPayload } from "../contracts/queue.js";
import { ValidationError } from "./errors/index.js";

/**
 * Queue name and worker-side payload parsing.
 *
 * Both are transport-neutral contract helpers shared by the BullMQ adapter
 * (`src/platform/queue`) and the worker processor. They live in `shared` so
 * application modules can parse the durable payload without importing the
 * platform adapter.
 */

export const REVIEW_QUEUE_NAME = "review-jobs";

/**
 * Parse a BullMQ job's `data` at the worker boundary.
 *
 * A failure here is permanent: retrying cannot repair the stored payload, so
 * the worker records the stable code durably and lets BullMQ fail the job
 * without consuming its retry budget.
 */
export function parseReviewJobPayload(data: unknown): ReviewJobPayload {
  const parsed = reviewJobPayloadSchema.safeParse(data);
  if (!parsed.success) {
    throw new ValidationError("Review job payload does not match the queue contract", {
      code: ERROR_CODES.REVIEW_JOB_PAYLOAD_INVALID,
      details: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}
