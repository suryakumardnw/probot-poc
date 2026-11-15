import { describe, expect, test } from "vitest";
import {
  analysisOutputSchema as analysisOutputSchemaFromEngine,
  reviewResultSchema as reviewResultSchemaFromEngine,
} from "../modules/review/result-schema.js";
import { analysisOutputSchema, findingSchema, reviewResultSchema } from "./review.js";

const finding = (overrides: Record<string, unknown> = {}) => ({
  category: "functional",
  severity: "medium",
  confidence: 0.8,
  title: "Off-by-one in pagination",
  file: "src/pagination.ts",
  line: 42,
  description: "The page offset skips the first item.",
  evidence: [
    {
      file: "src/pagination.ts",
      line: 42,
      excerpt: "const offset = page * size + size;",
      reason: "adds an extra page worth of items",
    },
  ],
  ...overrides,
});

const reportingResponse = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  summary: "Reviewed the pagination change.",
  findings: [finding()],
  uncertain_findings: [],
  conventions: ["vitest for tests"],
  ...overrides,
});

describe("reviewResultSchema", () => {
  test("accepts snake_case uncertain_findings and maps it to the camelCase field", () => {
    const parsed = reviewResultSchema.parse({
      ...reportingResponse(),
      uncertain_findings: [{ ...finding(), confidence: 0.4, title: "Maybe" }],
    });

    expect(parsed.findings).toHaveLength(1);
    expect(parsed.uncertainFindings).toHaveLength(1);
    expect(parsed.uncertainFindings[0]?.title).toBe("Maybe");
    expect("uncertain_findings" in parsed).toBe(false);
  });

  test("accepts an empty findings array (no invented quota)", () => {
    const parsed = reviewResultSchema.parse({ ...reportingResponse(), findings: [] });
    expect(parsed.findings).toEqual([]);
  });

  test("rejects a finding without evidence", () => {
    const parsed = reviewResultSchema.safeParse({ ...reportingResponse(), findings: [finding({ evidence: [] })] });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.message.includes("evidence"))).toBe(true);
    }
  });

  test("normalizes null/zero evidence lines and null optional finding fields", () => {
    const parsed = reviewResultSchema.parse({
      ...reportingResponse(),
      findings: [
        finding({
          impact: null,
          recommendation: "   ",
          guideline: null,
          verified: null,
          evidence: [{ file: "src/a.ts", line: 0, excerpt: "x", reason: "y" }],
        }),
      ],
    });

    expect(parsed.findings[0]?.evidence[0]?.line).toBeUndefined();
    expect(parsed.findings[0]?.impact).toBeUndefined();
    expect(parsed.findings[0]?.recommendation).toBeUndefined();
    expect(parsed.findings[0]?.guideline).toBeUndefined();
    expect(parsed.findings[0]?.verified).toBeUndefined();
  });

  test("uses safe defaults for a minimal clean-review answer", () => {
    const parsed = reviewResultSchema.parse({ summary: "Reviewed." });

    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.findings).toEqual([]);
    expect(parsed.uncertainFindings).toEqual([]);
    expect(parsed.conventions).toEqual([]);
  });

  test("clamps over-long conventions instead of failing the review", () => {
    const parsed = reviewResultSchema.parse({ ...reportingResponse(), conventions: [`x${"y".repeat(900)}`] });
    expect(parsed.conventions[0]?.length).toBeLessThanOrEqual(500);
    expect(parsed.conventions[0]?.startsWith("xy")).toBe(true);
  });

  test("rejects extra keys (strict boundary)", () => {
    expect(reviewResultSchema.safeParse({ ...reportingResponse(), extra: true }).success).toBe(false);
  });

  test.each([
    ["confidence above 1", { findings: [finding({ confidence: 1.5 })] }],
    ["an unknown category", { findings: [finding({ category: "vibes" })] }],
    ["line zero", { findings: [finding({ line: 0 })] }],
    ["a missing title", { findings: [finding({ title: "" })] }],
  ])("rejects %s", (_name, overrides) => {
    expect(reviewResultSchema.safeParse(reportingResponse(overrides)).success).toBe(false);
  });

  test("exposes the same finding schema used by the result", () => {
    expect(findingSchema.safeParse(finding()).success).toBe(true);
    expect(findingSchema.safeParse({ ...finding(), evidence: [] }).success).toBe(false);
  });
});

describe("analysisOutputSchema", () => {
  test("applies defaults for optional analysis fields", () => {
    const parsed = analysisOutputSchema.parse({ objective: "x" });
    expect(parsed).toEqual({
      objective: "x",
      conventions: [],
      tool_requests: [],
      preliminary_findings: [],
      no_additional_context_needed: false,
    });
  });

  test("absorbs reporting-stage keys from model drift", () => {
    const preliminary = { title: "prelim", file: "a.ts", line: 1 };
    const confident = { title: "final", file: "b.ts", line: 2 };
    const uncertain = { title: "unsure", file: "c.ts", line: 3 };

    const parsed = analysisOutputSchema.parse({
      schemaVersion: 1,
      summary: "PR summary",
      preliminary_findings: [preliminary],
      findings: [confident],
      uncertain_findings: [uncertain],
      tool_requests: [],
      no_additional_context_needed: true,
    });

    expect(parsed.objective).toBe("PR summary");
    expect(parsed.preliminary_findings).toEqual([preliminary, confident, uncertain]);
    expect(parsed.no_additional_context_needed).toBe(true);
  });

  test("rejects genuinely unknown keys", () => {
    expect(analysisOutputSchema.safeParse({ objective: "x", mystery: 1 }).success).toBe(false);
  });
});

describe("temporary review module re-export", () => {
  test("keeps the moved schemas identical until PR 3.12 removes the shim", () => {
    expect(reviewResultSchemaFromEngine).toBe(reviewResultSchema);
    expect(analysisOutputSchemaFromEngine).toBe(analysisOutputSchema);
  });
});
