/**
 * Ports barrel: interfaces for external dependencies.
 *
 * Modules import from here (or the individual port module) and never from a
 * concrete platform adapter. Bootstrap supplies the implementations.
 */

export type { Clock } from "./clock.js";
export { systemClock } from "./clock.js";
export type { InstallationToken, InstallationTokenProvider } from "./installation-token.js";
export type { LogContext, Logger } from "./logger.js";
export type { ReviewJobAttempt, ReviewJobProcessor } from "./review-job-processor.js";
export type { ReviewQueue, ReviewQueueCounts, ReviewQueueEnqueueOptions } from "./review-queue.js";
