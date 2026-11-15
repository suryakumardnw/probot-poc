/**
 * Presentation helper for persisted knowledge snapshots (§16.1 comparison
 * endpoint). Converts the Review.knowledgeSnapshot JSON column into compact
 * per-source { ref, contentHash } labels — purely additive, never secrets.
 */
import type { PersistedKnowledgeSnapshot } from "./types.js";

export interface KnowledgeSnapshotSummary {
  skill: { ref: string; contentHash: string } | null;
  handbook: { ref: string; contentHash: string } | null;
  /** Per-technology refs actually used (absent when none were configured). */
  handbookVariants?: Array<{ technologies: string[]; ref: string; contentHash: string }>;
}

export function summarizeKnowledgeSnapshot(value: unknown): KnowledgeSnapshotSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const snapshot = value as PersistedKnowledgeSnapshot;
  const summarize = (source: PersistedKnowledgeSnapshot["skill"]) =>
    source && source.contentHash ? { ref: source.ref, contentHash: source.contentHash } : null;
  const variants = (snapshot.handbookVariants ?? [])
    .filter((variant) => variant.source.contentHash)
    .map((variant) => ({
      technologies: variant.technologies,
      ref: variant.source.ref,
      contentHash: variant.source.contentHash,
    }));
  return {
    skill: summarize(snapshot.skill),
    handbook: summarize(snapshot.handbook),
    ...(variants.length > 0 ? { handbookVariants: variants } : {}),
  };
}

/** Comparison-endpoint projection of the persisted injection metrics. */
export interface KnowledgeMetricsSummary {
  source: "skill" | "handbook";
  injectedTokens: number;
  documentsRetrieved: number;
  candidates: number;
  relevant: number;
  selected: number;
  truncated: boolean;
}

/**
 * Extract the metrics block from the Review.knowledgeSnapshot JSON column
 * (additive; null when the review predates metrics or ran without
 * knowledge injection).
 */
export function summarizeKnowledgeMetrics(value: unknown): KnowledgeMetricsSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const metrics = (value as PersistedKnowledgeSnapshot).metrics;
  if (!metrics || typeof metrics !== "object" || typeof metrics.injectedTokens !== "number") {
    return null;
  }
  return {
    source: metrics.source,
    injectedTokens: metrics.injectedTokens,
    documentsRetrieved: metrics.documentsRetrieved,
    candidates: metrics.candidates,
    relevant: metrics.relevant,
    selected: metrics.selected,
    truncated: metrics.truncated,
  };
}
