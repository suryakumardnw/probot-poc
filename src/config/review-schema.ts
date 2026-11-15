/**
 * Compatibility re-export for the review configuration contract.
 *
 * The schema and inferred type moved to `src/contracts/config.ts` in PR 1.5.
 * This module stays until Phase 3 so existing imports keep working; it must
 * never grow its own copy of the schema.
 */

export {
  CURRENT_SCHEMA_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
  reviewConfigSchema,
  type ReviewConfig,
} from "../contracts/config.js";
