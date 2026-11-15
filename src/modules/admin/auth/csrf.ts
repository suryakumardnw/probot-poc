import { timingSafeEqual } from "node:crypto";

/**
 * CSRF token handling for the admin API and panel (ARCHITECTURE.md §14.2).
 *
 * Each admin session carries a random CSRF token. Every unsafe API request must
 * echo it in `X-CSRF-Token`; every panel form must submit it as `_csrf`.
 * Comparison is constant-time once the lengths match.
 */

export const CSRF_HEADER = "x-csrf-token";

/** Constant-time string comparison for signatures and CSRF tokens. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** Validate the CSRF token of a mutating request against the session. */
export function verifyCsrfToken(session: { csrfToken: string }, token: string | undefined): boolean {
  return typeof token === "string" && token.length > 0 && safeEqual(token, session.csrfToken);
}
