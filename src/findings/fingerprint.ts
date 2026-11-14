/**
 * Deterministic finding fingerprints (ARCHITECTURE.md §7.3).
 *
 * The fingerprint is derived from:
 *   - the repository,
 *   - the finding category,
 *   - the code location (the file the defect lives in — NOT the line number,
 *     because code movement can shift lines without changing the issue),
 *   - the normalized finding description (case-, punctuation- and
 *     stopword-insensitive token signature, so rewording the same issue
 *     keeps the fingerprint stable),
 *   - the affected code identity (the normalized verbatim evidence excerpt).
 *
 * Same issue at different line numbers / with different wording → same
 * fingerprint. Different issues → different fingerprints. Fingerprints are
 * opaque (`fp1:<hex>`); they are never exposed to the model.
 */

import { createHash } from "node:crypto";
import type { Finding } from "../review-engine/index.js";

/** Tokens too common to help distinguish two descriptions about the same code. */
const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "if",
  "then",
  "else",
  "when",
  "while",
  "of",
  "to",
  "in",
  "on",
  "at",
  "by",
  "for",
  "with",
  "from",
  "as",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "it",
  "its",
  "this",
  "that",
  "these",
  "those",
  "there",
  "here",
  "may",
  "can",
  "could",
  "would",
  "should",
  "might",
  "will",
  "shall",
  "must",
  "do",
  "does",
  "did",
  "not",
  "no",
  "nor",
  "so",
  "than",
  "too",
  "very",
  "into",
  "over",
  "under",
  "before",
  "after",
  "above",
  "below",
  "up",
  "down",
  "out",
  "off",
  "again",
  "further",
  "once",
  "all",
  "any",
  "both",
  "each",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "own",
  "same",
  "has",
  "have",
  "had",
  "having",
  "get",
  "gets",
  "value",
  "values",
  "code",
  "line",
  "lines",
  "file",
  "function",
  "method",
  "possible",
  "possibly",
  "potentially",
]);

/**
 * Normalize free text for fingerprinting: lowercase, strip punctuation,
 * collapse whitespace, drop stopwords and very short tokens, and sort the
 * remaining token set. Sorting makes the signature order-insensitive.
 */
export function normalizeTextSignature(text: string): string {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9_\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  return [...new Set(tokens)].sort().join(" ");
}

/**
 * Normalize a code excerpt: collapse whitespace, drop leading line markers
 * and comments-only noise. This is the "affected code identity" part of the
 * fingerprint — the same defective code excerpt is the strongest anchor.
 */
export function normalizeCodeIdentity(excerpt: string): string {
  return excerpt
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(
      (l) => l.length > 0 && !l.startsWith("//") && !l.startsWith("#") && !l.startsWith("*") && !l.startsWith("/*"),
    )
    .join("\n");
}

/**
 * First (strongest) evidence excerpt of a finding, normalized.
 * Falls back to the finding file when the finding carries no usable excerpt.
 */
function affectedCodeIdentity(finding: Finding): string {
  const excerpt = finding.evidence.find((e) => normalizeCodeIdentity(e.excerpt).length > 0)?.excerpt ?? "";
  const normalized = normalizeCodeIdentity(excerpt);
  return normalized.length > 0 ? normalized : `<no-excerpt:${finding.file}>`;
}

/**
 * Compute the deterministic fingerprint for one finding (§7.3).
 * `repositoryKey` is the stable repository identity (full name or id).
 */
export function computeFindingFingerprint(finding: Finding, repositoryKey: string): string {
  const parts = [
    repositoryKey.trim().toLowerCase(),
    finding.category,
    finding.file.trim().replace(/\\/g, "/").replace(/^\.\//, ""),
    normalizeTextSignature(finding.description),
    normalizeCodeIdentity(affectedCodeIdentity(finding)),
  ];
  const digest = createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex");
  return `fp1:${digest}`;
}
