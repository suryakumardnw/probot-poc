/**
 * Permanent review-job failure, independent of the queue vendor.
 *
 * Application processing decides that a failure cannot become valid by
 * retrying; the queue adapter translates this signal into BullMQ's
 * `UnrecoverableError` so the configured retry budget is not consumed.
 * Modules never import the vendor's error class.
 */
export class UnrecoverableJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnrecoverableJobError";
  }
}
