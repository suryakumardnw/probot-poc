import {
  createAdminConfigService,
  type AdminConfigService,
  type AdminConfigServiceDeps,
} from "./admin.config.service.js";
import {
  createAdminReviewService,
  type AdminReviewService,
  type AdminReviewServiceDeps,
  type ReviewDetailPayload,
} from "./admin.reviews.service.js";

/**
 * Admin use-case composition (ARCHITECTURE.md §14.2, §15).
 *
 * Configuration and review operations stay in separate services; this barrel
 * bundles them for the HTTP layer. The HTTP handlers own request parsing,
 * status codes and error envelopes.
 */

export type AdminServiceDeps = AdminConfigServiceDeps & AdminReviewServiceDeps;

export interface AdminService extends AdminConfigService, AdminReviewService {}

export function createAdminService(deps: AdminServiceDeps): AdminService {
  return {
    ...createAdminConfigService(deps),
    ...createAdminReviewService(deps),
  };
}

export type {
  AdminConfigService,
  AdminConfigServiceDeps,
  AdminReviewService,
  AdminReviewServiceDeps,
  ReviewDetailPayload,
};
