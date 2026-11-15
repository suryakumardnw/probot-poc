/**
 * Finding persistence and lifecycle management (ARCHITECTURE.md §7.2, §7.3,
 * §13.1; ticket 08).
 *
 * Pipeline applied to the engine's `ReviewEngineResult` findings:
 *
 *   validate → verify → fingerprint → dedupe (within review)
 *     → compare with historical findings (same repository + fingerprint
 *       across prior reviews) → assign lifecycle statuses → persist
 *       (with persisted transitions).
 *
 * Guarantees:
 *  - Only VALID findings are persisted; rejected findings are reported back
 *    and never reach the publishing layer (ticket 09).
 *  - Uncertain findings are stored with lifecycle status `uncertain`, always
 *    separated from verified findings.
 *  - Every lifecycle status change is persisted in finding_status_transitions.
 *  - Superseded reviews (ticket 03) have their active findings transitioned
 *    to `superseded` via `supersedeFindingsForReview`.
 *
 * Persistence goes through the findings repository and unit of work: row
 * creation, resolution, supersession, and their transitions commit together or
 * roll back together. Fingerprinting and validation stay pure.
 */

import type { ReviewConfig } from "../../config/review-schema.js";
import type { Logger } from "../../ports/logger.js";
import type { Finding } from "../../review-engine/index.js";
import {
  ACTIVE_FINDING_STATUSES,
  isActiveFindingStatus,
  type ActiveFindingStatus,
  type CreatedFindingRecord,
  type FindingRecord,
  type PriorFindingRecord,
} from "./findings.repository.js";
import type { FindingsRepositories } from "./findings.unit-of-work.js";
import { computeFindingFingerprint } from "./fingerprint.js";
import type { FindingsServiceDependencies } from "./prisma-findings.unit-of-work.js";
import { validateFindings, type FindingRejectionReason } from "./validation.js";

export interface PersistReviewFindingsInput {
  repositoryId: string;
  /** Stable repository identity for fingerprints (full name preferred). */
  repositoryFullName: string;
  reviewId: string;
  /** Prepared review workspace used for file/line/evidence verification. */
  workspacePath: string;
  /** Engine result: inline-eligible findings. */
  findings: Finding[];
  /** Engine result: low-confidence findings. */
  uncertainFindings: Finding[];
  config: ReviewConfig;
  /** Persistence boundary built by the composition root (or a test fake). */
  dependencies: FindingsServiceDependencies;
  logger?: Logger;
}

export interface StoredFinding {
  id: string;
  fingerprint: string;
  category: string;
  severity: string;
  confidence: number;
  title: string;
  filePath: string;
  lineNumber: number;
  description: string;
  /** Why the defect matters (optional for older findings). */
  impact?: string;
  /** Actionable fix (optional for older findings). */
  recommendation?: string;
  /** Short guideline reference, if the finding is guideline-derived. */
  guideline?: string;
  /** Retained evidence references for the collapsed technical details. */
  evidence?: Array<{ file: string; line?: number; excerpt: string; reason: string }>;
  verified: boolean;
  status: "new" | "existing" | "updated" | "uncertain";
  /** Set when a previously resolved issue was reintroduced. */
  reopened: boolean;
}

export interface PersistReviewFindingsResult {
  /** What the publishing layer (ticket 09) may use — valid findings only. */
  stored: StoredFinding[];
  rejected: Array<{ title: string; reason: FindingRejectionReason; detail: string }>;
  /** Number of persisted lifecycle transitions. */
  transitions: number;
  /** Fingerprints of historical findings marked resolved by this review. */
  resolved: string[];
}

// ---------------------------------------------------------------------------
// Historical lookup
// ---------------------------------------------------------------------------

/**
 * Latest occurrence per fingerprint for one repository, across all reviews
 * except the current one (§7.3: compare previous findings per commit).
 */
async function loadPriorFindings(
  repositories: FindingsRepositories,
  repositoryId: string,
  excludeReviewId: string,
): Promise<Map<string, PriorFindingRecord>> {
  const rows = await repositories.findings.findPriorOccurrences({ repositoryId, excludeReviewId });
  const latest = new Map<string, PriorFindingRecord>();
  for (const row of rows) {
    if (!latest.has(row.fingerprint)) {
      latest.set(row.fingerprint, row);
    }
  }
  return latest;
}

/** Did the issue materially change compared with the prior occurrence? */
function materiallyChanged(finding: Finding, prior: PriorFindingRecord): boolean {
  return finding.severity !== prior.severity || finding.line !== prior.lineNumber;
}

/** Map a freshly persisted row into the publishing-layer shape. */
function mapStoredFinding(row: CreatedFindingRecord, reopened: boolean): StoredFinding {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    category: row.category,
    severity: row.severity,
    confidence: row.confidence,
    title: row.title,
    filePath: row.filePath,
    lineNumber: row.lineNumber,
    description: row.description,
    ...(row.impact ? { impact: row.impact } : {}),
    ...(row.recommendation ? { recommendation: row.recommendation } : {}),
    ...(row.guideline ? { guideline: row.guideline } : {}),
    ...(row.evidence ? { evidence: row.evidence } : {}),
    verified: row.verified,
    status: row.status,
    reopened,
  };
}

// ---------------------------------------------------------------------------
// Persistence pipeline
// ---------------------------------------------------------------------------

export async function persistReviewFindings(input: PersistReviewFindingsInput): Promise<PersistReviewFindingsResult> {
  const { config, reviewId, repositoryId, repositoryFullName, workspacePath, logger } = input;
  const dependencies = input.dependencies;

  // 1+2. Fingerprint everything, then validate/verify against the workspace.
  const candidates = [...input.findings, ...input.uncertainFindings].map((finding) => ({
    finding,
    fingerprint: computeFindingFingerprint(finding, repositoryFullName),
  }));
  const outcome = await validateFindings(workspacePath, candidates, config);

  // 3. Dedupe within the review by fingerprint (keep the highest-confidence
  //    occurrence; the durable unique constraint requires exactly one row per
  //    fingerprint per review).
  const byFingerprint = new Map<string, { finding: Finding; fingerprint: string; verified: boolean }>();
  for (const entry of [...outcome.verified, ...outcome.uncertain]) {
    const existing = byFingerprint.get(entry.fingerprint);
    if (!existing || entry.finding.confidence > existing.finding.confidence) {
      byFingerprint.set(entry.fingerprint, {
        finding: entry.finding,
        fingerprint: entry.fingerprint,
        verified: entry.verified,
      });
    }
  }

  const result: PersistReviewFindingsResult = {
    stored: [],
    rejected: outcome.rejected.map((r) => ({ title: r.finding.title, reason: r.reason, detail: r.detail })),
    transitions: 0,
    resolved: [],
  };
  if (byFingerprint.size === 0) {
    logger?.info({ reviewId, stored: 0, rejected: result.rejected.length }, "No valid findings to persist");
  }

  // 4. Historical comparison (same repository + fingerprint, prior reviews).
  const trackHistory = config.review.findings.trackAcrossCommits && config.review.findings.lifecycleManagement;
  const priors = trackHistory
    ? await loadPriorFindings(dependencies.repositories, repositoryId, reviewId)
    : new Map<string, PriorFindingRecord>();

  interface Planned {
    finding: Finding;
    fingerprint: string;
    verified: boolean;
    status: ActiveFindingStatus;
    reopenedFromId: string | null;
    priorStatusForTransition: string | null;
  }
  const planned: Planned[] = [];
  const seenFingerprints = new Set<string>();

  for (const entry of byFingerprint.values()) {
    seenFingerprints.add(entry.fingerprint);
    if (!entry.verified) {
      // 5. Uncertain classification: never merged into the verified history.
      planned.push({ ...entry, status: "uncertain", reopenedFromId: null, priorStatusForTransition: null });
      continue;
    }
    const prior = priors.get(entry.fingerprint);
    if (!prior) {
      planned.push({ ...entry, status: "new", reopenedFromId: null, priorStatusForTransition: null });
      continue;
    }
    if (prior.status === "resolved") {
      // Reintroduced after being fixed: a new occurrence that reopens the
      // resolved history (persisted via the reopen link + transition reason).
      planned.push({ ...entry, status: "new", reopenedFromId: prior.id, priorStatusForTransition: "resolved" });
      continue;
    }
    if (prior.status === "dismissed" || prior.status === "superseded") {
      planned.push({ ...entry, status: "new", reopenedFromId: null, priorStatusForTransition: null });
      continue;
    }
    if (prior.status === "uncertain") {
      // Previously unconfirmed, now verified with anchored evidence.
      planned.push({ ...entry, status: "new", reopenedFromId: null, priorStatusForTransition: "uncertain" });
      continue;
    }
    planned.push({
      ...entry,
      status: materiallyChanged(entry.finding, prior) ? "updated" : "existing",
      reopenedFromId: null,
      priorStatusForTransition: prior.status,
    });
  }

  // 6. Historical findings not observed in this review are resolved (§7.2).
  const resolvedPriors: PriorFindingRecord[] = trackHistory
    ? [...priors.values()].filter(
        (p) => isActiveFindingStatus(p.status) && !seenFingerprints.has(p.fingerprint) && p.status !== "uncertain",
      )
    : [];
  // Uncertain priors that were never confirmed stay open — they are neither
  // verified nor resolved; only supersede/dismiss touches them.

  // 7. Persist rows + transitions in one transaction.
  await dependencies.unitOfWork.execute(async (repositories) => {
    for (const item of planned) {
      const row = await repositories.findings.create({
        reviewId,
        repositoryId,
        fingerprint: item.fingerprint,
        category: item.finding.category,
        severity: item.finding.severity,
        confidence: item.finding.confidence,
        title: item.finding.title,
        filePath: item.finding.file,
        lineNumber: item.finding.line,
        description: item.finding.description,
        impact: item.finding.impact ?? null,
        recommendation: item.finding.recommendation ?? null,
        guideline: item.finding.guideline ?? null,
        evidence: item.finding.evidence,
        verified: item.verified,
        status: item.status,
        reopenedFromFindingId: item.reopenedFromId,
      });
      result.stored.push(mapStoredFinding(row, item.reopenedFromId !== null));
      await repositories.statusTransitions.create({
        findingId: row.id,
        reviewId,
        fromStatus: null,
        toStatus: item.status,
        reason: item.reopenedFromId
          ? `reopened: reintroduced after resolution of ${item.reopenedFromId}`
          : item.priorStatusForTransition
            ? `promoted from prior ${item.priorStatusForTransition} occurrence`
            : "recorded by review",
      });
      result.transitions += 1;
    }

    for (const prior of resolvedPriors) {
      await repositories.findings.markResolved({ findingId: prior.id, resolvedAt: new Date() });
      await repositories.statusTransitions.create({
        findingId: prior.id,
        reviewId,
        fromStatus: prior.status,
        toStatus: "resolved",
        reason: "not observed in the latest reviewed commit",
      });
      result.transitions += 1;
      result.resolved.push(prior.fingerprint);
    }
  });

  logger?.info(
    {
      reviewId,
      stored: result.stored.length,
      uncertain: result.stored.filter((s) => s.status === "uncertain").length,
      rejected: result.rejected.length,
      resolved: result.resolved.length,
      transitions: result.transitions,
    },
    "Findings persisted with lifecycle statuses",
  );
  return result;
}

// ---------------------------------------------------------------------------
// Supersession + queries (ticket 03 / ticket 09 surface)
// ---------------------------------------------------------------------------

/**
 * When a review is superseded by a newer commit (ticket 03), its active
 * findings never reach publication: they transition to `superseded`.
 */
export async function supersedeFindingsForReview(
  reviewId: string,
  supersededByReviewId: string,
  dependencies: FindingsServiceDependencies,
): Promise<number> {
  return dependencies.unitOfWork.execute(async (repositories) => {
    const active = await repositories.findings.findActiveByReview({
      reviewId,
      statuses: ACTIVE_FINDING_STATUSES,
    });
    for (const finding of active) {
      await repositories.findings.markSuperseded({ findingId: finding.id, supersededByReviewId });
      await repositories.statusTransitions.create({
        findingId: finding.id,
        reviewId,
        fromStatus: finding.status,
        toStatus: "superseded",
        reason: `review superseded by ${supersededByReviewId}`,
      });
    }
    return active.length;
  });
}

/** All persisted findings for one review, for the publishing layer (ticket 09). */
export async function getFindingsForReview(
  reviewId: string,
  dependencies: FindingsServiceDependencies,
): Promise<FindingRecord[]> {
  return dependencies.repositories.findings.findByReview(reviewId);
}
