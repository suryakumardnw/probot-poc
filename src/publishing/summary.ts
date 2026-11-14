/**
 * Review body generation (ARCHITECTURE.md §6.4, §7.4; ticket 09).
 *
 * Builds the PR review summary body and the per-finding inline comment
 * bodies. Rules:
 *  - Verified findings appear in the summary (whether or not they could be
 *    anchored inline).
 *  - Uncertain findings live in a separate, collapsed section, never inline
 *    (`review.findings.publishUncertainInSummary`).
 *  - A clean review publishes a short message when
 *    `review.reporting.publishCleanReview` is enabled.
 *  - Inline bodies carry a hidden fingerprint marker so repeated publications
 *    can be reconciled against existing GitHub comments (dedup).
 *
 * Presentation is developer-first: verdict, short summary, then numbered
 * findings with problem → impact → fix. Audit details (guideline reference,
 * confidence, evidence) are collapsed under "Technical details". Inline
 * comments use a compact report instead: hidden marker, severity icon + title,
 * severity/category/confidence line, description, then the guideline citation.
 */

import type { StoredFinding } from "../findings/index.js";
import { FINDING_CATEGORIES, type FindingCategory, type FindingSeverity } from "../review-engine/types.js";

const MAX_BODY_CHARS = 60_000; // GitHub hard cap is 65,536.
const SUMMARY_SENTENCES = 2;

/** Hidden marker used to reconcile a published comment with a finding fingerprint. */
export interface FingerprintMarkerMeta {
  /** Guideline rule id carried for tooling and reporting. */
  rule?: string;
  severity?: string;
  /** 0..1 confidence, rendered as a two-decimal value in the marker. */
  confidence?: number;
}

function formatConfidence(confidence: number): string {
  return Number(confidence.toFixed(2)).toString();
}

export function fingerprintMarker(fingerprint: string, meta: FingerprintMarkerMeta = {}): string {
  const parts = ["review-bot:v1"];
  if (meta.rule) parts.push(`rule=${meta.rule}`);
  parts.push(`fp=${fingerprint}`);
  if (meta.severity) parts.push(`sev=${meta.severity}`);
  if (typeof meta.confidence === "number") parts.push(`conf=${formatConfidence(meta.confidence)}`);
  return `<!-- ${parts.join(" ")} -->`;
}

export function extractFingerprint(body: string): string | null {
  const reviewBot = /<!--\s*review-bot:v1\b[^>]*?\bfp=([A-Za-z0-9:_-]+)\b[^>]*-->/.exec(body);
  if (reviewBot?.[1]) return reviewBot[1];
  const legacy = /<!--\s*ai-pr-reviewer:fingerprint:([A-Za-z0-9:_-]+)\s*-->/.exec(body);
  return legacy?.[1] ?? null;
}

const SEVERITY_LABEL: Record<string, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  informational: "Informational",
};

/** Icon shown before a finding title in inline reports. */
const SEVERITY_ICON: Record<string, string> = {
  critical: "🚨",
  high: "🔴",
  medium: "🟠",
  low: "🟡",
  informational: "🔵",
};

/** Confidence band shown next to the numeric score. */
function confidenceLabel(confidence: number): string {
  if (confidence >= 0.85) return "High";
  if (confidence >= 0.65) return "Medium";
  return "Low";
}

/** Order used for severity roll-ups (most severe first). */
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
  dataIntegrity: "Data integrity",
  errorHandling: "Error handling",
  apiCompatibility: "API compatibility",
  maintainability: "Code quality",
  testing: "Testing",
};

function categoryLabel(category: string): string {
  return CATEGORY_LABEL[category as FindingCategory] ?? category;
}

function maxSeverityRank(findings: StoredFinding[]): number {
  let rank = 0;
  for (const finding of findings) {
    const candidate = SEVERITY_RANK[finding.severity as FindingSeverity] ?? 0;
    if (candidate > rank) rank = candidate;
  }
  return rank;
}

/** Overall review verdict, derived from the findings (no model-supplied verdict). */
function verdictFor(verified: StoredFinding[]): string {
  const rank = maxSeverityRank(verified);
  if (rank >= SEVERITY_RANK.medium) return "Changes requested";
  if (rank >= SEVERITY_RANK.low) return "Comment";
  return "No changes requested";
}

/** `1 high · 2 medium` — compact severity roll-up for the header. */
function severityCounts(findings: StoredFinding[]): string {
  return SEVERITY_ORDER.filter((severity) => findings.some((f) => f.severity === severity))
    .map((severity) => `${findings.filter((f) => f.severity === severity).length} ${severity}`)
    .join(" · ");
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Render a block of text as a Markdown blockquote, preserving line breaks. */
function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");
}

/** First N sentences, without cutting mid-sentence. */
function firstSentences(text: string, count: number): string {
  const matches = text.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g);
  if (!matches) return text.trim();
  return matches
    .slice(0, count)
    .map((sentence) => sentence.trim())
    .join(" ");
}

/** `12 Nov 2026`. */
function formatShortDate(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: timezone,
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${value("day")} ${value("month")} ${value("year")}`;
}

/** Turn a provider model id into a readable label (`glm-5.3-flash` → `GLM 5.3 Flash`). */
function humanizeModel(model: string): string {
  const last = model.split("/").filter(Boolean).at(-1) ?? model;
  const tokens = last.split(/[-_]/).filter(Boolean);
  const acronyms: Record<string, string> = { glm: "GLM", gpt: "GPT", ai: "AI", llm: "LLM" };
  const out: string[] = [];
  for (const token of tokens) {
    if (/^\d+$/.test(token) && out.length > 0 && /^\d+(\.\d+)?$/.test(out[out.length - 1]!)) {
      out[out.length - 1] = `${out[out.length - 1]}.${token}`;
      continue;
    }
    out.push(acronyms[token.toLowerCase()] ?? token.charAt(0).toUpperCase() + token.slice(1));
  }
  return out.join(" ");
}

function prNumberFromSource(source: string | undefined): number | null {
  if (!source) return null;
  const match = /#(\d+)/.exec(source);
  return match ? Number(match[1]) : null;
}

function commitFromSource(source: string | undefined): string | null {
  if (!source) return null;
  const match = /@\s*([0-9a-f]{7,40})\b/i.exec(source);
  return match?.[1] ?? null;
}

/** One finding block: title, severity, location, problem, impact, fix. */
function renderFinding(finding: StoredFinding, index?: number): string {
  const lines: string[] = [];
  lines.push(`### ${index === undefined ? "" : `${index}. `}${truncate(finding.title, 200)}`);
  lines.push("");
  lines.push(`**${SEVERITY_LABEL[finding.severity] ?? finding.severity}**`);
  lines.push("");
  lines.push(`\`${finding.filePath}:${finding.lineNumber}\` · ${categoryLabel(finding.category)}`);
  lines.push("");
  lines.push(truncate(finding.description, 2_000).trim());
  if (finding.impact) {
    lines.push("");
    lines.push(`**Impact:** ${truncate(finding.impact, 1_000).trim()}`);
  }
  if (finding.recommendation) {
    lines.push("");
    lines.push(`**Suggested fix:** ${truncate(finding.recommendation, 1_000).trim()}`);
  }
  return lines.join("\n");
}

/** Compact report block used for inline comments. */
function renderInlineFinding(finding: StoredFinding, guidelineSource?: GuidelineSource): string {
  const lines: string[] = [];
  const icon = SEVERITY_ICON[finding.severity] ?? "🔵";
  lines.push(`${icon} ${truncate(finding.title, 200)}`);
  lines.push("");
  lines.push(
    `${SEVERITY_LABEL[finding.severity] ?? finding.severity} · ${categoryLabel(finding.category)} · Confidence: ${confidenceLabel(finding.confidence)} (${Math.round(finding.confidence * 100)}%)`,
  );
  lines.push("");
  lines.push(truncate(finding.description, 2_000).trim());
  const guideline = renderInlineGuideline(finding, guidelineSource);
  if (guideline) {
    lines.push("");
    lines.push(guideline);
  }
  return lines.join("\n");
}

export interface GuidelineSource {
  /** Handbook repository in `owner/name` form. */
  repo: string;
  /** Exact ref the review was judged against (default or technology variant). */
  ref: string;
  /** Selected handbook files, used to resolve basename-only citations. */
  files?: string[];
}

/** Extract the cited file path from a free-form guideline reference. */
function guidelinePath(guideline: string, files?: string[]): string | undefined {
  const match = guideline.match(/([A-Za-z0-9_.@/-]+\.(?:md|markdown|txt))/i);
  if (!match) return undefined;
  let filePath = match[1]!;
  if (!filePath.includes("/")) {
    const resolved = files?.find((file) => file === filePath || file.endsWith(`/${filePath}`));
    if (!resolved) return undefined;
    filePath = resolved;
  }
  return filePath.replace(/^\/+/, "");
}

function guidelineUrl(filePath: string, source?: GuidelineSource): string | undefined {
  if (!source?.repo || !source?.ref) return undefined;
  const repoPath = source.repo.split("/").map(encodeURIComponent).join("/");
  const refPath = source.ref.split("/").map(encodeURIComponent).join("/");
  const filePathEncoded = filePath.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${repoPath}/blob/${refPath}/${filePathEncoded}`;
}

/** Render a guideline bullet, linked to the handbook file when resolvable. */
function renderGuideline(finding: StoredFinding, source?: GuidelineSource): string | undefined {
  if (!finding.guideline) return undefined;
  const text = truncate(finding.guideline, 300).replace(/\r?\n/g, " ");
  const filePath = guidelinePath(finding.guideline, source?.files);
  const url = filePath ? guidelineUrl(filePath, source) : undefined;
  if (!url) return `- Guideline: ${text}`;
  const label = text.replace(/\[/g, "\\[").replace(/\]/g, "\\]");
  return `- Guideline: [${label}](${url})`;
}

/** Rule id prefixed to a guideline reference (`RULE_ID – file §section`). */
function explicitRuleId(guideline: string | undefined): string | undefined {
  if (!guideline) return undefined;
  const match = /^([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\s*(?:[–—-]|::|:)\s*/.exec(guideline.trim());
  return match?.[1];
}

/** Stable rule id fallback when the finding cites a bare file/section. */
function categoryRuleId(category: string): string {
  return category.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

function guidelineRuleId(finding: StoredFinding): string {
  return explicitRuleId(finding.guideline) ?? categoryRuleId(finding.category);
}

/** Drop the rule-id prefix so the reference can be rendered separately. */
function guidelineReference(guideline: string): string {
  return guideline
    .trim()
    .replace(/^([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\s*(?:[–—-]|::|:)\s*/, "");
}

/** One-line guideline citation for the compact inline report. */
function renderInlineGuideline(
  finding: StoredFinding,
  source?: GuidelineSource,
): string | undefined {
  if (!finding.guideline) return undefined;
  const rule = explicitRuleId(finding.guideline);
  const reference = rule
    ? guidelineReference(finding.guideline)
    : truncate(finding.guideline, 300).replace(/\r?\n/g, " ");
  const filePath = guidelinePath(finding.guideline, source?.files);
  const url = filePath ? guidelineUrl(filePath, source) : undefined;
  const label = url ? reference.replace(/\[/g, "\\[").replace(/\]/g, "\\]") : reference;
  const text = url ? `[${label}](${url})` : label;
  return `Guideline: ${rule ? `${rule} – ${text}` : text}`;
}

/** Collapsed audit trail for one finding. */
function renderTechnicalDetails(finding: StoredFinding, guidelineSource?: GuidelineSource): string {
  const bullets = [`- Confidence: \`${Math.round(finding.confidence * 100)}%\``];
  const guideline = renderGuideline(finding, guidelineSource);
  if (guideline) bullets.push(guideline);
  if (finding.status) bullets.push(`- Status: ${finding.status}`);
  for (const evidence of (finding.evidence ?? []).slice(0, 2)) {
    const location = evidence.line ? `${evidence.file}:${evidence.line}` : evidence.file;
    bullets.push(`- Evidence: \`${location}\` — ${truncate(evidence.reason, 300)}`);
  }
  return `<details>\n<summary>Technical details</summary>\n\n${bullets.join("\n")}\n\n</details>`;
}

/** Collapsed unverified observations. */
function renderUncertain(findings: StoredFinding[]): string {
  const items = findings.map((finding) => {
    const body = [
      `**${truncate(finding.title, 200)}** · ${(SEVERITY_LABEL[finding.severity] ?? finding.severity).toLowerCase()} confidence`,
      "",
      truncate(finding.description, 1_000).trim(),
    ];
    if (finding.impact) {
      body.push("", `**Why it matters:** ${truncate(finding.impact, 500).trim()}`);
    }
    body.push(
      "",
      `_\`${finding.filePath}:${finding.lineNumber}\` · ${categoryLabel(finding.category)}_`,
    );
    return body.join("\n");
  });
  const noun = findings.length === 1 ? "observation" : "observations";
  return (
    `<details>\n<summary>Additional ${noun} (${findings.length}, unverified)</summary>\n\n` +
    `${items.join("\n\n---\n\n")}\n\n</details>`
  );
}

export interface ReviewBodyMeta {
  /** Reviewer identity shown in the header (e.g. the application name). */
  reviewer?: string;
  /** Pull request number, used for the `# PR #N Review` title. */
  prNumber?: number;
  /** Head commit shown in the metadata footer. */
  commit?: string;
  /** What is being reviewed (repository, PR, head SHA). */
  source?: string;
  /** Model identifier that produced the review. */
  model?: string;
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
  /** Handbook repository/ref used to link guideline citations. */
  guidelineSource?: GuidelineSource;
  /** Optional header metadata (reviewer, source, timestamp). */
  meta?: ReviewBodyMeta;
}

/** Build the review (summary) body for `createReview`. */
export function buildReviewBody(input: FindingsBodyInput): string {
  const parts: string[] = [];
  const prNumber = input.meta?.prNumber ?? prNumberFromSource(input.meta?.source);
  const commit = input.meta?.commit ?? commitFromSource(input.meta?.source);

  parts.push(
    `# ${prNumber ? `PR #${prNumber} Review` : `AI Code Review${input.meta?.reviewer ? ` — ${input.meta.reviewer}` : ""}`}\n`,
  );

  const counts = severityCounts(input.verified);
  parts.push(`**${verdictFor(input.verified)}**${counts ? ` · ${counts}` : " · 0 confirmed findings"}\n`);
  parts.push(`${quote(firstSentences(input.summary, SUMMARY_SENTENCES))}\n`);

  const ordered = [...input.verified].sort(
    (a, b) =>
      (SEVERITY_RANK[b.severity as FindingSeverity] ?? 0) - (SEVERITY_RANK[a.severity as FindingSeverity] ?? 0) ||
      FINDING_CATEGORIES.indexOf(a.category as FindingCategory) -
        FINDING_CATEGORIES.indexOf(b.category as FindingCategory) ||
      a.filePath.localeCompare(b.filePath) ||
      a.lineNumber - b.lineNumber,
  );

  if (ordered.length > 0) {
    parts.push(`## Findings (${ordered.length})\n`);
    for (const [index, finding] of ordered.entries()) {
      parts.push(
        `${renderFinding(finding, index + 1)}\n\n${renderTechnicalDetails(finding, input.guidelineSource)}\n`,
      );
    }
  } else if (input.config.publishCleanReview) {
    parts.push("## Findings (0)\n\nNo confirmed findings.\n");
  }

  if (input.config.publishUncertainInSummary && input.uncertain.length > 0) {
    parts.push(`${renderUncertain(input.uncertain)}\n`);
  }

  const footer = [
    input.meta?.model ? humanizeModel(input.meta.model) : "",
    input.meta?.reviewedAt
      ? formatShortDate(input.meta.reviewedAt, input.meta.timezone ?? "UTC")
      : "",
    commit ? `\`${commit}\`` : "",
  ].filter(Boolean);
  if (footer.length > 0) parts.push(`---\n\n<sub>${footer.join(" · ")}</sub>\n`);
  parts.push("🔓 Break glass · 🔄 Re-run review");

  const body = parts.join("\n");
  return body.length <= MAX_BODY_CHARS ? body : `${body.slice(0, MAX_BODY_CHARS - 1)}…`;
}

/** Build the inline comment body for one finding (with dedup marker). */
export function buildInlineCommentBody(
  finding: StoredFinding,
  guidelineSource?: GuidelineSource,
): string {
  const marker = fingerprintMarker(finding.fingerprint, {
    rule: guidelineRuleId(finding),
    severity: finding.severity,
    confidence: finding.confidence,
  });
  const body = `${marker}\n\n${renderInlineFinding(finding, guidelineSource)}`;
  return body.length <= MAX_BODY_CHARS ? body : `${body.slice(0, MAX_BODY_CHARS - 1)}…`;
}
