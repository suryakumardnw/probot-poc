/**
 * Handbook retrieval layer (§4.1 — Option A: application-side retrieval).
 *
 * The agent NEVER retrieves knowledge itself: there is no handbook_search /
 * handbook_read tool and no new agent permission — the agent only receives
 * the retrieved text injected into its instructions. This module is the
 * trusted retrieval layer that decides WHICH handbook content reaches the
 * prompt:
 *
 * 1. Technology detection: changed file extensions/paths → technology
 *    keywords (e.g. `.dart` → flutter/dart, `.ts` → nodejs/typescript).
 * 2. File ranking: (a) top-level category match against detected techs,
 *    (b) heading/filename keyword overlap with the changed paths,
 *    (c) `general/` categories stay eligible but deprioritized.
 * 3. Budget selection: whole-file preference for higher-ranked files,
 *    no mid-section fragments, dedup of identical content, deterministic
 *    ordering (score desc, path asc). A token budget (≈4 chars/token) is
 *    authoritative; `maxChars` remains a byte-level backstop.
 *
 * Deterministic: the same changed files + same handbook snapshot always
 * produce the same selection (no randomness, stable tie-breaks).
 */
import { createHash } from "node:crypto";

/** Conversion assumption for the token budget: ≈4 characters per token. */
export const CHARS_PER_TOKEN = 4;

/** Map a changed file to technology keywords via extension + path hints. */
const EXTENSION_TECH: Record<string, string[]> = {
  dart: ["flutter", "dart"],
  ts: ["nodejs", "typescript", "javascript"],
  tsx: ["nodejs", "typescript", "react", "javascript"],
  js: ["nodejs", "javascript"],
  jsx: ["nodejs", "javascript", "react"],
  mjs: ["nodejs", "javascript"],
  cjs: ["nodejs", "javascript"],
  go: ["go", "golang"],
  py: ["python"],
  rs: ["rust"],
  kt: ["kotlin"],
  swift: ["swift"],
  java: ["java"],
  rb: ["ruby"],
  php: ["php"],
  cs: ["csharp", "dotnet"],
  c: ["c", "cpp"],
  h: ["c", "cpp"],
  cc: ["cpp", "c"],
  cpp: ["cpp", "c"],
  hpp: ["cpp", "c"],
  scala: ["scala"],
  tf: ["terraform"],
  sh: ["shell", "bash"],
  bash: ["shell", "bash"],
  sql: ["sql", "databases"],
  prisma: ["databases", "prisma"],
};

/** Directory/filename tokens that hint at a technology even without an extension. */
const PATH_TECH_HINTS: Array<{ token: string; tech: string[] }> = [
  { token: "flutter", tech: ["flutter", "dart"] },
  { token: "android", tech: ["android", "kotlin"] },
  { token: "ios", tech: ["swift", "ios"] },
  { token: "react", tech: ["react", "javascript"] },
  { token: "vue", tech: ["vue", "javascript"] },
  { token: "django", tech: ["python", "django"] },
  { token: "rails", tech: ["ruby", "rails"] },
  { token: "terraform", tech: ["terraform"] },
  { token: "kubernetes", tech: ["kubernetes"] },
  { token: "docker", tech: ["docker"] },
  { token: "postgres", tech: ["databases", "postgres"] },
];

/** Categories that are always eligible but must not crowd out tech matches. */
const GENERAL_CATEGORIES = new Set(["general", "misc", "standards", "docs", "guidelines"]);

/**
 * Detect technology keywords from the PR's changed file paths.
 * Deterministic output (sorted, deduplicated).
 */
export function detectTechnologies(changedFiles: string[]): string[] {
  const detected = new Set<string>();
  for (const file of changedFiles) {
    const normalized = file.replace(/\\/g, "/").toLowerCase();
    const extension = normalized.includes(".") ? normalized.split(".").pop()! : "";
    for (const tech of EXTENSION_TECH[extension] ?? []) detected.add(tech);
    const segments = normalized.split("/");
    for (const hint of PATH_TECH_HINTS) {
      if (segments.some((segment) => segment.includes(hint.token))) {
        for (const tech of hint.tech) detected.add(tech);
      }
    }
  }
  return [...detected].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Tokens of a handbook file path (segments + stem words, lowercased). */
function filePathTokens(filePath: string): Set<string> {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  const segments = normalized.split("/").filter(Boolean);
  const stem = normalized.replace(/\.(md|txt|markdown)$/i, "");
  const words = stem.split(/[^a-z0-9]+/).filter((token) => token.length > 1);
  return new Set([...segments, ...words]);
}

/** Tokens of the changed file paths (reuse of the injection scoring rules). */
function changedPathTokens(changedFiles: string[]): Set<string> {
  const tokens = new Set<string>();
  for (const file of changedFiles) {
    const normalized = file.replace(/\\/g, "/").toLowerCase();
    const segments = normalized.split("/").filter(Boolean);
    const extension = normalized.includes(".") ? normalized.split(".").pop()! : "";
    const stem = normalized.replace(new RegExp(`\\.${extension}$`), "");
    for (const token of [...segments, ...stem.split(/[^a-z0-9]+/), extension]) {
      if (token.length > 1) tokens.add(token);
    }
  }
  return tokens;
}

export interface RankedHandbookFile {
  path: string;
  content: string;
  /** Combined ranking score (higher = more relevant). */
  score: number;
  /** True when the file matched one of the PR's detected technologies. */
  techMatch: boolean;
  /** True when the file lives under a general/ catch-all category. */
  general: boolean;
}

/**
 * Rank handbook files for one PR. Deterministic: ties break by path ASC.
 * Scoring: technology category match dominates, keyword overlap with the
 * changed paths is second, general categories get a small baseline only.
 */
export function rankHandbookFiles(
  files: Array<{ path: string; content: string }>,
  changedFiles: string[],
): RankedHandbookFile[] {
  const detected = detectTechnologies(changedFiles);
  const prTokens = changedPathTokens(changedFiles);

  const ranked = files.map((file) => {
    const fileTokens = filePathTokens(file.path);
    const topCategory = file.path.replace(/\\/g, "/").split("/")[0]?.toLowerCase() ?? "";

    // (a) Technology category match: file path/category mentions a detected
    // technology (e.g. `flutter/` guidelines for a Dart PR).
    let techScore = 0;
    let techMatch = false;
    for (const tech of detected) {
      const tokens = tech.split(/[^a-z0-9]+/).filter(Boolean);
      if (tokens.some((token) => token.length > 2 && [...fileTokens].some((ft) => ft.includes(token)))) {
        techScore += 4;
        techMatch = true;
      }
    }

    // (b) Heading/filename keyword overlap with the changed file paths.
    let overlapScore = 0;
    for (const token of fileTokens) {
      if (prTokens.has(token)) overlapScore += 2;
      else if ([...prTokens].some((pr) => pr.startsWith(token) || token.startsWith(pr))) overlapScore += 1;
    }

    // (c) General categories: always eligible, deprioritized (small baseline).
    const general = GENERAL_CATEGORIES.has(topCategory);
    const generalPenalty = general ? 1 : 0;

    const score = techScore * 4 + overlapScore + generalPenalty;
    return { ...file, score, techMatch, general };
  });

  return ranked.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export interface SelectionBudget {
  /** Token budget for the injected guidelines (authoritative). */
  maxTokens: number;
  /** Byte/char backstop kept from the legacy configuration. */
  maxChars: number;
}

export interface HandbookRenderOptions {
  /**
   * Workspace-relative directory holding the materialized handbook copy
   * (e.g. `knowledge/handbook-variants/<ref>`). When set, each file header
   * includes the readable workspace path in addition to the canonical
   * snapshot path used for citations.
   */
  workspacePrefix?: string;
}

/** Render the citation header, including the readable workspace copy when known. */
function handbookHeader(filePath: string, workspacePrefix?: string): string {
  const header = `## handbook file: ${filePath}`;
  if (!workspacePrefix) return header;
  const prefix = workspacePrefix.replace(/\\/g, "/").replace(/\/+$/, "");
  return `${header}\n(workspace copy: ${prefix}/${filePath})`;
}

export interface HandbookSelection {
  /** Injected guidelines text (deterministic for the same inputs). */
  text: string;
  /** Files that contributed content, in selection order. */
  files: string[];
  /** Funnel metrics: candidates → relevant → selected. */
  candidates: number;
  relevant: number;
  selected: number;
  truncated: boolean;
}

/** Stable content hash used for cross-file duplicate detection. */
function bodyHash(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

/** Split markdown text into { heading, body } sections (§-style splitter). */
function splitSections(text: string, filePath: string): Array<{ key: string; body: string }> {
  const pattern = /^#{1,3} .*/gm;
  const headings: Array<{ heading: string; start: number }> = [];
  for (const match of text.matchAll(pattern)) {
    headings.push({ heading: match[0], start: match.index ?? 0 });
  }
  if (headings.length === 0) return [{ key: `${filePath}#`, body: text.trim() }].filter((s) => s.body);
  const sections: Array<{ key: string; body: string }> = [];
  for (let i = 0; i < headings.length; i += 1) {
    const end = i + 1 < headings.length ? headings[i + 1].start : text.length;
    const body = text.slice(headings[i].start, end).trim();
    if (body) sections.push({ key: `${filePath}#${headings[i].heading}`, body });
  }
  return sections;
}

/** Score a section's keyword overlap against the changed paths (0+). */
function sectionRelevance(body: string, prTokens: Set<string>): number {
  const heading = body.match(/^#{1,3} .*$/m)?.[0]?.toLowerCase() ?? "";
  let score = 0;
  for (const token of heading.split(/[^a-z0-9]+/)) {
    if (token.length <= 2) continue;
    if (prTokens.has(token)) score += 2;
    else if ([...prTokens].some((pr) => pr.startsWith(token) || token.startsWith(pr))) score += 1;
  }
  return score;
}

/**
 * Select handbook content under the token budget. Higher-ranked files are
 * preferred WHOLE; only when a whole file does not fit are its top sections
 * taken (never mid-section fragments). Identical content is never injected
 * twice (dedup by section key and body hash). `truncated` is true when the
 * budget forced any ranked content to be dropped.
 */
export function selectHandbookUnderBudget(
  ranked: RankedHandbookFile[],
  changedFiles: string[],
  budget: SelectionBudget,
  options: HandbookRenderOptions = {},
): HandbookSelection {
  const maxChars = Math.min(Math.max(budget.maxTokens, 1) * CHARS_PER_TOKEN, Math.max(budget.maxChars, 1));
  const prTokens = changedPathTokens(changedFiles);
  const seenKeys = new Set<string>();
  const seenBodies = new Set<string>();
  const parts: string[] = [];
  const usedFiles = new Set<string>();
  let used = 0;
  let truncated = false;
  let relevant = 0;

  const tryAdd = (file: RankedHandbookFile, sections: Array<{ key: string; body: string }>): boolean => {
    const header = handbookHeader(file.path, options.workspacePrefix);
    const wholeFile = `${header}\n\n${file.content}`;
    if (used + wholeFile.length <= maxChars) {
      // Whole-file preference: take the file intact when it fits.
      if (usedFiles.has(file.path) || seenKeys.has(file.path)) return false;
      // Cross-file dedup: skip the file when ANY of its sections duplicates
      // content already injected from another file.
      if (sections.some((section) => seenBodies.has(bodyHash(section.body)))) return false;
      seenKeys.add(file.path);
      parts.push(wholeFile);
      usedFiles.add(file.path);
      used += wholeFile.length + 2;
      for (const section of sections) seenBodies.add(bodyHash(section.body));
      return true;
    }
    // Budget path: as many whole top sections as fit, no fragments.
    let fileSelected = false;
    for (const section of sections) {
      if (seenKeys.has(section.key)) continue;
      if (seenBodies.has(bodyHash(section.body))) continue;
      const render = `${header}\n\n${section.body}`;
      if (used + render.length > maxChars) {
        truncated = true;
        break;
      }
      seenKeys.add(section.key);
      seenBodies.add(bodyHash(section.body));
      parts.push(render);
      usedFiles.add(file.path);
      used += render.length + 2;
      fileSelected = true;
    }
    return fileSelected;
  };

  // Pass 1 — ranked files that are relevant to this PR (score > 0).
  for (const file of ranked) {
    const sections = scoredSections(file, prTokens);
    const hasRelevantSection = file.score > 0 || sections.some((s) => s.score > 0);
    if (!hasRelevantSection) continue;
    relevant += 1;
    tryAdd(file, sections);
    // Degenerate budget: not even ONE section of the top-ranked file fit.
    // Prefer a single truncated fragment over an empty injection.
    if (parts.length === 0 && sections.length > 0) {
      const header = handbookHeader(file.path, options.workspacePrefix);
      const render = `${header}\n\n${sections[0].body.slice(0, maxChars)}\n(truncated)`;
      seenKeys.add(sections[0].key);
      seenBodies.add(bodyHash(sections[0].body));
      parts.push(render);
      usedFiles.add(file.path);
      used += render.length + 2;
      truncated = true;
    }
  }

  // Pass 2 — fallback: nothing relevant matched, keep general standards
  // flowing (mirrors the legacy "first sections win" behavior).
  if (usedFiles.size === 0) {
    for (const file of ranked.slice(0, 3)) {
      if (used >= maxChars) break;
      tryAdd(file, scoredSections(file, prTokens));
    }
  }

  return {
    text: parts.join("\n\n"),
    files: [...usedFiles],
    candidates: ranked.length,
    relevant,
    selected: usedFiles.size,
    truncated: truncated || used > maxChars,
  };
}

/** Sections of one file, deterministically sorted by relevance then key. */
function scoredSections(
  file: RankedHandbookFile,
  prTokens: Set<string>,
): Array<{ key: string; body: string; score: number }> {
  return splitSections(file.content, file.path)
    .map((section) => ({ ...section, score: sectionRelevance(section.body, prTokens) }))
    .sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
