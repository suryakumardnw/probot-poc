/**
 * Clock port.
 *
 * Domain and application modules read "now" through this port instead of
 * calling `new Date()` directly, so tests can pin timestamps deterministically
 * and time-dependent behaviour stays explicit at the composition root.
 */

export interface Clock {
  now(): Date;
}

/** Process clock backed by the system time. */
export const systemClock: Clock = {
  now(): Date {
    return new Date();
  },
};
