/**
 * Knowledge module entry point: module-level holder for the boot-time
 * knowledge snapshot (§5.3). The worker calls `ensureKnowledgeSources` once
 * during startup and stores the result here; the review pipeline reads it
 * via `getKnowledgeSnapshot()` (never re-fetching per review — in-memory
 * only, nothing to shut down).
 */
import type { KnowledgeSnapshot } from "./types.js";

export type {
  KnowledgeFetcher,
  KnowledgeFileRecord,
  KnowledgeHandbookVariant,
  KnowledgeSnapshot,
  KnowledgeSourceSnapshot,
  KnowledgeSourceStatus,
  PersistedKnowledgeSnapshot,
  PersistedKnowledgeSource,
} from "./types.js";
export {
  ensureKnowledgeSources,
  knowledgeSpecsFromConfig,
  computeContentHash,
  validateRelativePath,
} from "./ensure-skills.js";
export {
  materializeReviewKnowledge,
  handbookVariantDir,
  KnowledgeSnapshotError,
  persistKnowledgeMetrics,
  type ReviewKnowledgeStore,
} from "./materialize.js";
export { createPrismaReviewKnowledgeStore } from "./prisma-knowledge.repository.js";
export type { MaterializeKnowledgeInput, MaterializeKnowledgeResult } from "./materialize.js";
export { summarizeKnowledgeSnapshot, summarizeKnowledgeMetrics } from "./summarize.js";

let holder: KnowledgeSnapshot | null = null;

/** Snapshot resolved at worker boot (null before init / in unit tests). */
export function getKnowledgeSnapshot(): KnowledgeSnapshot | null {
  return holder;
}

/** Store the boot-time snapshot (worker startup). */
export function setKnowledgeSnapshot(snapshot: KnowledgeSnapshot): void {
  holder = snapshot;
}

/** Test seam: drop the in-memory snapshot. */
export function resetKnowledgeSnapshotForTests(): void {
  holder = null;
}
