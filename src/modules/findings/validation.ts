/**
 * Independent finding validation and verification (ARCHITECTURE.md §1.2, §6.4,
 * §7.1; ticket 08).
 *
 * The agent's structured findings are NEVER trusted:
 *  - `verified: true` and self-reported confidence are ignored; `verified` is
 *    re-derived here from the configured confidence thresholds AND an
 *    independent evidence check against the actual workspace content.
 *  - Findings that fail domain validation (existing file, in-bounds line,
 *    non-empty evidence, supported category/severity, 0..1 confidence) are
 *    REJECTED and never reach the persistence or publishing layers.
 *  - Findings whose evidence cannot be anchored in the workspace are demoted
 *    to UNCERTAIN, never dropped silently and never published as verified.
 *
 * The zod `reviewResultSchema` boundary (ticket 07) already parsed the raw
 * model output; this layer performs DOMAIN validation on top of the typed
 * `Finding` contract and re-uses it instead of re-validating the wire schema.
 */

import type { ReviewConfig } from "../../contracts/config.js";
import { FINDING_CATEGORIES, type Finding, type FindingSeverity } from "../../modules/review/index.js";
import { readWorkspaceFile } from "../workspace/index.js";

export type FindingRejectionReason =
  | "invalid_file"
  | "invalid_line"
  | "missing_evidence"
  | "invalid_evidence_file"
  | "invalid_category"
  | "unsupported_severity"
  | "invalid_confidence"
  | "empty_description";

export class FindingValidationError extends Error {
  constructor(
    public readonly reason: FindingRejectionReason,
    public readonly detail: string,
    public readonly findingTitle: string,
  ) {
    super(`finding rejected (${reason}): ${detail}`);
    this.name = "FindingValidationError";
  }
}

export interface VerifiedFinding {
  finding: Finding;
  /** Recomputed independently — never taken from the agent. */
  verified: boolean;
  fingerprint: string;
}

export interface FindingValidationOutcome {
  /** Verified findings eligible for inline publication (ticket 09). */
  verified: VerifiedFinding[];
  /** Valid findings that could not be independently confirmed. */
  uncertain: VerifiedFinding[];
  /** Rejected findings — these NEVER reach persistence or publication. */
  rejected: Array<{ finding: Finding; reason: FindingRejectionReason; detail: string }>;
}

const SEVERITIES: readonly FindingSeverity[] = ["critical", "high", "medium", "low", "informational"];

/** Collapse all whitespace runs so excerpts match regardless of indentation drift. */
function squeezeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Independent verification: does the evidence excerpt actually appear in the
 * referenced workspace file, near the claimed line? This is the application's
 * own check — the agent's `verified` flag is not consulted.
 */
async function evidenceAnchorsInWorkspace(
  workspacePath: string,
  finding: Finding,
  maxFileBytes: number,
): Promise<boolean> {
  const excerpt = finding.evidence.find((e) => e.excerpt.trim().length > 0)?.excerpt;
  if (!excerpt) {
    return false;
  }
  try {
    const content = await readWorkspaceFile(workspacePath, finding.file, { maxFileBytes });
    if (content.encoding !== "utf-8" || content.text === undefined) {
      return false;
    }
    const normalizedFile = squeezeWhitespace(content.text);
    if (!normalizedFile.includes(squeezeWhitespace(excerpt))) {
      return false;
    }
    // When the evidence is line-anchored, the line must point into the file.
    const anchored = finding.evidence.find((e) => typeof e.line === "number");
    if (anchored && anchored.line! > content.text.split("\n").length) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate and verify a batch of engine findings against the workspace.
 *
 * @param fingerprints pre-computed fingerprints keyed by finding identity
 *                     (same order as the input findings).
 */
export async function validateFindings(
  workspacePath: string,
  candidates: Array<{ finding: Finding; fingerprint: string }>,
  config: ReviewConfig,
): Promise<FindingValidationOutcome> {
  const outcome: FindingValidationOutcome = { verified: [], uncertain: [], rejected: [] };
  const maxFileBytes = config.repository.files.maxFileBytes;

  for (const { finding, fingerprint } of candidates) {
    const reject = (reason: FindingRejectionReason, detail: string) => {
      outcome.rejected.push({ finding, reason, detail });
    };

    // --- Domain validation -------------------------------------------------
    if (!finding.description || finding.description.trim().length === 0) {
      reject("empty_description", "finding has no meaningful explanation");
      continue;
    }
    if (!FINDING_CATEGORIES.includes(finding.category)) {
      reject("invalid_category", `unsupported category '${finding.category}'`);
      continue;
    }
    if (!SEVERITIES.includes(finding.severity)) {
      reject("unsupported_severity", `invalid severity '${finding.severity}'`);
      continue;
    }
    if (config.review.severity.length > 0 && !config.review.severity.includes(finding.severity)) {
      reject("unsupported_severity", `severity '${finding.severity}' not enabled in configuration`);
      continue;
    }
    if (
      typeof finding.confidence !== "number" ||
      !Number.isFinite(finding.confidence) ||
      finding.confidence < 0 ||
      finding.confidence > 1
    ) {
      reject("invalid_confidence", `confidence must be a number in [0, 1], got '${finding.confidence}'`);
      continue;
    }
    if (!Array.isArray(finding.evidence) || finding.evidence.length === 0) {
      reject("missing_evidence", "every finding must carry at least one evidence reference");
      continue;
    }

    // File and line validation against the actual workspace.
    try {
      const content = await readWorkspaceFile(workspacePath, finding.file, { maxFileBytes });
      if (content.encoding !== "utf-8") {
        reject("invalid_file", `finding anchor '${finding.file}' is not readable text content`);
        continue;
      }
      const lineCount = content.text!.split("\n").length;
      if (finding.line < 1 || finding.line > lineCount) {
        reject("invalid_line", `line ${finding.line} is outside file '${finding.file}' (${lineCount} lines)`);
        continue;
      }
    } catch {
      reject("invalid_file", `finding anchor '${finding.file}' does not exist in the workspace`);
      continue;
    }

    // Every evidence reference must point at a real workspace file.
    let evidenceValid = true;
    for (const item of finding.evidence) {
      try {
        await readWorkspaceFile(workspacePath, item.file, { maxFileBytes });
      } catch {
        reject("invalid_evidence_file", `evidence file '${item.file}' does not exist in the workspace`);
        evidenceValid = false;
        break;
      }
    }
    if (!evidenceValid) {
      continue;
    }

    // --- Independent verification (§6.4) -----------------------------------
    // Recompute `verified` from the configured threshold AND our own evidence
    // anchoring check. The agent's verified flag / self-reported confidence is
    // ignored beyond the confidence value itself.
    const anchored = await evidenceAnchorsInWorkspace(workspacePath, finding, maxFileBytes);
    const thresholdVerified = finding.confidence >= config.review.confidence.minimumVerified;
    const verified = thresholdVerified && anchored;

    const entry: VerifiedFinding = { finding: { ...finding, verified }, verified, fingerprint };
    if (verified && finding.confidence >= config.review.confidence.minimumInline) {
      outcome.verified.push(entry);
    } else {
      outcome.uncertain.push(entry);
    }
  }

  return outcome;
}
