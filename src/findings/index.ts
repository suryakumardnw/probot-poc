/**
 * Finding validation, verification, fingerprinting, persistence and lifecycle
 * management (ticket 08). Public surface used by the review pipeline and the
 * publishing layer (ticket 09).
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
