/**
 * Knowledge source types (boot-time initialization).
 *
 * Knowledge sources are fetched ONCE per worker boot into a persistent cache
 * and are treated as UNTRUSTED DATA: fetched content is injected into review
 * prompts as text, never executed, never interpreted as configuration, and
 * never written outside the knowledge cache directory or a review's own
 * workspace copy (§10 security invariant).
 */

import type { KnowledgeFileRecord } from "../../contracts/knowledge.js";

/** status "fresh": fetched from GitHub; "unavailable": no content (there is no fallback). */
export type KnowledgeSourceStatus = "fresh" | "unavailable";

/**
 * One cached knowledge file. The shape and manifest validation live in
 * `src/contracts/knowledge.ts`; this re-export keeps the module API stable.
 */
export type { KnowledgeFileRecord };

/** Resolved state of one knowledge source for this worker boot. */
export interface KnowledgeSourceSnapshot {
  status: KnowledgeSourceStatus;
  /** Pinned or resolved commit SHA (empty when unavailable). */
  ref: string;
  /** sha256 over the sorted per-file hashes ("path sha256\n" lines); null when unavailable. */
  contentHash: string | null;
  /** Cache directory holding this source's files (null when unavailable). */
  dir: string | null;
  files: KnowledgeFileRecord[];
}

/**
 * Optional per-technology handbook ref (e.g. a branch carrying TypeScript
 * guidelines). Selected by the review's detected technologies; when none
 * matches, the default `handbook` source is used.
 */
export interface KnowledgeHandbookVariant {
  /** Lowercase technology keywords this variant applies to (e.g. "typescript"). */
  technologies: string[];
  source: KnowledgeSourceSnapshot;
}

/** Knowledge snapshot resolved at worker boot, shared by all reviews. */
export interface KnowledgeSnapshot {
  cacheDir: string;
  skill: KnowledgeSourceSnapshot;
  handbook: KnowledgeSourceSnapshot;
  /** Per-technology refs; empty when the config declares none. */
  handbookVariants?: KnowledgeHandbookVariant[];
}

/** Cache/workspace-safe directory name for a resolved knowledge ref. */
export function knowledgeRefSlug(ref: string): string {
  return ref.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * Injectable HTTP fetcher for knowledge sources (test seam — no real network
 * in CI). Must resolve with a status code and body text, never throw for
 * HTTP-level failures (non-2xx is expressed via status).
 */
export type KnowledgeFetcher = (url: string, init?: { timeoutMs: number }) => Promise<{ status: number; text: string }>;

/** Per-source identity persisted on the Review row (reproducibility, §4). */
export interface PersistedKnowledgeSource {
  ref: string;
  status: KnowledgeSourceStatus;
  contentHash: string;
  files: KnowledgeFileRecord[];
}

/** Shape of the Review.knowledgeSnapshot JSON column (nullable). */
export interface PersistedKnowledgeSnapshot {
  skill?: PersistedKnowledgeSource;
  handbook?: PersistedKnowledgeSource;
  /**
   * Per-technology handbook refs persisted alongside the default source.
   * Optional for backward compatibility with reviews created before this
   * field existed.
   */
  handbookVariants?: Array<{ technologies: string[]; source: PersistedKnowledgeSource }>;
  /**
   * Per-review injection metrics (§16.1, additive): token budget usage and
   * the selection funnel. Written by the pipeline after injection resolves.
   */
  metrics?: {
    /** Which source the metrics describe. */
    source: "skill" | "handbook";
    injectedTokens: number;
    documentsRetrieved: number;
    candidates: number;
    relevant: number;
    selected: number;
    truncated: boolean;
  };
}
