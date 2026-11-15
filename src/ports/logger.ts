/**
 * Logger port.
 *
 * Application and domain modules log through this interface; the concrete
 * Pino adapter lives in `src/platform/logger.ts` and is constructed by bootstrap.
 * Keeping the port independent of Pino lets tests inject silent/fake loggers
 * and lets the logging library change without touching modules.
 */

/** Structured log context. Values are redacted by the adapter's configuration. */
export type LogContext = object;

export interface Logger {
  debug(message: string): void;
  debug(obj: LogContext, message: string): void;
  info(message: string): void;
  info(obj: LogContext, message: string): void;
  warn(message: string): void;
  warn(obj: LogContext, message: string): void;
  error(message: string): void;
  error(obj: LogContext, message: string): void;
  child(bindings: LogContext): Logger;
}
