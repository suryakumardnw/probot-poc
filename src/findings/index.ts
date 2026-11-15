/**
 * Finding validation, verification, fingerprinting, persistence and lifecycle
 * management (ticket 08). Public surface used by the review pipeline and the
 * publishing layer (ticket 09).
 *
 * Persistence is behind repository ports and the findings unit of work; the
 * service receives them and never touches Prisma.
 */

export { computeFindingFingerprint, normalizeTextSignature, normalizeCodeIdentity } from "./fingerprint.js";
export {
  FindingValidationError,
  validateFindings,
  type FindingRejectionReason,
  type FindingValidationOutcome,
  type VerifiedFinding,
} from "./validation.js";
export {
  persistReviewFindings,
  supersedeFindingsForReview,
  getFindingsForReview,
  type PersistReviewFindingsInput,
  type PersistReviewFindingsResult,
  type StoredFinding,
} from "./store.js";
export {
  ACTIVE_FINDING_STATUSES,
  FINDING_LIFECYCLE_STATUSES,
  isActiveFindingStatus,
  type ActiveFindingStatus,
  type CreateFindingInput,
  type CreateFindingStatusTransitionInput,
  type CreatedFindingRecord,
  type FindActiveFindingsInput,
  type FindPriorFindingsInput,
  type FindingLifecycleStatus,
  type FindingRecord,
  type FindingRepository,
  type FindingStatusRecord,
  type FindingStatusTransitionRepository,
  type MarkFindingResolvedInput,
  type MarkFindingSupersededInput,
  type PriorFindingRecord,
} from "./findings.repository.js";
export type { FindingsRepositories, FindingsUnitOfWork } from "./findings.unit-of-work.js";
export {
  createFindingsDependencies,
  createFindingsUnitOfWork,
  type FindingsServiceDependencies,
} from "./prisma-findings.unit-of-work.js";
