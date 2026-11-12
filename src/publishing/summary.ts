/**
 * Review body generation (ARCHITECTURE.md §6.4, §7.4; ticket 09).
 *
 * Builds the PR review summary body and the per-finding inline comment
 * bodies. Rules:
 *  - Verified findings appear in the summary (whether or not they could be
 *    anchored inline).
 *  - Uncertain findings live in a separate section, never inline
 *    (`review.findings.publishUncertainInSummary`).
 *  - A clean review publishes a short message when
 *    `review.reporting.publishCleanReview` is enabled.
 *  - Inline bodies carry a hidden fingerprint marker so repeated publications
 *    can be reconciled against existing GitHub comments (dedup).
 */

import type { StoredFinding } from "../findings/index.js";
import { FINDING_CATEGORIES, type FindingCategory, type FindingSeverity } from "../review-engine/types.js";

const MAX_BODY_CHARS = 60_000; // GitHub hard cap is 65,536.

/** Hidden marker used to reconcile a published comment with a finding fingerprint. */
export function fingerprintMarker(fingerprint: string): string {
  return `<!-- ai-pr-reviewer:fingerprint:${fingerprint} -->`;
}

export function extractFingerprint(body: string): string | null {
  const match = /<!--\s*ai-pr-reviewer:fingerprint:([A-Za-z0-9:_-]+)\s*-->/.exec(body);
  return match?.[1] ?? null;
}

const SEVERITY_LABEL: Record<string, string> = {
  critical: "🔴 critical",
  high: "🟠 high",
  medium: "🟡 medium",
  low: "🔵 low",
  informational: "⚪ informational",
};

/** Order used for per-category severity breakdowns (most severe first). */
const SEVERITY_ORDER: FindingSeverity[] = ["critical", "high", "medium", "low", "informational"];

const SEVERITY_RANK: Record<FindingSeverity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  informational: 1,
};

/** Specialist-domain section titles, keyed by the configured category enum. */
const CATEGORY_LABEL: Record<FindingCategory, string> = {
  functional: "Functional",
  regression: "Regression",
  security: "Security",
  performance: "Performance",
  concurrency: "Concurrency",
  dataIntegrity: "Data Integrity",
  errorHandling: "Error Handling",
  apiCompatibility: "API Compatibility",
  maintainability: "Code Quality",
  testing: "Testing",
};

/** A category's recommendation is the classification of its worst finding. */
function recommendationFor(maxRank: number): string {
  if (maxRank >= SEVERITY_RANK.high) return "⚠️ Major Comments";
  if (maxRank === SEVERITY_RANK.medium) return "📝 Minor Comments";
  return "💬 Optional Nits";
}

function maxSeverity(findings: StoredFinding[]): FindingSeverity | null {
  let best: FindingSeverity | null = null;
  for (const finding of findings) {
    const severity = finding.severity as FindingSeverity;
    if (!(severity in SEVERITY_RANK)) continue;
    if (!best || SEVERITY_RANK[severity] > SEVERITY_RANK[best]) best = severity;
  }
  return best;
}

function maxSeverityRank(findings: StoredFinding[]): number {
  const severity = maxSeverity(findings);
  return severity ? SEVERITY_RANK[severity] : 0;
}

/** Overall review status, derived from the findings (no model-supplied verdict). */
function reviewStatus(verified: StoredFinding[]): string {
  const rank = maxSeverityRank(verified);
  if (rank >= SEVERITY_RANK.critical) return "🔴 Critical Issues Found";
  if (rank >= SEVERITY_RANK.high) return "🔴 Significant Concerns";
  if (rank === SEVERITY_RANK.medium) return "🟡 Concerns";
  if (rank >= SEVERITY_RANK.low) return "🔵 Minor Suggestions";
  return "✅ No Concerns";
}

function finalDecision(verified: StoredFinding[]): string {
  const rank = maxSeverityRank(verified);
  if (rank >= SEVERITY_RANK.medium) return "Changes requested.";
  if (rank >= SEVERITY_RANK.low) return "Comment.";
  return "No changes requested.";
}

/** `🟠 2 findings (1 high · 1 medium)` — the finding count for one category. */
function severityBreakdown(findings: StoredFinding[]): string {
  const worst = maxSeverity(findings);
  const icon = worst ? (SEVERITY_LABEL[worst]?.split(" ")[0] ?? "") : "";
  const counts = SEVERITY_ORDER.filter((severity) => findings.some((f) => f.severity === severity))
    .map((severity) => `${findings.filter((f) => f.severity === severity).length} ${severity}`)
    .join(" · ");
  const noun = findings.length === 1 ? "finding" : "findings";
  return `${icon} ${findings.length} ${noun} (${counts})`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export interface ReviewBodyMeta {
  /** Reviewer identity shown in the header (e.g. the application name). */
  reviewer?: string;
  /** What is being reviewed (repository, PR, head SHA). */
  source?: string;
  /** When the review was produced. */
  reviewedAt?: Date;
  /** IANA timezone used for the review date (defaults to UTC). */
  timezone?: string;
}

export interface FindingsBodyInput {
  /** Engine summary text (§7.1). */
  summary: string;
  /** Verified findings of this review (stored rows; never `uncertain`). */
  verified: StoredFinding[];
  /** Uncertain findings of this review. */
  uncertain: StoredFinding[];
  /** Fingerprints that were published inline (used for the location note). */
  inlineFingerprints?: Set<string>;
  config: { publishUncertainInSummary: boolean; publishCleanReview: boolean };
  /** Optional header metadata (reviewer, source, timestamp). */
  meta?: ReviewBodyMeta;
}

function formatReviewDate(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: timezone,
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${value("day")} ${value("month")} ${value("year")}, ${value("hour")}:${value("minute")}`;
}

/** Build the review (summary) body for `createReview`. */
export function buildReviewBody(input: FindingsBodyInput): string {
  const parts: string[] = [];

  parts.push(`# AI Code Review${input.meta?.reviewer ? ` — ${input.meta.reviewer}` : ""}\n`);
  if (input.meta?.source) parts.push(`**Source:** ${input.meta.source}`);
  if (input.meta?.reviewedAt) {
    parts.push(`**Review Date:** ${formatReviewDate(input.meta.reviewedAt, input.meta.timezone ?? "UTC")}`);
  }
  parts.push(`**Review Status:** ${reviewStatus(input.verified)}\n`);
  parts.push("## Overall Summary\n");
  parts.push(`${truncate(input.summary, 10_000)}\n`);

  let section = 0;
  for (const category of FINDING_CATEGORIES) {
    const findings = input.verified
      .filter((finding) => finding.category === category)
      .sort(
        (a, b) =>
          (SEVERITY_RANK[b.severity as FindingSeverity] ?? 0) -
            (SEVERITY_RANK[a.severity as FindingSeverity] ?? 0) ||
          a.filePath.localeCompare(b.filePath) ||
          a.lineNumber - b.lineNumber,
      );
    if (findings.length === 0) continue;

    section += 1;
    parts.push(
      `## ${section}\\. ${CATEGORY_LABEL[category]}\n\n` +
        `**Severity:** ${severityBreakdown(findings)}\n\n` +
        `**Summary:**\n\n${truncate(findings.map((finding) => finding.title).join("; "), 1_000)}.\n\n` +
        `**Recommendation:** ${recommendationFor(maxSeverityRank(findings))}\n\n` +
        "### Findings\n",
    );
    const bullets = findings.map((finding) => {
      const anchored = input.inlineFingerprints?.has(finding.fingerprint);
      const location = anchored
        ? `\`${finding.filePath}:${finding.lineNumber}\` (inline comment)`
        : `\`${finding.filePath}:${finding.lineNumber}\``;
      return (
        `- **${truncate(finding.title, 200)}** — ${truncate(finding.description, 1_000)} ` +
        `· ${location} · confidence \`${Math.round(finding.confidence * 100)}%\``
      );
    });
    parts.push(`${bullets.join("\n")}\n`);
  }

  if (input.config.publishUncertainInSummary && input.uncertain.length > 0) {
    parts.push("\n### ⚠️ Uncertain findings (not confirmed — for awareness only)\n");
    for (const finding of input.uncertain) {
      parts.push(
        `- **${truncate(finding.title, 200)}** — ${SEVERITY_LABEL[finding.severity] ?? finding.severity}, ` +
          `confidence \`${Math.round(finding.confidence * 100)}%\` · \`${finding.filePath}:${finding.lineNumber}\`\n` +
          `  ${truncate(finding.description, 1_000)}`,
      );
    }
    parts.push("\n_These could not be verified against the repository contents; they are listed separately and never published as inline findings._");
  }

  if (input.verified.length === 0 && input.uncertain.length === 0 && input.config.publishCleanReview) {
    parts.push("\n✅ **No verified findings in this change.** The diff passed the configured checks; no issues were identified.\n");
  }

  parts.push(
    "## Review Actions\n\n" +
      "- 🔓 **Break Glass** — Override the automated review block.\n" +
      "- 🔄 **Re-run this review** — Execute the review again.\n\n" +
      `**Final Review Decision:** ${finalDecision(input.verified)}`,
  );

  const body = parts.join("\n");
  return body.length <= MAX_BODY_CHARS ? body : `${body.slice(0, MAX_BODY_CHARS - 1)}…`;
}

/** Build the inline comment body for one finding (with dedup marker). */
export function buildInlineCommentBody(finding: StoredFinding): string {
  const body = [
    `**${truncate(finding.title, 200)}**`,
    "",
    truncate(finding.description, 4_000),
    "",
    `_Category: \`${finding.category}\` · Severity: ${SEVERITY_LABEL[finding.severity] ?? finding.severity} · Confidence: \`${Math.round(finding.confidence * 100)}%\`_`,
  ].join("\n");
  const marked = `${fingerprintMarker(finding.fingerprint)}\n${body}`;
  return marked.length <= MAX_BODY_CHARS ? marked : `${marked.slice(0, MAX_BODY_CHARS - 1)}…`;
}
