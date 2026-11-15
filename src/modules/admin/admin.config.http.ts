import {
  configDryRunResponseSchema,
  configReadResponseSchema,
  configReloadResponseSchema,
  configRollbackResponseSchema,
  configUpdateBodySchema,
  configUpdateResponseSchema,
  configValidateResponseSchema,
} from "../../contracts/admin.js";
import { ERROR_CODES } from "../../contracts/errors.js";
import { ConfigValidationError } from "../../ports/review-config.js";
import { ValidationError } from "../../shared/errors/index.js";
import { readJsonBody, sendError, sendJson, sendValidationFailure } from "./admin.http.helpers.js";
import type { AdminService } from "./admin.service.js";
import type { AdminRequestContext } from "./admin.types.js";
import type { AdminSession } from "./auth/session.js";

export async function handleReadConfig(ctx: AdminRequestContext, service: AdminService): Promise<void> {
  sendJson(ctx.res, 200, configReadResponseSchema, service.readConfig());
}

export async function handleValidateConfig(ctx: AdminRequestContext, service: AdminService): Promise<void> {
  const parsed = configUpdateBodySchema.safeParse(await readJsonBody(ctx.req));
  if (!parsed.success) {
    sendValidationFailure(ctx.res, parsed.error);
    return;
  }
  sendJson(ctx.res, 200, configValidateResponseSchema, service.validateConfig(parsed.data));
}

export async function handleDryRunConfig(ctx: AdminRequestContext, service: AdminService): Promise<void> {
  const parsed = configUpdateBodySchema.safeParse(await readJsonBody(ctx.req));
  if (!parsed.success) {
    sendValidationFailure(ctx.res, parsed.error);
    return;
  }
  sendJson(ctx.res, 200, configDryRunResponseSchema, service.dryRunConfig(parsed.data));
}

export async function handleUpdateConfig(
  ctx: AdminRequestContext,
  service: AdminService,
  session: AdminSession,
): Promise<void> {
  const parsed = configUpdateBodySchema.safeParse(await readJsonBody(ctx.req));
  if (!parsed.success) {
    sendValidationFailure(ctx.res, parsed.error);
    return;
  }
  try {
    sendJson(ctx.res, 200, configUpdateResponseSchema, await service.updateConfig(parsed.data, session.login));
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      sendError(ctx.res, new ValidationError(error.message, { code: ERROR_CODES.CONFIG_INVALID }));
      return;
    }
    throw error;
  }
}

export async function handleReloadConfig(
  ctx: AdminRequestContext,
  service: AdminService,
  session: AdminSession,
): Promise<void> {
  sendJson(ctx.res, 200, configReloadResponseSchema, await service.reloadConfig(session.login));
}

export async function handleRollbackConfig(
  ctx: AdminRequestContext,
  service: AdminService,
  session: AdminSession,
): Promise<void> {
  sendJson(ctx.res, 200, configRollbackResponseSchema, await service.rollbackConfig(session.login));
}
