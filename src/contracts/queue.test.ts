import { describe, expect, test } from "vitest";
import {
  INGEST_OUTCOMES,
  ingestOutcomeSchema,
  outboxPayloadSchema,
  reviewJobPayloadSchema,
  type OutboxPayload,
  type ReviewJobPayload,
} from "./queue.js";

const validPayload = {
  reviewId: "review-1",
  jobKey: "42:99:7:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:adaptive:standard",
  githubInstallationId: "42",
  githubRepositoryId: "99",
  repositoryFullName: "octo-org/widget",
  pullRequestNumber: 7,
  headSha: "a".repeat(40),
  baseSha: "b".repeat(40),
  reviewMode: "adaptive",
  reviewType: "standard",
  trigger: "opened",
  configurationHash: "sha256:abc123",
} as const;

const requiredFields = [
  "reviewId",
  "jobKey",
  "githubInstallationId",
  "githubRepositoryId",
  "repositoryFullName",
  "pullRequestNumber",
  "headSha",
  "reviewMode",
  "reviewType",
  "trigger",
] as const;

function withoutField(field: (typeof requiredFields)[number]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(validPayload).filter(([key]) => key !== field));
}

describe("reviewJobPayloadSchema", () => {
  test("accepts a complete payload", () => {
    const parsed: ReviewJobPayload = reviewJobPayloadSchema.parse(validPayload);
    expect(parsed).toEqual(validPayload);
  });

  test("accepts the backward-compatible shape without baseSha and configurationHash", () => {
    const { baseSha: _baseSha, configurationHash: _configurationHash, ...minimal } = validPayload;
    const parsed = reviewJobPayloadSchema.parse(minimal);

    expect(parsed).toEqual(minimal);
    // Optional fields stay absent: the schema never invents a default value.
    expect("baseSha" in parsed).toBe(false);
    expect("configurationHash" in parsed).toBe(false);
  });

  test("accepts explicit nulls for the optional fields", () => {
    const parsed = reviewJobPayloadSchema.parse({ ...validPayload, baseSha: null, configurationHash: null });
    expect(parsed.baseSha).toBeNull();
    expect(parsed.configurationHash).toBeNull();
  });

  test.each(requiredFields)("rejects a payload missing %s", (field) => {
    expect(reviewJobPayloadSchema.safeParse(withoutField(field)).success).toBe(false);
  });

  test.each([
    ["pullRequestNumber as a string", { ...validPayload, pullRequestNumber: "7" }],
    ["pullRequestNumber as zero", { ...validPayload, pullRequestNumber: 0 }],
    ["pullRequestNumber as a fraction", { ...validPayload, pullRequestNumber: 7.5 }],
    ["githubInstallationId as a number", { ...validPayload, githubInstallationId: 42 }],
    ["githubRepositoryId as a number", { ...validPayload, githubRepositoryId: 99 }],
    ["headSha as a number", { ...validPayload, headSha: 1234 }],
    ["empty reviewId", { ...validPayload, reviewId: "" }],
    ["empty repositoryFullName", { ...validPayload, repositoryFullName: "" }],
    ["empty baseSha", { ...validPayload, baseSha: "" }],
    ["baseSha as a number", { ...validPayload, baseSha: 17 }],
    ["empty configurationHash", { ...validPayload, configurationHash: "" }],
  ])("rejects a wrong type or empty value: %s", (_name, candidate) => {
    expect(reviewJobPayloadSchema.safeParse(candidate).success).toBe(false);
  });

  test.each(["adaptive", "fixed"] as const)("accepts reviewMode %s", (reviewMode) => {
    expect(reviewJobPayloadSchema.safeParse({ ...validPayload, reviewMode }).success).toBe(true);
  });

  test.each(["standard", "skill", "handbook"] as const)("accepts reviewType %s", (reviewType) => {
    expect(reviewJobPayloadSchema.safeParse({ ...validPayload, reviewType }).success).toBe(true);
  });

  test.each(["opened", "synchronized", "ready_for_review", "manual"] as const)("accepts trigger %s", (trigger) => {
    expect(reviewJobPayloadSchema.safeParse({ ...validPayload, trigger }).success).toBe(true);
  });

  test.each([
    ["unknown reviewMode", { ...validPayload, reviewMode: "full" }],
    ["legacy reviewMode", { ...validPayload, reviewMode: "standard" }],
    ["unknown reviewType", { ...validPayload, reviewType: "security" }],
    ["invalid trigger", { ...validPayload, trigger: "synchronize" }],
    ["non-string trigger", { ...validPayload, trigger: 1 }],
  ])("rejects %s", (_name, candidate) => {
    expect(reviewJobPayloadSchema.safeParse(candidate).success).toBe(false);
  });
});

describe("outboxPayloadSchema", () => {
  test("accepts the current outbox shape, including reviewEnabled", () => {
    const parsed: OutboxPayload = outboxPayloadSchema.parse({ ...validPayload, reviewEnabled: true });
    expect(parsed).toEqual({ ...validPayload, reviewEnabled: true });
  });

  test("accepts an outbox payload without reviewEnabled", () => {
    expect(outboxPayloadSchema.safeParse(validPayload).success).toBe(true);
  });

  test("applies the queue payload rules", () => {
    expect(outboxPayloadSchema.safeParse({ ...validPayload, reviewMode: "full" }).success).toBe(false);
    expect(outboxPayloadSchema.safeParse({ ...validPayload, pullRequestNumber: "7" }).success).toBe(false);
  });

  test("rejects a non-boolean reviewEnabled", () => {
    expect(outboxPayloadSchema.safeParse({ ...validPayload, reviewEnabled: "yes" }).success).toBe(false);
  });
});

describe("ingestOutcomeSchema", () => {
  test.each(INGEST_OUTCOMES)("accepts %s", (outcome) => {
    expect(ingestOutcomeSchema.parse(outcome)).toBe(outcome);
  });

  test.each(["unknown", "created ", ""])("rejects %j", (outcome) => {
    expect(ingestOutcomeSchema.safeParse(outcome).success).toBe(false);
  });
});
