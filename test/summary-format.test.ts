import { describe, expect, test } from "vitest";
import type { StoredFinding } from "../src/modules/findings/index.js";
import { buildInlineCommentBody, buildReviewBody, extractFingerprint } from "../src/modules/publishing/summary.js";

const finding = (overrides: Partial<StoredFinding> = {}): StoredFinding => ({
  id: "f1",
  fingerprint: "fp1:abc",
  category: "security",
  severity: "medium",
  confidence: 0.9,
  title: "Finding",
  filePath: "src/app.js",
  lineNumber: 2,
  description: "a problem",
  verified: true,
  status: "new",
  reopened: false,
  ...overrides,
});

describe("review body formatting", () => {
  test("renders verdict, concise summary and flat numbered findings", () => {
    const body = buildReviewBody({
      summary: "First sentence. Second sentence. Third sentence should be dropped.",
      verified: [
        finding({ category: "maintainability", severity: "low", title: "Naming drift" }),
        finding({ category: "security", severity: "high", title: "Unredacted dump" }),
        finding({ category: "security", severity: "medium", title: "Unbounded write" }),
      ],
      uncertain: [],
      config: { publishUncertainInSummary: true, publishCleanReview: true },
    });

    expect(body).toContain("**Changes requested** · 1 high · 1 medium · 1 low");
    expect(body).toContain("> First sentence. Second sentence.");
    expect(body).not.toContain("Third sentence");
    expect(body.indexOf("## Findings (3)")).toBeGreaterThan(-1);
    expect(body.indexOf("### 1. Unredacted dump")).toBeGreaterThan(-1);
    expect(body.indexOf("### 2. Unbounded write")).toBeGreaterThan(body.indexOf("### 1. Unredacted dump"));
    expect(body.indexOf("### 3. Naming drift")).toBeGreaterThan(body.indexOf("### 2. Unbounded write"));
    expect(body).not.toContain("Findings at a glance");
    expect(body).toContain("🔓 Break glass · 🔄 Re-run review");
  });

  test("problem, impact and fix are separated", () => {
    const body = buildReviewBody({
      summary: "One issue.",
      verified: [
        finding({
          category: "dataIntegrity",
          severity: "high",
          title: "Counts cover only one page",
          description: "Counts come from the first page.",
          impact: "Status counts can disagree with the total.",
          recommendation: "Aggregate in SQL.",
          guideline: "03_contracts-schemas.md §3",
          evidence: [{ file: "src/app.js", line: 2, excerpt: "count()", reason: "counts the full table" }],
        }),
      ],
      uncertain: [],
      config: { publishUncertainInSummary: true, publishCleanReview: true },
    });
    expect(body).toContain("Counts come from the first page.");
    expect(body).toContain("**Impact:** Status counts can disagree with the total.");
    expect(body).toContain("**Suggested fix:** Aggregate in SQL.");
    expect(body).toContain("<summary>Technical details</summary>");
    expect(body).toContain("- Guideline: 03_contracts-schemas.md §3");
    expect(body).toContain("- Evidence: `src/app.js:2` — counts the full table");
  });

  test("guideline references link to the handbook file at the review ref", () => {
    const body = buildReviewBody({
      summary: "One issue.",
      verified: [
        finding({
          title: "Counts cover only one page",
          guideline: "03_contracts-schemas.md §3",
        }),
      ],
      uncertain: [],
      config: { publishUncertainInSummary: true, publishCleanReview: true },
      guidelineSource: {
        repo: "nativewit/engineering-handbook",
        ref: "feat/typescript-guidelines",
        files: ["docs/guidelines/typescript/03_contracts-schemas.md"],
      },
    });
    expect(body).toContain(
      "- Guideline: [03_contracts-schemas.md §3](https://github.com/nativewit/engineering-handbook/blob/feat/typescript-guidelines/docs/guidelines/typescript/03_contracts-schemas.md)",
    );
  });

  test("uncertain findings are collapsed and only rendered when enabled", () => {
    const uncertain = finding({
      verified: false,
      status: "uncertain",
      severity: "low",
      confidence: 0.5,
      title: "Maybe issue",
      description: "a maybe problem",
    });
    const enabled = buildReviewBody({
      summary: "s",
      verified: [finding()],
      uncertain: [uncertain],
      config: { publishUncertainInSummary: true, publishCleanReview: true },
    });
    expect(enabled).toContain("<summary>Additional observation (1, unverified)</summary>");
    expect(enabled).toContain("**Maybe issue**");
    expect(enabled).toContain("a maybe problem");

    const disabled = buildReviewBody({
      summary: "s",
      verified: [finding()],
      uncertain: [uncertain],
      config: { publishUncertainInSummary: false, publishCleanReview: true },
    });
    expect(disabled).not.toContain("Additional observation");
  });

  test("PR number, humanized model and commit render in the footer", () => {
    const body = buildReviewBody({
      summary: "s",
      verified: [],
      uncertain: [],
      config: { publishUncertainInSummary: true, publishCleanReview: true },
      meta: {
        reviewer: "ai-pr-reviewer",
        source: "acme/widgets#42 @ abc1234",
        model: "workers-ai/@cf/zai-org/glm-4.7-flash",
        reviewedAt: new Date("2026-11-12T00:30:00Z"),
        timezone: "UTC",
      },
    });
    expect(body).toContain("# PR #42 Review");
    expect(body).toContain("<sub>GLM 4.7 Flash · 12 Nov 2026 · `abc1234`</sub>");
    expect(body).not.toContain("**Source:**");
  });

  test("clean reviews stay short", () => {
    const body = buildReviewBody({
      summary: "No issues found.",
      verified: [],
      uncertain: [],
      config: { publishUncertainInSummary: true, publishCleanReview: true },
    });
    expect(body).toContain("**No changes requested** · 0 confirmed findings");
    expect(body).toContain("No confirmed findings");
    expect(body).toContain("## Findings (0)");
  });

  test("inline comments use the review-bot finding report format", () => {
    const body = buildInlineCommentBody(
      finding({
        title: "ProductsService.list() swallows repository errors and returns a fabricated empty page",
        category: "errorHandling",
        severity: "high",
        confidence: 0.85,
        description:
          "The service catches every repository failure and returns a fake empty page instead of allowing a typed AppError to propagate. This introduces a null-style sentinel for failure, which the service rules prohibit.",
        guideline: "BACKEND_SERVICE_ERROR_HANDLING – 04_backend-modules.md §3 Services",
        impact: "Callers cannot distinguish an empty catalogue from a failed query.",
        recommendation: "Let the typed AppError propagate.",
      }),
    );

    expect(body).toBe(
      [
        "<!-- review-bot:v1 rule=BACKEND_SERVICE_ERROR_HANDLING fp=fp1:abc sev=high conf=0.85 -->",
        "",
        "🔴 ProductsService.list() swallows repository errors and returns a fabricated empty page",
        "",
        "High · Error handling · Confidence: High (85%)",
        "",
        "The service catches every repository failure and returns a fake empty page instead of allowing a typed AppError to propagate. This introduces a null-style sentinel for failure, which the service rules prohibit.",
        "",
        "Guideline: BACKEND_SERVICE_ERROR_HANDLING – 04_backend-modules.md §3 Services",
      ].join("\n"),
    );
    expect(extractFingerprint(body)).toBe("fp1:abc");
  });

  test("inline comment links the cited guideline", () => {
    const body = buildInlineCommentBody(
      finding({
        title: "Leak",
        guideline: "docs/guidelines/typescript/03_contracts-schemas.md §3",
      }),
      {
        repo: "nativewit/engineering-handbook",
        ref: "feat/typescript-guidelines",
      },
    );
    expect(body).toContain(
      "Guideline: [docs/guidelines/typescript/03_contracts-schemas.md §3](https://github.com/nativewit/engineering-handbook/blob/feat/typescript-guidelines/docs/guidelines/typescript/03_contracts-schemas.md)",
    );
    expect(body).toContain("rule=SECURITY");
  });

  test("extractFingerprint still reads legacy fingerprint markers", () => {
    expect(extractFingerprint("<!-- ai-pr-reviewer:fingerprint:fp1:abc -->")).toBe("fp1:abc");
  });

  test("oversized summaries stay below the GitHub limit", () => {
    const body = buildReviewBody({
      summary: "x".repeat(70_000),
      verified: [],
      uncertain: [],
      config: { publishUncertainInSummary: false, publishCleanReview: false },
    });
    expect(body.length).toBeLessThanOrEqual(60_000);
  });
});
