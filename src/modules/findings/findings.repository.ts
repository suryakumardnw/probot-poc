import type { FindingEvidence } from "../../review-engine/index.js";

/**
 * Finding persistence ports and domain records (ARCHITECTURE.md §6.3, §7.2,
 * §7.3, §13.1).
 *
 * The repository owns the only Prisma interaction in this module. The service
 * speaks the records below — plain values with string-literal lifecycles — so a
 * Prisma row shape never leaks into lifecycle logic.
 */

// ---------------------------------------------------------------------------
// Domain enumerations (mirror the Prisma enum without importing it)
// ---------------------------------------------------------------------------

export const FINDING_LIFECYCLE_STATUSES = [
  "new",
  "existing",
  "updated",
  "resolved",
  "dismissed",
  "uncertain",
  "superseded",
] as const;
export type FindingLifecycleStatus = (typeof FINDING_LIFECYCLE_STATUSES)[number];

/** Lifecycle statuses describing an issue that is (or may be) present. */
export const ACTIVE_FINDING_STATUSES = ["new", "existing", "updated", "uncertain"] as const;
export type ActiveFindingStatus = (typeof ACTIVE_FINDING_STATUSES)[number];

export function isActiveFindingStatus(status: FindingLifecycleStatus): status is ActiveFindingStatus {
  return ACTIVE_FINDING_STATUSES.some((active) => active === status);
}

// ---------------------------------------------------------------------------
// Domain records
// ---------------------------------------------------------------------------

export type FindingRecord = {
  id: string;
  reviewId: string;
  repositoryId: string;
  fingerprint: string;
  category: string;
  severity: string;
  confidence: number;
  title: string;
  filePath: string;
  lineNumber: number;
  description: string;
  impact: string | null;
  recommendation: string | null;
  guideline: string | null;
  evidence: FindingEvidence[];
  verified: boolean;
  status: FindingLifecycleStatus;
  reopenedFromFindingId: string | null;
  supersededByReviewId: string | null;
  resolvedAt: Date | null;
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

/** A newly persisted occurrence always starts in an active status. */
export type CreatedFindingRecord = FindingRecord & { status: ActiveFindingStatus };

/**
 * The fields lifecycle comparison needs from a previous occurrence, newest
 * first. Evidence and presentation fields are deliberately excluded.
 */
export type PriorFindingRecord = {
  id: string;
  fingerprint: string;
  status: FindingLifecycleStatus;
  severity: string;
  lineNumber: number;
  createdAt: Date;
};

/** Minimal projection for status-only transitions (resolve/supersede). */
export type FindingStatusRecord = {
  id: string;
  status: ActiveFindingStatus;
};

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export type FindPriorFindingsInput = {
  repositoryId: string;
  /** The current review's occurrences are not part of its own history. */
  excludeReviewId: string;
};

export type FindActiveFindingsInput = {
  reviewId: string;
  statuses: readonly ActiveFindingStatus[];
};

export type CreateFindingInput = {
  reviewId: string;
  repositoryId: string;
  fingerprint: string;
  category: string;
  severity: string;
  confidence: number;
  title: string;
  filePath: string;
  lineNumber: number;
  description: string;
  impact: string | null;
  recommendation: string | null;
  guideline: string | null;
  evidence: readonly FindingEvidence[];
  verified: boolean;
  status: ActiveFindingStatus;
  /** Set when a previously resolved issue was reintroduced. */
  reopenedFromFindingId: string | null;
};

export type MarkFindingResolvedInput = {
  findingId: string;
  resolvedAt: Date;
};

export type MarkFindingSupersededInput = {
  findingId: string;
  supersededByReviewId: string;
};

export type CreateFindingStatusTransitionInput = {
  findingId: string;
  reviewId: string | null;
  fromStatus: FindingLifecycleStatus | null;
  toStatus: FindingLifecycleStatus;
  reason: string | null;
};

// ---------------------------------------------------------------------------
// Repository ports
// ---------------------------------------------------------------------------

export interface FindingRepository {
  /** All prior occurrences for one repository, newest first. */
  findPriorOccurrences(input: FindPriorFindingsInput): Promise<PriorFindingRecord[]>;
  findActiveByReview(input: FindActiveFindingsInput): Promise<FindingStatusRecord[]>;
  findByReview(reviewId: string): Promise<FindingRecord[]>;
  create(input: CreateFindingInput): Promise<CreatedFindingRecord>;
  markResolved(input: MarkFindingResolvedInput): Promise<void>;
  markSuperseded(input: MarkFindingSupersededInput): Promise<void>;
}

export interface FindingStatusTransitionRepository {
  create(input: CreateFindingStatusTransitionInput): Promise<void>;
}
