/**
 * Review-type prompt injection (ARCHITECTURE.md §4.1, §5.3).
 *
 * `skill` and `handbook` reviews run the SAME adaptive engine as `standard`
 * reviews (decision 3: reviewMode/strategy is independent of reviewType);
 * the only difference is extra methodology text injected into the review
 * instructions, composed with the trusted instruction profiles in
 * `src/modules/review/prompts/`:
 *
 * - `skill`   — a code-review playbook, taken ONLY from the review's own
 *               knowledge snapshot copy (knowledge/skill/ inside the review
 *               workspace, materialized at pipeline start from the boot-time
 *               cache). There is no local fallback: without a played-back
 *               snapshot the review fails with SKILL_PLAYBOOK_UNAVAILABLE.
 * - `handbook`— relevant standards/conventions selected from the review's
 *               own knowledge snapshot copy (knowledge/handbook/) by the
 *               TRUSTED RETRIEVAL LAYER (retrieval.ts — Option A: the agent
 *               receives only injected text and never retrieves knowledge
 *               itself). Fetched ONCE per worker boot — never per review,
 *               no GitHub API calls here. Fails with HANDBOOK_UNCONFIGURED
 *               (no repository configured) or HANDBOOK_UNAVAILABLE (no
 *               snapshot content).
 *
 * Retrieval is budgeted in TOKENS (knowledge.handbook.maxTokens /
 * knowledge.skill.maxTokens, ≈4 chars/token) with maxChars as a byte-level
 * backstop, is deterministic (stable ranking + tie-breaking) and dedupes
 * identical content. Per-review funnel metrics ride on the returned
 * PromptInjection and are persisted on the Review row by the pipeline.
 *
 * Reproducibility (§4): injection reads ONLY the review's own copies, so a
 * cache refresh can never change an in-flight review.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { ReviewConfig } from "../../contracts/config.js";
import type { Logger } from "../../ports/logger.js";
import { handbookVariantDir, type KnowledgeHandbookVariant, type KnowledgeSnapshot } from "../knowledge/index.js";
import { HANDBOOK_REFERENCE_INSTRUCTIONS } from "./prompts/index.js";
import {
  CHARS_PER_TOKEN,
  detectTechnologies,
  rankHandbookFiles,
  selectHandbookUnderBudget,
  type RankedHandbookFile,
} from "./retrieval.js";
import { ReviewEngineError, type PromptInjection, type KnowledgeInjectionMetrics } from "./types.js";

export type { PromptInjection, KnowledgeInjectionMetrics };

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Deterministic file order for concatenation (sorted by path). */
function listMarkdownFiles(dir: string): Promise<string[]> {
  return fsp.readdir(dir, { recursive: true, encoding: "utf8" }).then((entries) =>
    entries
      .filter((entry) => {
        const relative = path.relative(dir, path.resolve(dir, entry));
        if (relative.startsWith("..") || path.isAbsolute(relative)) {
          return false;
        }
        const stats = fs.statSync(path.resolve(dir, entry));
        return stats.isFile() && /\.(md|txt)$/i.test(entry);
      })
      .map((entry) => path.relative(dir, path.resolve(dir, entry)).split(path.sep).join("/"))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

/** Estimated token count of a text (≈4 chars/token — see retrieval.ts). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Apply the token budget to injected knowledge text (backstop-style). */
function enforceTokenBudget(text: string, maxTokens: number): { text: string; truncated: boolean } {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return { text: `${text.slice(0, maxChars)}\n(truncated to fit the knowledge token budget)`, truncated: true };
}

// ---------------------------------------------------------------------------
// Skill playbook
// ---------------------------------------------------------------------------

/**
 * Skill injection from the review's own snapshot copy: prefer the skill's
 * main SKILL.md; otherwise concatenate the .md/.txt files deterministically
 * sorted by path. Never touches the shared cache or the network. The result
 * is clipped to knowledge.skill.maxTokens (≈4 chars/token).
 */
async function injectSkillFromSnapshot(
  knowledgeDir: string,
  snapshot: KnowledgeSnapshot,
  config: ReviewConfig,
): Promise<PromptInjection> {
  const source = snapshot.skill;
  if (source.status === "unavailable" || !source.dir) {
    // No fallback content: the playbook must come from the fetched source.
    throw new ReviewEngineError(
      "skill_playbook_unavailable",
      "Review type 'skill' requires the code-review playbook, which is unavailable in the knowledge cache",
    );
  }
  const dir = path.join(knowledgeDir, "skill");
  const files = await listMarkdownFiles(dir);
  if (files.length === 0) {
    throw new ReviewEngineError(
      "skill_playbook_unavailable",
      "The review's knowledge snapshot contains no skill playbook files",
    );
  }
  const preferred = files.find((file) => path.posix.basename(file).toLowerCase() === "skill.md");
  const used = preferred ? [preferred] : files;
  const joined = used
    .map((file) => fs.readFileSync(path.join(dir, file.split("/").join(path.sep)), "utf8"))
    .join("\n\n");
  if (joined.trim().length === 0) {
    throw new ReviewEngineError("skill_playbook_unavailable", "The injected skill playbook is empty");
  }
  const budgeted = enforceTokenBudget(joined, config.knowledge.skill.maxTokens);
  return {
    label: "code-review playbook",
    profile: "skill",
    text: budgeted.text,
    files: used,
    contentHash: source.contentHash,
    metrics: {
      injectedTokens: estimateTokens(budgeted.text),
      documentsRetrieved: used.length,
      candidates: used.length,
      relevant: used.length,
      selected: used.length,
      truncated: budgeted.truncated,
    },
  };
}

// ---------------------------------------------------------------------------
// Handbook injection (snapshot copy only)
// ---------------------------------------------------------------------------

/** Tokens used for relevance scoring: path segments + extensions, lowercased. */
function pathTokens(filePath: string): Set<string> {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  const segments = normalized.split("/");
  const extension = path.posix.extname(normalized);
  const base = path.posix.basename(normalized, extension);
  return new Set(
    [...segments.filter(Boolean), ...(base ? base.split(/[^a-z0-9]+/) : []), extension.replace(/^\./, "")].filter(
      (t) => t.length > 1,
    ),
  );
}

function headingTokens(heading: string): string[] {
  return heading
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2);
}

/**
 * Legacy single-document section selection (kept for compatibility and as
 * the playbook path): split markdown text into sections on markdown
 * headings and score each section by keyword overlap with the changed file
 * paths. Sections with zero overlap are dropped; if nothing overlaps, the
 * first sections win so general standards still reach the prompt.
 */
export function selectHandbookSections(text: string, changedFiles: string[], maxChars: number): string {
  const prTokens = new Set<string>();
  for (const file of changedFiles) {
    for (const token of pathTokens(file)) {
      prTokens.add(token);
    }
  }

  const sectionPattern = /^#{1,3} .*/gm;
  const headings: Array<{ heading: string; start: number }> = [];
  for (const match of text.matchAll(sectionPattern)) {
    headings.push({ heading: match[0], start: match.index ?? 0 });
  }
  if (headings.length === 0) {
    return text.slice(0, maxChars);
  }

  const sections: Array<{ heading: string; body: string; score: number }> = [];
  for (const [i, heading] of headings.entries()) {
    const nextHeading = headings[i + 1];
    const start = heading.start;
    const end = nextHeading !== undefined ? nextHeading.start : text.length;
    const sectionText = text.slice(start, end).trim();
    if (!sectionText) {
      continue;
    }
    const tokens = headingTokens(heading.heading);
    let score = 0;
    for (const token of tokens) {
      if (prTokens.has(token)) {
        score += 2;
      } else if ([...prTokens].some((pr) => pr.startsWith(token) || token.startsWith(pr))) {
        score += 1;
      }
    }
    sections.push({ heading: heading.heading, body: sectionText, score });
  }

  const relevant = sections.filter((s) => s.score > 0);
  const chosen = (relevant.length > 0 ? relevant : sections.slice(0, 3)).sort((a, b) => b.score - a.score);

  const out: string[] = [];
  let used = 0;
  for (const section of chosen) {
    if (used >= maxChars) {
      break;
    }
    const remaining = maxChars - used;
    out.push(section.body.length > remaining ? `${section.body.slice(0, remaining)}\n(truncated)` : section.body);
    used += Math.min(section.body.length, remaining) + 2;
  }
  return out.join("\n\n");
}

function handbookNotConfigured(): ReviewEngineError {
  return new ReviewEngineError(
    "handbook_unconfigured",
    "Review type 'handbook' requires knowledge.handbook.repo to be configured",
  );
}

/**
 * Later-stage handbook instructions. Each stage is a separate `opencode run`
 * process with no shared conversation, so the guidelines must travel with
 * every prompt. Re-provide the selected text (bounded by the same token
 * budget) and keep the file list for quick citation reference.
 */
function handbookLaterStagesText(selected: RankedHandbookFile[], text: string): string {
  const listed = selected.map((file) => file.path).join(", ") || "(none)";
  return `${HANDBOOK_REFERENCE_INSTRUCTIONS}\n\nHANDBOOK GUIDELINES (authoritative; re-provided because stages do not share context):\n${text}\n\nHANDBOOK FILES PROVIDED IN THE ANALYSIS STAGE: ${listed}`;
}

/**
 * Pick the handbook ref whose technologies match the PR. Config order is
 * significant: the first matching variant wins; no match → default handbook.
 */
export function selectHandbookVariant(
  snapshot: Pick<KnowledgeSnapshot, "handbookVariants">,
  detectedTechnologies: string[],
): KnowledgeHandbookVariant | undefined {
  const detected = new Set(detectedTechnologies.map((tech) => tech.toLowerCase()));
  return (snapshot.handbookVariants ?? []).find((variant) =>
    variant.technologies.some((tech) => detected.has(tech.toLowerCase())),
  );
}

/**
 * Handbook injection from the review's own snapshot copy: rank the cached
 * handbook files against the PR's detected technologies and changed paths
 * (trusted retrieval layer), then select content under the token budget —
 * deterministic, deduplicated, whole-file-preferring. maxChars remains a
 * byte-level backstop.
 *
 * When the PR matches a configured per-technology ref (e.g. TypeScript
 * guidelines on a separate branch), that variant's own copy is used instead
 * of the default handbook.
 */
async function injectHandbookFromSnapshot(
  knowledgeDir: string,
  snapshot: KnowledgeSnapshot,
  config: ReviewConfig,
  changedFiles: string[],
  logger: Logger,
): Promise<PromptInjection> {
  const detected = detectTechnologies(changedFiles);
  const variant = selectHandbookVariant(snapshot, detected);
  const source = variant?.source ?? snapshot.handbook;
  if (source.status === "unavailable" || !source.dir) {
    throw new ReviewEngineError(
      "handbook_unavailable",
      variant
        ? `The engineering handbook ref '${variant.source.ref}' for technology '${variant.technologies.join(", ")}' is unavailable in the knowledge cache (boot-time fetch failed)`
        : "The engineering handbook is unavailable in the knowledge cache (boot-time fetch failed)",
    );
  }
  const dir = variant ? handbookVariantDir(knowledgeDir, source.ref) : path.join(knowledgeDir, "handbook");
  const files = await listMarkdownFiles(dir);
  if (files.length === 0) {
    throw new ReviewEngineError("handbook_unavailable", "The review's knowledge snapshot contains no handbook files");
  }

  const ranked: RankedHandbookFile[] = [];
  for (const file of files) {
    const content = fs.readFileSync(path.join(dir, file.split("/").join(path.sep)), "utf8");
    ranked.push({ path: file, content, score: 0, techMatch: false, general: false });
  }
  const ordered = rankHandbookFiles(ranked, changedFiles);
  // The knowledge copy lives at `<workspace>/knowledge/...`; expose its
  // workspace-relative path so the model can read the full file when useful
  // instead of guessing the handbook repository path.
  const relativeKnowledgeDir = path.relative(path.dirname(knowledgeDir), dir).split(path.sep).join("/");
  const workspacePrefix =
    relativeKnowledgeDir && !relativeKnowledgeDir.startsWith("..") && !path.isAbsolute(relativeKnowledgeDir)
      ? relativeKnowledgeDir
      : undefined;
  const selection = selectHandbookUnderBudget(
    ordered,
    changedFiles,
    {
      maxTokens: config.knowledge.handbook.maxTokens,
      maxChars: config.knowledge.handbook.maxChars,
    },
    { workspacePrefix },
  );
  if (selection.text.trim().length === 0) {
    throw new ReviewEngineError("handbook_unavailable", "Handbook selection produced no injectable content");
  }
  if (selection.truncated) {
    logger.warn(
      { selected: selection.selected, relevant: selection.relevant, candidates: selection.candidates },
      "Handbook retrieval truncated by the token budget",
    );
  }
  logger.info(
    {
      chars: selection.text.length,
      estimatedTokens: estimateTokens(selection.text),
      files: selection.files,
      handbookRef: source.ref,
      technologyRef: variant ? variant.technologies : undefined,
      detectedTechnologies: detected,
      funnel: `${selection.candidates} candidates -> ${selection.relevant} relevant -> ${selection.selected} selected`,
      truncated: selection.truncated,
    },
    "Handbook excerpt injected into review instructions",
  );
  const selectedFiles = ordered.filter((file) => selection.files.includes(file.path));
  return {
    label: "handbook standards",
    profile: "handbook",
    text: selection.text,
    laterStagesText: handbookLaterStagesText(selectedFiles, selection.text),
    files: selection.files,
    guidelineSource: { repo: config.knowledge.handbook.repo, ref: source.ref },
    contentHash: source.contentHash,
    metrics: {
      injectedTokens: estimateTokens(selection.text),
      documentsRetrieved: selection.selected,
      candidates: selection.candidates,
      relevant: selection.relevant,
      selected: selection.selected,
      truncated: selection.truncated,
    },
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Resolve the prompt injection for one review. Returns null for `standard`
 * reviews (the default flow is unchanged) and throws typed engine errors
 * for unavailable skill/handbook content (fail-fast; §8.4).
 */
export async function resolveReviewInjection(input: ResolveInjectionInput): Promise<PromptInjection | null> {
  const { reviewType, config, logger } = input;
  if (reviewType === "skill") {
    if (!input.knowledgeDir || !input.snapshot) {
      throw new ReviewEngineError(
        "skill_playbook_unavailable",
        "No knowledge snapshot was materialized for this review (boot-time knowledge init did not run)",
      );
    }
    const injection = await injectSkillFromSnapshot(input.knowledgeDir, input.snapshot, config);
    logger.info(
      { files: injection.files, contentHash: injection.contentHash, metrics: injection.metrics },
      "Skill playbook injected into review instructions",
    );
    return injection;
  }
  if (reviewType === "handbook") {
    const settings = config.knowledge.handbook;
    if (!settings.repo.trim()) {
      throw handbookNotConfigured();
    }
    if (!input.knowledgeDir || !input.snapshot) {
      throw new ReviewEngineError(
        "handbook_unavailable",
        "No knowledge snapshot was materialized for this review (boot-time knowledge init did not run)",
      );
    }
    return injectHandbookFromSnapshot(input.knowledgeDir, input.snapshot, config, input.changedFiles, logger);
  }
  return null;
}

export interface ResolveInjectionInput {
  reviewType: string;
  config: ReviewConfig;
  /** Changed file paths of the PR (handbook relevance scoring). */
  changedFiles: string[];
  /**
   * Directory holding the review's OWN knowledge snapshot copy
   * (`knowledge/` under the review workspace), materialized at pipeline
   * start. Injection never reads the shared cache or the network.
   */
  knowledgeDir?: string | null;
  /** Boot-time knowledge snapshot (null when knowledge init never ran). */
  snapshot?: KnowledgeSnapshot | null;
  logger: Logger;
}
