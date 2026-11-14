import { describe, expect, test } from "vitest";
import {
  ADMIN_JOB_STATUSES,
  ADMIN_REVIEW_STATES,
  adminErrorEnvelopeSchema,
  compareQuerySchema,
  compareReviewsResponseSchema,
  configDryRunResponseSchema,
  configUpdateBodySchema,
  configValidateResponseSchema,
  oauthCallbackQuerySchema,
  reviewListQuerySchema,
  reviewListResponseSchema,
  reviewStatusResponseSchema,
  reviewTriggerResponseSchema,
  triggerReviewBodySchema,
} from "./admin.js";

const validReviewStatus = {
  review: {
    id: "review-1",
    state: "completed",
    trigger: "manual",
    reviewMode: "adaptive",
    headSha: "a".repeat(40),
    configurationHash: "sha256:abc123",
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:05:00.000Z",
    errorCode: null,
  },
  job: {
    id: "job-1",
    status: "completed",
    attempts: 1,
    lastError: null,
    queueJobId: "queue-1",
    jobKey: "job-key-1",
  },
  transitions: [
    { fromState: null, toState: "queued", at: "2026-01-01T00:00:00.000Z" },
    { fromState: "queued", toState: "completed", at: "2026-01-01T00:05:00.000Z" },
  ],
} as const;

describe("adminErrorEnvelopeSchema", () => {
  test("accepts the shared error envelope with and without details", () => {
    const withoutDetails = {
      code: "ADMIN_INVALID_REQUEST",
      message: "invalid request",
      statusCode: 400,
    };
    expect(adminErrorEnvelopeSchema.parse(withoutDetails)).toEqual(withoutDetails);

    const withDetails = {
      code: "REVIEW_TYPE_DISABLED",
      message: "review type 'skill' is disabled",
      statusCode: 409,
      details: { reviewType: "skill" },
    };
    expect(adminErrorEnvelopeSchema.parse(withDetails)).toEqual(withDetails);
  });

  test("rejects a lowercase code, an out-of-range status and ad-hoc keys", () => {
    expect(adminErrorEnvelopeSchema.safeParse({ code: "not_found", message: "missing", statusCode: 404 }).success).toBe(
      false,
    );
    expect(adminErrorEnvelopeSchema.safeParse({ code: "NOT_FOUND", message: "missing", statusCode: 200 }).success).toBe(
      false,
    );
    expect(
      adminErrorEnvelopeSchema.safeParse({
        code: "NOT_FOUND",
        message: "missing",
        statusCode: 404,
        error: "missing",
      }).success,
    ).toBe(false);
  });
});

describe("triggerReviewBodySchema", () => {
  test("accepts a body with and without a review type", () => {
    expect(triggerReviewBodySchema.parse({ repository: "octo-org/widget", pullRequestNumber: 7 })).toEqual({
      repository: "octo-org/widget",
      pullRequestNumber: 7,
    });
    expect(
      triggerReviewBodySchema.parse({
        repository: "octo-org/widget",
        pullRequestNumber: 7,
        reviewType: "handbook",
      }),
    ).toEqual({ repository: "octo-org/widget", pullRequestNumber: 7, reviewType: "handbook" });
  });

  test("rejects a malformed repository, a non-positive PR and an unknown review type", () => {
    expect(triggerReviewBodySchema.safeParse({ repository: "not-a-slug", pullRequestNumber: 7 }).success).toBe(false);
    expect(triggerReviewBodySchema.safeParse({ repository: "octo-org/widget", pullRequestNumber: 0 }).success).toBe(
      false,
    );
    expect(triggerReviewBodySchema.safeParse({ repository: "octo-org/widget", pullRequestNumber: 1.5 }).success).toBe(
      false,
    );
    expect(
      triggerReviewBodySchema.safeParse({
        repository: "octo-org/widget",
        pullRequestNumber: 7,
        reviewType: "legacy",
      }).success,
    ).toBe(false);
  });
});

describe("oauthCallbackQuerySchema", () => {
  test("accepts code and state, and accepts their absence for the route's presence checks", () => {
    expect(oauthCallbackQuerySchema.parse({ code: "abc", state: "xyz" })).toEqual({ code: "abc", state: "xyz" });
    expect(oauthCallbackQuerySchema.parse({})).toEqual({});
  });
});

describe("compareQuerySchema", () => {
  test("parses query text into the typed repository and PR number", () => {
    expect(compareQuerySchema.parse({ repository: "octo-org/widget", pr: "33" })).toEqual({
      repository: "octo-org/widget",
      pr: 33,
    });
  });

  test.each([
    ["missing repository", { pr: "1" }],
    ["missing pr", { repository: "octo-org/widget" }],
    ["malformed repository", { repository: "widget", pr: "1" }],
    ["non-numeric pr", { repository: "octo-org/widget", pr: "abc" }],
    ["zero pr", { repository: "octo-org/widget", pr: "0" }],
    ["fractional pr", { repository: "octo-org/widget", pr: "1.5" }],
    ["negative pr", { repository: "octo-org/widget", pr: "-1" }],
  ])("rejects %s", (_name, value) => {
    expect(compareQuerySchema.safeParse(value).success).toBe(false);
  });
});

describe("reviewListQuerySchema", () => {
  test("accepts an empty query and parses optional numbers", () => {
    expect(reviewListQuerySchema.parse({})).toEqual({});
    expect(reviewListQuerySchema.parse({ state: "failed", limit: "10", offset: "20" })).toEqual({
      state: "failed",
      limit: 10,
      offset: 20,
    });
  });

  test.each([
    ["unknown state", { state: "unknown" }],
    ["zero limit", { limit: "0" }],
    ["limit above the cap", { limit: "101" }],
    ["fractional limit", { limit: "10.5" }],
    ["negative offset", { offset: "-1" }],
  ])("rejects %s", (_name, value) => {
    expect(reviewListQuerySchema.safeParse(value).success).toBe(false);
  });
});

describe("configUpdateBodySchema", () => {
  test("accepts a JSON object and rejects non-object bodies", () => {
    expect(configUpdateBodySchema.parse({ schemaVersion: 1, review: { enabled: true } })).toEqual({
      schemaVersion: 1,
      review: { enabled: true },
    });
    expect(configUpdateBodySchema.safeParse([]).success).toBe(false);
    expect(configUpdateBodySchema.safeParse("configuration").success).toBe(false);
    expect(configUpdateBodySchema.safeParse(null).success).toBe(false);
  });
});

describe("config response schemas", () => {
  test("validate accepts both the valid and invalid branches", () => {
    expect(
      configValidateResponseSchema.parse({
        valid: true,
        hash: "sha256:abc",
        configuration: { schemaVersion: 1 },
      }),
    ).toMatchObject({ valid: true });
    expect(configValidateResponseSchema.parse({ valid: false, error: "Invalid review configuration" })).toEqual({
      valid: false,
      error: "Invalid review configuration",
    });
  });

  test("dry-run keeps the applied flag false on both branches", () => {
    expect(
      configDryRunResponseSchema.parse({
        valid: true,
        hash: "sha256:abc",
        schemaVersion: 1,
        configuration: { schemaVersion: 1 },
        applied: false,
      }),
    ).toMatchObject({ valid: true, applied: false });
    expect(
      configDryRunResponseSchema.parse({ valid: false, applied: false, error: "Invalid review configuration" }),
    ).toEqual({ valid: false, applied: false, error: "Invalid review configuration" });
  });
});

describe("reviewStatusResponseSchema", () => {
  test("accepts a full status report with a job and transitions", () => {
    const parsed = reviewStatusResponseSchema.parse(validReviewStatus);
    expect(parsed.review.state).toBe("completed");
    expect(parsed.job?.status).toBe("completed");
    expect(parsed.transitions).toHaveLength(2);
  });

  test("accepts a report without a job row", () => {
    expect(reviewStatusResponseSchema.parse({ ...validReviewStatus, job: null }).job).toBeNull();
  });

  test("rejects an unknown review state, job status or timestamp", () => {
    expect(
      reviewStatusResponseSchema.safeParse({
        ...validReviewStatus,
        review: { ...validReviewStatus.review, state: "unfinished" },
      }).success,
    ).toBe(false);
    expect(
      reviewStatusResponseSchema.safeParse({
        ...validReviewStatus,
        job: { ...validReviewStatus.job, status: "unknown" },
      }).success,
    ).toBe(false);
    expect(
      reviewStatusResponseSchema.safeParse({
        ...validReviewStatus,
        review: { ...validReviewStatus.review, createdAt: "yesterday" },
      }).success,
    ).toBe(false);
  });
});

describe("reviewListResponseSchema", () => {
  test("accepts a page of reviews", () => {
    const parsed = reviewListResponseSchema.parse({
      total: 1,
      limit: 20,
      offset: 0,
      reviews: [
        {
          id: "review-1",
          state: "queued",
          repository: "octo-org/widget",
          pullRequestNumber: 7,
          pullRequestId: "pr-1",
          headSha: "a".repeat(40),
          reviewMode: "adaptive",
          trigger: "opened",
          provider: "openai",
          model: "gpt",
          startedAt: null,
          completedAt: null,
          errorCode: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    expect(parsed.reviews[0]?.id).toBe("review-1");
  });

  test("rejects a page limit outside the route contract", () => {
    expect(reviewListResponseSchema.safeParse({ total: 0, limit: 101, offset: 0, reviews: [] }).success).toBe(false);
  });
});

describe("reviewTriggerResponseSchema", () => {
  test("accepts each ingestion outcome with the resolved review type", () => {
    expect(
      reviewTriggerResponseSchema.parse({
        outcome: "created",
        reviewId: "review-1",
        jobId: "job-1",
        reviewType: "handbook",
      }),
    ).toMatchObject({ outcome: "created", reviewType: "handbook" });
    expect(reviewTriggerResponseSchema.parse({ outcome: "skipped", reviewType: "standard" }).outcome).toBe("skipped");
  });

  test("rejects an outcome outside the ingestion contract", () => {
    expect(reviewTriggerResponseSchema.safeParse({ outcome: "queued", reviewType: "standard" }).success).toBe(false);
  });
});

describe("compareReviewsResponseSchema", () => {
  test("accepts a comparison with knowledge summaries and metrics", () => {
    const parsed = compareReviewsResponseSchema.parse({
      repository: "octo-org/widget",
      pullRequestNumber: 33,
      headShas: ["a".repeat(40)],
      reviews: [
        {
          id: "review-1",
          reviewType: "skill",
          reviewMode: "adaptive",
          state: "completed",
          attempt: 1,
          trigger: "manual",
          headSha: "a".repeat(40),
          createdAt: "2026-01-01T00:00:00.000Z",
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:05:00.000Z",
          durationMs: 300000,
          publishSkipped: true,
          findingCount: 2,
          severityCounts: { high: 1, critical: 1 },
          uniqueFindings: 1,
          inputTokens: 1000,
          outputTokens: 500,
          knowledgeSnapshot: {
            skill: { ref: "a".repeat(40), contentHash: "sha-skill" },
            handbook: null,
          },
          knowledgeMetrics: {
            source: "skill",
            injectedTokens: 1200,
            documentsRetrieved: 1,
            candidates: 2,
            relevant: 1,
            selected: 1,
            truncated: false,
          },
          errorCode: null,
        },
      ],
    });
    expect(parsed.reviews[0]?.knowledgeMetrics?.injectedTokens).toBe(1200);
  });

  test("rejects an unknown comparison review type", () => {
    expect(
      compareReviewsResponseSchema.safeParse({
        repository: "octo-org/widget",
        pullRequestNumber: 33,
        headShas: [],
        reviews: [
          {
            id: "review-1",
            reviewType: "legacy",
            reviewMode: "adaptive",
            state: "completed",
            attempt: 1,
            trigger: "manual",
            headSha: "a".repeat(40),
            createdAt: "2026-01-01T00:00:00.000Z",
            startedAt: null,
            completedAt: null,
            durationMs: null,
            publishSkipped: false,
            findingCount: 0,
            severityCounts: {},
            uniqueFindings: 0,
            inputTokens: null,
            outputTokens: null,
            knowledgeSnapshot: null,
            knowledgeMetrics: null,
            errorCode: null,
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("contract enum mirrors", () => {
  test("review states and job statuses list the full lifecycle", () => {
    expect(ADMIN_REVIEW_STATES).toEqual([
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
    ]);
    expect(ADMIN_JOB_STATUSES).toEqual([
      "pending_outbox",
      "enqueued",
      "processing",
      "completed",
      "failed",
      "superseded",
    ]);
  });
});
