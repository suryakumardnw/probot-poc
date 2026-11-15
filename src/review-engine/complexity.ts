/**
 * Adaptive complexity scoring (ARCHITECTURE.md §5.4).
 *
 * Seven configurable-weight factors are scored from the prepared workspace
 * (diff + changed files). The weighted sum (0..10) selects a complexity tier
 * that drives investigation depth, model-call limits, retrieval budget, token
 * allocation, timeout and verification effort.
 *
 * The scorer is deterministic and never calls the model, so it is fully
 * unit-testable and auditable (each factor carries a human-readable detail).
 */

import type { ReviewConfig } from "../config/review-schema.js";
import type { WorkspaceResult } from "../modules/workspace/index.js";
import type { ComplexityFactor, ComplexityFactorName, ComplexityScore, ComplexityTier } from "./types.js";

/** Lines added/removed beyond which the diff-size subscore saturates. */
const DIFF_SIZE_SATURATION = 400;
/** Changed files beyond which the file-count subscore saturates. */
const FILES_SATURATION = 40;
/** Keyword matches beyond which the risk keyword subscores saturate. */
const KEYWORD_SATURATION = 6;
/** Distinct top-level directories beyond which dependency impact saturates. */
const TOP_DIR_SATURATION = 6;

const RISKY_KEYWORDS = [
  "auth",
  "token",
  "secret",
  "password",
  "credential",
  "permission",
  "role",
  "session",
  "payment",
  "billing",
  "license",
  "crypto",
] as const;

const CONCURRENCY_KEYWORDS = [
  "async",
  "await",
  "promise",
  "mutex",
  "lock",
  "thread",
  "race",
  "concurrent",
  "worker",
  "queue",
  "shared",
  "volatile",
  "setinterval",
  "settimeout",
] as const;

const DATA_KEYWORDS = [
  "transaction",
  "rollback",
  "migration",
  "prisma",
  "database",
  "sql",
  "insert",
  "upsert",
  "delete",
  "commit",
  "persist",
  "save",
] as const;

/** Files whose change signals cross-module dependency impact. */
const DEPENDENCY_FILES = ["package.json", "package-lock.json", "requirements.txt", "go.mod", "cargo.toml", "pom.xml"];

interface DiffStats {
  added: number;
  removed: number;
  /** Content lines of the diff body, excluding headers (diff/index/@@/+++/---). */
  bodyLines: string[];
  newFiles: number;
  deletedFiles: number;
  renamedFiles: number;
}

/** Parse aggregate statistics out of a unified diff without external deps. */
export function parseDiffStats(diff: string): DiffStats {
  const stats: DiffStats = { added: 0, removed: 0, bodyLines: [], newFiles: 0, deletedFiles: 0, renamedFiles: 0 };
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff ")) {
      if (line.includes("new file mode") || line.includes("new file")) {
        stats.newFiles++;
      }
      if (line.includes("deleted file mode")) {
        stats.deletedFiles++;
      }
      if (line.includes("rename from") || line.includes("similarity index")) {
        stats.renamedFiles++;
      }
      continue;
    }
    if (line.startsWith("index ") || line.startsWith("@@") || line.startsWith("---") || line.startsWith("+++")) {
      continue;
    }
    if (line.startsWith("+")) {
      stats.added++;
      stats.bodyLines.push(line.slice(1));
    } else if (line.startsWith("-")) {
      stats.removed++;
      stats.bodyLines.push(line.slice(1));
    } else {
      stats.bodyLines.push(line);
    }
  }
  return stats;
}

function countKeywordMatches(lines: string[], keywords: readonly string[]): number {
  let count = 0;
  for (const line of lines) {
    const lower = line.toLowerCase();
    for (const keyword of keywords) {
      if (lower.includes(keyword)) {
        count++;
      }
    }
  }
  return count;
}

const cap = (value: number, max: number) => Math.min(1, value / max);

/**
 * Score one workspace. Never throws on a empty diff (score 0) — an empty PR
 * is the trivially "low" tier.
 */
export function scoreComplexity(workspace: WorkspaceResult, config: ReviewConfig): ComplexityScore {
  const weights = config.review.complexity.weights;
  const stats = parseDiffStats(workspace.diff);
  const changedCount = Math.max(workspace.changedFiles.length, 1);

  const topDirs = new Set(
    workspace.changedFiles.map((f) => f.path.split("/")[0] ?? f.path).filter((dir) => dir.length > 0),
  );
  const touchesDependencyFile = workspace.changedFiles.some((f) =>
    DEPENDENCY_FILES.includes(f.path.split("/").pop() ?? f.path),
  );

  const riskyMatches = countKeywordMatches(
    [...stats.bodyLines, ...workspace.changedFiles.map((f) => f.path)],
    RISKY_KEYWORDS,
  );
  const concurrencyMatches = countKeywordMatches(stats.bodyLines, CONCURRENCY_KEYWORDS);
  const dataMatches = countKeywordMatches(
    [...stats.bodyLines, ...workspace.changedFiles.map((f) => f.path)],
    DATA_KEYWORDS,
  );

  const raw: Record<ComplexityFactorName, { subscore: number; detail: string }> = {
    diffSize: {
      subscore: cap(stats.added + stats.removed, DIFF_SIZE_SATURATION),
      detail: `${stats.added + stats.removed} changed lines (+${stats.added}/-${stats.removed})`,
    },
    changedFiles: {
      subscore: cap(workspace.changedFiles.length, FILES_SATURATION),
      detail: `${workspace.changedFiles.length} changed files`,
    },
    structural: {
      subscore: Math.min(
        1,
        (stats.newFiles + stats.deletedFiles + stats.renamedFiles) / changedCount +
          cap(workspace.changedFiles.length, FILES_SATURATION) * 0.2,
      ),
      detail: `${stats.newFiles} added, ${stats.deletedFiles} deleted, ${stats.renamedFiles} renamed`,
    },
    dependencyImpact: {
      subscore: Math.min(1, cap(topDirs.size, TOP_DIR_SATURATION) + (touchesDependencyFile ? 0.5 : 0)),
      detail: `${topDirs.size} top-level areas touched${touchesDependencyFile ? "; manifest/lockfile changed" : ""}`,
    },
    riskyCode: {
      subscore: cap(riskyMatches, KEYWORD_SATURATION),
      detail: `${riskyMatches} risk-sensitive keyword hits (auth/payment/secret/...)`,
    },
    concurrency: {
      subscore: cap(concurrencyMatches, KEYWORD_SATURATION),
      detail: `${concurrencyMatches} concurrency-related keyword hits`,
    },
    dataIntegrity: {
      subscore: cap(dataMatches, KEYWORD_SATURATION),
      detail: `${dataMatches} data-integrity keyword hits (transaction/migration/...)`,
    },
  };

  const factors: ComplexityFactor[] = (Object.keys(raw) as ComplexityFactorName[]).map((name) => ({
    name,
    subscore: raw[name].subscore,
    weight: weights[name],
    contribution: raw[name].subscore * weights[name],
    detail: raw[name].detail,
  }));

  const score = Math.min(
    10,
    factors.reduce((sum, f) => sum + f.contribution, 0),
  );
  const thresholds = config.review.complexity.thresholds;
  const tier: ComplexityTier = score < thresholds.low ? "low" : score < thresholds.medium ? "medium" : "high";
  return { score: Math.round(score * 100) / 100, tier, factors };
}
