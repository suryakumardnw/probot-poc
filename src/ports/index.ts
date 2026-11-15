/**
 * Ports barrel: interfaces for external dependencies.
 *
 * Modules import from here (or the individual port module) and never from a
 * concrete platform adapter. Bootstrap supplies the implementations.
 */

export type { Clock } from "./clock.js";
export { systemClock } from "./clock.js";
export type { LogContext, Logger } from "./logger.js";
