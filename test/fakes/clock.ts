import type { Clock } from "../../src/ports/clock.js";

/**
 * Deterministic clock for unit tests.
 *
 * `now()` returns a defensive copy so a caller mutating the result cannot
 * move the fake clock. `advance()` and `set()` cover timeout/expiry paths.
 */
export class FakeClock implements Clock {
  private current: Date;

  constructor(initial: Date | string | number = "2026-01-01T00:00:00.000Z") {
    this.current = new Date(initial);
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  set(value: Date | string | number): void {
    this.current = new Date(value);
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}
