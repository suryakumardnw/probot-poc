/**
 * Trusted instruction profiles for the review modes (§4.1):
 *
 * | mode     | profile composition                                        |
 * |----------|------------------------------------------------------------|
 * | standard | COMMON_REVIEW_INSTRUCTIONS (default flow, unchanged)        |
 * | skill    | retired — the code-review playbook is no longer authoritative|
 * | handbook | common + HANDBOOK_MODE_INSTRUCTIONS (+ guidelines)          |
 *
 * One engine, one authoritative standard: the engineering handbook. Review
 * types only decide whether guidelines are injected around the SAME staged
 * engine run; the guideline content itself is always untrusted data.
 */
export { COMMON_REVIEW_INSTRUCTIONS, CONVENTIONS_INSTRUCTIONS } from "./common.js";
export {
  HANDBOOK_MODE_INSTRUCTIONS,
  HANDBOOK_REFERENCE_INSTRUCTIONS,
} from "./handbook-review.js";
