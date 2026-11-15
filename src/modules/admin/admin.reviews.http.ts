import {
  compareQuerySchema,
  compareReviewsResponseSchema,
  reviewListQuerySchema,
  reviewListResponseSchema,
  reviewStatusResponseSchema,
  reviewTriggerResponseSchema,
  triggerReviewBodySchema,
} from "../../contracts/admin.js";
import { ERROR_CODES } from "../../contracts/errors.js";
import { NotFoundError } from "../../shared/errors/index.js";
import { ManualIngestionError } from "../ingestion/index.js";
import { parseQuery, readJsonBody, sendError, sendJson, sendValidationFailure } from "./admin.http.helpers.js";
import type { AdminService } from "./admin.service.js";
import type { AdminRequestContext } from "./admin.types.js";
import type { AdminSession } from "./auth/session.js";

export async function handleListReviews(ctx: AdminRequestContext, service: AdminService): Promise<void> {
  const query = parseQuery(reviewListQuerySchema, ctx.url);
  if (!query.success) {
    sendValidationFailure(ctx.res, query.error);
    return;
  }
  sendJson(ctx.res, 200, reviewListResponseSchema, await service.listReviews(query.data));
}

export async function handleReviewDetail(
  ctx: AdminRequestContext,
  service: AdminService,
  reviewId: string,
): Promise<void> {
  sendJson(ctx.res, 200, reviewStatusResponseSchema, await service.getReviewDetail(reviewId));
}

/** POST /api/admin/reviews/trigger — manual ingestion for one review type. */
export async function handleTriggerReview(
  ctx: AdminRequestContext,
  service: AdminService,
  session: AdminSession,
): Promise<void> {
  const parsed = triggerReviewBodySchema.safeParse(await readJsonBody(ctx.req));
  if (!parsed.success) {
    sendValidationFailure(ctx.res, parsed.error);
    return;
  }
  try {
    const result = await service.triggerReview(parsed.data, session.login);
    sendJson(ctx.res, result.outcome === "created" ? 202 : 200, reviewTriggerResponseSchema, result);
  } catch (error) {
    if (error instanceof ManualIngestionError) {
      sendError(ctx.res, new NotFoundError(error.message, { code: ERROR_CODES.REVIEW_TARGET_NOT_FOUND }));
      return;
    }
    throw error;
  }
}

export async function handleCompareReviews(ctx: AdminRequestContext, service: AdminService): Promise<void> {
  const query = parseQuery(compareQuerySchema, ctx.url);
  if (!query.success) {
    sendValidationFailure(ctx.res, query.error);
    return;
  }
  sendJson(ctx.res, 200, compareReviewsResponseSchema, await service.compareReviews(query.data));
}
