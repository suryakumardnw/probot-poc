import type { Logger, LogContext } from "../../src/ports/logger.js";

export type FakeLogLevel = "debug" | "info" | "warn" | "error";

export interface FakeLogEntry {
  level: FakeLogLevel;
  message: string;
  /** Context passed at the call site, when the overload carried one. */
  context?: LogContext;
  /** Bindings inherited from `child()` calls, outermost first. */
  bindings: LogContext;
}

/**
 * Recording logger that implements the full `Logger` port.
 *
 * Children share the parent's sink, so assertions on the root logger see every
 * child line; `messages()` and `entriesFor()` keep failure-path assertions
 * readable without parsing pino JSON.
 */
export class FakeLogger implements Logger {
  private readonly sink: FakeLogEntry[];
  private readonly bindings: LogContext;

  constructor(bindings: LogContext = {}, sink: FakeLogEntry[] = []) {
    this.bindings = bindings;
    this.sink = sink;
  }

  debug(message: string): void;
  debug(obj: LogContext, message: string): void;
  debug(messageOrContext: string | LogContext, message?: string): void {
    this.record("debug", messageOrContext, message);
  }

  info(message: string): void;
  info(obj: LogContext, message: string): void;
  info(messageOrContext: string | LogContext, message?: string): void {
    this.record("info", messageOrContext, message);
  }

  warn(message: string): void;
  warn(obj: LogContext, message: string): void;
  warn(messageOrContext: string | LogContext, message?: string): void {
    this.record("warn", messageOrContext, message);
  }

  error(message: string): void;
  error(obj: LogContext, message: string): void;
  error(messageOrContext: string | LogContext, message?: string): void {
    this.record("error", messageOrContext, message);
  }

  child(bindings: LogContext): FakeLogger {
    return new FakeLogger({ ...this.bindings, ...bindings }, this.sink);
  }

  /** Every line recorded by this logger and its children, oldest first. */
  get entries(): readonly FakeLogEntry[] {
    return this.sink;
  }

  /** Recorded messages, optionally filtered by level. */
  messages(level?: FakeLogLevel): string[] {
    return this.sink.filter((entry) => level === undefined || entry.level === level).map((entry) => entry.message);
  }

  entriesFor(level: FakeLogLevel): readonly FakeLogEntry[] {
    return this.sink.filter((entry) => entry.level === level);
  }

  clear(): void {
    this.sink.length = 0;
  }

  private record(level: FakeLogLevel, messageOrContext: string | LogContext, message?: string): void {
    if (typeof messageOrContext === "string") {
      this.sink.push({ level, message: messageOrContext, bindings: this.bindings });
      return;
    }
    this.sink.push({
      level,
      message: message ?? "",
      context: messageOrContext,
      bindings: this.bindings,
    });
  }
}
