import { z } from "zod";
import { errorEnvelopeSchema } from "./errors.js";
import { REVIEW_TRIGGERS, REVIEW_TYPES, ingestOutcomeSchema } from "./queue.js";

/**
 * Admin HTTP API contracts (`/api/admin/*`).
 *
 * Every request body and typed query is parsed at the route boundary, and every
 * success response is parsed against the schema for its route. The error
 * envelope is shared with the rest of the HTTP surface so a client sees one
 * failure shape: `{ code, message, statusCode, details? }`.
 *
 * This module is a wire contract only. It imports Zod and sibling contract
 * modules; it never imports Prisma, the admin implementation, or configuration
 * loaders.
 */

/**
 * The one error envelope for every admin failure response. It is the shared
 * envelope, made strict so an ad-hoc key (`error`, `reason`, `stack`, ...)
 * cannot ride along unnoticed.
 */
export const adminErrorEnvelopeSchema = errorEnvelopeSchema.strict();
export type AdminErrorEnvelope = z.infer<typeof adminErrorEnvelopeSchema>;

/**
 * Review lifecycle states shown by the admin endpoints.
 * Mirrors the Prisma `ReviewState` enum; the contract test pins that mirror.
 */
export const ADMIN_REVIEW_STATES = [
  "queued",
  "preparing",
  "cloning",
  "analyzing",
  "investigating",
  "validating",
  "publishing",
  "completed",
  "completed_with_warnings",
  "failed",
  "cancelled",
  "superseded",
] as const;
export type AdminReviewState = (typeof ADMIN_REVIEW_STATES)[number];

/** Job statuses shown by the review-status endpoint. Mirrors Prisma `JobStatus`. */
export const ADMIN_JOB_STATUSES = [
  "pending_outbox",
  "enqueued",
  "processing",
  "completed",
  "failed",
  "superseded",
] as const;
export type AdminJobStatus = (typeof ADMIN_JOB_STATUSES)[number];

/** How the authenticated admin was authorized. */
export const ADMIN_ROLE_POLICIES = ["allowlist", "org-role"] as const;
export type AdminRolePolicy = (typeof ADMIN_ROLE_POLICIES)[number];

const reviewStateSchema = z.enum(ADMIN_REVIEW_STATES);
const jobStatusSchema = z.enum(ADMIN_JOB_STATUSES);
const reviewTriggerSchema = z.enum(REVIEW_TRIGGERS);
const reviewTypeSchema = z.enum(REVIEW_TYPES);
const rolePolicySchema = z.enum(ADMIN_ROLE_POLICIES);
const isoTimestampSchema = z.iso.datetime();

const repositoryFullNameSchema = z.string().regex(/^[^/\s]+\/[^/\s]+$/, "must be 'owner/repo'");
const pullRequestNumberSchema = z.number().int().min(1).max(1_000_000);

/**
 * A base-10 integer query parameter. Query strings are text, so the boundary
 * parses the digits before anything downstream sees a number.
 */
const queryIntegerSchema = (minimum: number, maximum: number) =>
  z
    .string()
    .regex(/^\d+$/, "must be an integer")
    .transform((value) => Number(value))
    .pipe(z.number().int().min(minimum).max(maximum));

/** A configuration document. Deep validation stays with the config loader. */
export const configObjectSchema = z.record(z.string(), z.unknown());
export type ConfigObject = z.infer<typeof configObjectSchema>;

// ---------------------------------------------------------------------------
// Request bodies and typed queries
// ---------------------------------------------------------------------------

/** POST /api/admin/reviews/trigger */
export const triggerReviewBodySchema = z.object({
  repository: repositoryFullNameSchema,
  pullRequestNumber: pullRequestNumberSchema,
  /** Which review methodology runs; defaults to github.defaultReviewType. */
  reviewType: reviewTypeSchema.optional(),
});
export type TriggerReviewBody = z.infer<typeof triggerReviewBodySchema>;

/** GET /api/admin/reviews/compare?repository=owner/repo&pr=123 */
export const compareQuerySchema = z.object({
  repository: repositoryFullNameSchema,
  pr: queryIntegerSchema(1, 1_000_000),
});
export type CompareQuery = z.infer<typeof compareQuerySchema>;

/**
 * GET /api/admin/auth/github/callback. The one-time OAuth state store is the
 * real validator; the schema pins the wire shape. Presence is checked after
 * parsing so an invalid state is reported before a missing code, preserving
 * the existing callback error order.
 */
export const oauthCallbackQuerySchema = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
});
export type OAuthCallbackQuery = z.infer<typeof oauthCallbackQuerySchema>;

/** GET /api/admin/reviews?state=...&limit=...&offset=... */
export const reviewListQuerySchema = z.object({
  state: reviewStateSchema.optional(),
  limit: queryIntegerSchema(1, 100).optional(),
  offset: queryIntegerSchema(0, Number.MAX_SAFE_INTEGER).optional(),
});
export type ReviewListQuery = z.infer<typeof reviewListQuerySchema>;

/**
 * PUT /api/admin/config and the validate/dry-run candidates. The loader owns
 * the deep schema; the route only rejects bodies that are not JSON objects.
 */
export const configUpdateBodySchema = configObjectSchema;
export type ConfigUpdateBody = z.infer<typeof configUpdateBodySchema>;

// ---------------------------------------------------------------------------
// Authentication and session responses
// ---------------------------------------------------------------------------

export const sessionUserSchema = z.object({
  login: z.string().min(1),
  id: z.number().int(),
});
export type SessionUser = z.infer<typeof sessionUserSchema>;

/** GET /api/admin/auth/github/callback */
export const loginResponseSchema = z.object({
  authenticated: z.literal(true),
  user: sessionUserSchema,
  rolePolicy: rolePolicySchema,
  csrfToken: z.string().min(1),
});
export type LoginResponse = z.infer<typeof loginResponseSchema>;

/** GET /api/admin/session */
export const sessionResponseSchema = loginResponseSchema.extend({
  expiresAt: isoTimestampSchema,
});
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

/** POST /api/admin/auth/logout */
export const logoutResponseSchema = z.object({
  ok: z.literal(true),
});
export type LogoutResponse = z.infer<typeof logoutResponseSchema>;

// ---------------------------------------------------------------------------
// Configuration responses
// ---------------------------------------------------------------------------

/** GET /api/admin/config */
export const configReadResponseSchema = z.object({
  fromLastKnownGood: z.boolean(),
  hash: z.string().min(1),
  schemaVersion: z.number().int(),
  configuration: configObjectSchema,
});
export type ConfigReadResponse = z.infer<typeof configReadResponseSchema>;

/**
 * POST /api/admin/config/validate. A rejected candidate is still a successful
 * validation request (HTTP 200); the response says `valid: false` and carries
 * the safe loader message.
 */
export const configValidateResponseSchema = z.discriminatedUnion("valid", [
  z.object({
    valid: z.literal(true),
    hash: z.string().min(1),
    configuration: configObjectSchema,
  }),
  z.object({
    valid: z.literal(false),
    error: z.string().min(1),
  }),
]);
export type ConfigValidateResponse = z.infer<typeof configValidateResponseSchema>;

/** POST /api/admin/config/dry-run */
export const configDryRunResponseSchema = z.discriminatedUnion("valid", [
  z.object({
    valid: z.literal(true),
    hash: z.string().min(1),
    schemaVersion: z.number().int(),
    configuration: configObjectSchema,
    applied: z.literal(false),
  }),
  z.object({
    valid: z.literal(false),
    applied: z.literal(false),
    error: z.string().min(1),
  }),
]);
export type ConfigDryRunResponse = z.infer<typeof configDryRunResponseSchema>;

/** PUT /api/admin/config */
export const configUpdateResponseSchema = z.object({
  updated: z.literal(true),
  previousHash: z.string().min(1),
  hash: z.string().min(1),
  configuration: configObjectSchema,
});
export type ConfigUpdateResponse = z.infer<typeof configUpdateResponseSchema>;

/** POST /api/admin/config/reload */
export const configReloadResponseSchema = z.object({
  reloaded: z.literal(true),
  fromLastKnownGood: z.boolean(),
  hash: z.string().min(1),
  configuration: configObjectSchema,
});
export type ConfigReloadResponse = z.infer<typeof configReloadResponseSchema>;

/** POST /api/admin/config/rollback */
export const configRollbackResponseSchema = z.object({
  rolledBack: z.literal(true),
  hash: z.string().min(1),
  configuration: configObjectSchema,
});
export type ConfigRollbackResponse = z.infer<typeof configRollbackResponseSchema>;

// ---------------------------------------------------------------------------
// Review responses
// ---------------------------------------------------------------------------

/** One row of GET /api/admin/reviews. */
export const reviewListItemSchema = z.object({
  id: z.string().min(1),
  state: reviewStateSchema,
  repository: z.string().min(1),
  pullRequestNumber: pullRequestNumberSchema,
  pullRequestId: z.string().min(1),
  headSha: z.string().min(1),
  reviewMode: z.string().min(1),
  trigger: reviewTriggerSchema,
  provider: z.string().nullable(),
  model: z.string().nullable(),
  startedAt: isoTimestampSchema.nullable(),
  completedAt: isoTimestampSchema.nullable(),
  errorCode: z.string().nullable(),
  createdAt: isoTimestampSchema,
});
export type ReviewListItem = z.infer<typeof reviewListItemSchema>;

/** GET /api/admin/reviews */
export const reviewListResponseSchema = z.object({
  total: z.number().int().min(0),
  limit: z.number().int().min(1).max(100),
  offset: z.number().int().min(0),
  reviews: z.array(reviewListItemSchema),
});
export type ReviewListResponse = z.infer<typeof reviewListResponseSchema>;

/** GET /api/admin/reviews/:id */
export const reviewStatusResponseSchema = z.object({
  review: z.object({
    id: z.string().min(1),
    state: reviewStateSchema,
    trigger: reviewTriggerSchema,
    reviewMode: z.string().min(1),
    headSha: z.string().min(1),
    configurationHash: z.string().nullable(),
    createdAt: isoTimestampSchema,
    completedAt: isoTimestampSchema.nullable(),
    errorCode: z.string().nullable(),
  }),
  job: z
    .object({
      id: z.string().min(1),
      status: jobStatusSchema,
      attempts: z.number().int().min(0),
      lastError: z.string().nullable(),
      queueJobId: z.string().nullable(),
      jobKey: z.string().min(1),
    })
    .nullable(),
  transitions: z.array(
    z.object({
      fromState: reviewStateSchema.nullable(),
      toState: reviewStateSchema,
      at: isoTimestampSchema,
    }),
  ),
});
export type ReviewStatusResponse = z.infer<typeof reviewStatusResponseSchema>;

/** POST /api/admin/reviews/trigger */
export const reviewTriggerResponseSchema = z.object({
  outcome: ingestOutcomeSchema,
  reason: z.string().optional(),
  reviewId: z.string().min(1).optional(),
  jobId: z.string().min(1).optional(),
  state: reviewStateSchema.optional(),
  attempt: z.number().int().min(0).optional(),
  reviewType: reviewTypeSchema,
});
export type ReviewTriggerResponse = z.infer<typeof reviewTriggerResponseSchema>;

const knowledgeSourceSummarySchema = z.object({
  ref: z.string(),
  contentHash: z.string(),
});

const knowledgeSnapshotSummarySchema = z
  .object({
    skill: knowledgeSourceSummarySchema.nullable(),
    handbook: knowledgeSourceSummarySchema.nullable(),
    handbookVariants: z
      .array(
        z.object({
          technologies: z.array(z.string()),
          ref: z.string(),
          contentHash: z.string(),
        }),
      )
      .optional(),
  })
  .nullable();

const knowledgeMetricsSummarySchema = z
  .object({
    source: z.enum(["skill", "handbook"]),
    injectedTokens: z.number(),
    documentsRetrieved: z.number(),
    candidates: z.number(),
    relevant: z.number(),
    selected: z.number(),
    truncated: z.boolean(),
  })
  .nullable();

/** One per-type row of GET /api/admin/reviews/compare. */
export const reviewComparisonRowSchema = z.object({
  id: z.string().min(1),
  reviewType: reviewTypeSchema,
  reviewMode: z.string().min(1),
  state: reviewStateSchema,
  attempt: z.number().int().min(0),
  trigger: reviewTriggerSchema,
  headSha: z.string().min(1),
  createdAt: isoTimestampSchema,
  startedAt: isoTimestampSchema.nullable(),
  completedAt: isoTimestampSchema.nullable(),
  durationMs: z.number().int().nullable(),
  publishSkipped: z.boolean(),
  findingCount: z.number().int().min(0),
  severityCounts: z.record(z.string(), z.number().int().min(0)),
  uniqueFindings: z.number().int().min(0),
  inputTokens: z.number().int().nullable(),
  outputTokens: z.number().int().nullable(),
  knowledgeSnapshot: knowledgeSnapshotSummarySchema,
  knowledgeMetrics: knowledgeMetricsSummarySchema,
  errorCode: z.string().nullable(),
});
export type ReviewComparisonRow = z.infer<typeof reviewComparisonRowSchema>;

/** GET /api/admin/reviews/compare */
export const compareReviewsResponseSchema = z.object({
  repository: repositoryFullNameSchema,
  pullRequestNumber: pullRequestNumberSchema,
  headShas: z.array(z.string().min(1)),
  reviews: z.array(reviewComparisonRowSchema),
});
export type CompareReviewsResponse = z.infer<typeof compareReviewsResponseSchema>;
