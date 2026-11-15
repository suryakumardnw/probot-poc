import type { ReviewConfig } from "../config/review-schema.js";

/**
 * Review-config store port (ARCHITECTURE.md §11).
 *
 * Admin and ingestion depend on this surface, never on the loader or its file
 * layout. The implementation lives beside the loader for now; PR 3.10 moves it
 * (and the schema) into `platform/config`. Keeping the error class here means
 * callers can branch on validation failures without importing the loader.
 */

export { ConfigValidationError } from "../config/review-loader.js";
export type { ReviewConfig };

export interface ReviewConfigSnapshot {
  schemaVersion: number;
  hash: string;
  capturedAt: string;
}

export interface LoadedReviewConfig {
  config: ReviewConfig;
  fromLastKnownGood: boolean;
  snapshot: ReviewConfigSnapshot;
}

export interface ReviewConfigUpdateResult {
  previous: LoadedReviewConfig;
  next: LoadedReviewConfig;
}

export interface ReviewConfigValidation {
  config: ReviewConfig;
  snapshot: ReviewConfigSnapshot;
}

export interface LoadReviewConfigOptions {
  /** Write the loaded configuration as the new last-known-good snapshot. */
  updateLastKnownGood?: boolean;
  /** Fall back to the last-known-good snapshot when the active file is invalid. */
  allowLastKnownGoodFallback?: boolean;
}

/**
 * `missing` — no snapshot file; `unreadable` — the file exists but is not
 * valid JSON; `available` — a snapshot can be restored (validity is checked by
 * `restoreLastKnownGood`).
 */
export type LastKnownGoodStatus = "missing" | "unreadable" | "available";

export interface ReviewConfigStore {
  /** Load and validate the active configuration (fallback allowed by default). */
  load(options?: LoadReviewConfigOptions): LoadedReviewConfig;
  /** Resolve env references and validate a candidate without writing. */
  validate(candidate: unknown): ReviewConfigValidation;
  /** Atomically replace the active configuration after validation. */
  update(candidate: unknown): ReviewConfigUpdateResult;
  /** Restore the last-known-good snapshot as the active configuration. */
  restoreLastKnownGood(): LoadedReviewConfig;
  /** Inspect the snapshot file without validating its contents. */
  lastKnownGoodStatus(): LastKnownGoodStatus;
  /** Secret-safe copy for API responses and panel rendering. */
  redact<T>(value: T): T;
}
