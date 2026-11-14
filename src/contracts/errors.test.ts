import { describe, expect, test } from "vitest";
import { ERROR_CODES, errorEnvelopeSchema } from "./errors.js";

const validEnvelope = {
  code: ERROR_CODES.INTERNAL_ERROR,
  message: "Internal server error",
  statusCode: 500,
};

describe("errorEnvelopeSchema", () => {
  test("accepts the minimal envelope", () => {
    const parsed = errorEnvelopeSchema.parse(validEnvelope);
    expect(parsed).toEqual(validEnvelope);
  });

  test("accepts safe JSON details", () => {
    const details = { field: "repository", nested: { attempt: 2 }, values: ["a", 1, true, null] };
    const parsed = errorEnvelopeSchema.parse({ ...validEnvelope, details });
    expect(parsed.details).toEqual(details);
  });

  test.each([
    ["missing code", { ...validEnvelope, code: undefined }],
    ["empty code", { ...validEnvelope, code: "" }],
    ["lowercase code", { ...validEnvelope, code: "internal_error" }],
    ["code with spaces", { ...validEnvelope, code: "INTERNAL ERROR" }],
    ["non-string code", { ...validEnvelope, code: 500 }],
  ])("rejects %s", (_name, candidate) => {
    expect(errorEnvelopeSchema.safeParse(candidate).success).toBe(false);
  });

  test.each([
    ["missing message", { ...validEnvelope, message: undefined }],
    ["empty message", { ...validEnvelope, message: "" }],
    ["non-string message", { ...validEnvelope, message: 42 }],
  ])("rejects %s", (_name, candidate) => {
    expect(errorEnvelopeSchema.safeParse(candidate).success).toBe(false);
  });

  test.each([
    ["below 400", 399],
    ["above 599", 600],
    ["fractional", 500.5],
    ["string", "500"],
  ])("rejects a statusCode %s", (_name, statusCode) => {
    expect(errorEnvelopeSchema.safeParse({ ...validEnvelope, statusCode }).success).toBe(false);
  });

  test("rejects details that are not JSON values", () => {
    const candidate = { ...validEnvelope, details: { callback: () => undefined } };
    expect(errorEnvelopeSchema.safeParse(candidate).success).toBe(false);
  });

  test("every registered error code is a valid envelope code", () => {
    for (const code of Object.values(ERROR_CODES)) {
      const candidate = { code, message: "safe message", statusCode: 500 };
      expect(errorEnvelopeSchema.safeParse(candidate).success).toBe(true);
    }
  });
});
