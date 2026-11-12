import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { reviewConfigSchema, type ReviewConfig } from "../src/config/review-schema.js";
import { scoreComplexity, parseDiffStats } from "../src/review-engine/complexity.js";
import { createReviewPlan, skippedStageIds } from "../src/review-engine/plan.js";
import {
  RetrievalBudget,
  fulfillToolRequests,
  parseToolRequests,
  renderToolContext,
} from "../src/review-engine/tools.js";
import { reviewResultSchema, analysisOutputSchema } from "../src/review-engine/result-schema.js";
import { runReview } from "../src/review-engine/engine.js";
import { ReviewEngineError } from "../src/review-engine/types.js";
import {
  AgentRuntimeError,
  type AgentRuntime,
  type AgentSession,
  type AgentSessionOptions,
  type AgentTask,
} from "../src/agent/types.js";
import type { ChangedFile } from "../src/workspace/files.js";
import type { WorkspaceResult } from "../src/workspace/workspace.js";

/**
 * Ticket 07 unit tests: adaptive repository-aware review engine.
 *
 * All model interaction is faked via a scripted AgentRuntime; repository
 * fixtures are small on-disk workspaces (no git needed — the engine consumes
 * a prepared WorkspaceResult). Covering: complexity scoring, stage skipping,
 * retrieval/token budgets, structured-output validation, evidence
 * requirement, no-finding case and tool-request protocol security.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface DiffFile {
  path: string;
  before: string[];
  after: string[];
}

function makeDiff(files: DiffFile[]): string {
  return files
    .map((f) =>
      [
        `diff --git a/${f.path} b/${f.path}`,
        `index 0000000..1111111 100644`,
        `--- a/${f.path}`,
        `+++ b/${f.path}`,
        `@@ -1,${Math.max(f.before.length, 1)} +1,${Math.max(f.after.length, 1)} @@`,
        ...f.before.map((l) => `-${l}`),
        ...f.after.map((l) => `+${l}`),
      ].join("\n"),
    )
    .join("\n");
}

async function makeWorkspaceDir(files: Record<string, string>, binaries: Record<string, Buffer> = {}): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "engine-fixture-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content);
  }
  for (const [rel, bytes] of Object.entries(binaries)) {
    const abs = path.join(dir, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, bytes);
  }
  return dir;
}

function workspace(dir: string, diff: string, changedFiles: ChangedFile[]): WorkspaceResult {
  return {
    workspacePath: dir,
    headSha: "head-sha",
    baseSha: "base-sha",
    mergeBaseSha: "merge-base-sha",
    diff,
    changedFiles,
  };
}

function makeConfig(overrides: Record<string, unknown> = {}): ReviewConfig {
  return reviewConfigSchema.parse({
    schemaVersion: 1,
    github: { organization: "fixture-org" },
    provider: {
      baseURL: "https://llm.example.test/compat",
      apiKeyEnv: "MODEL_API_KEY",
      model: "workers-ai/@cf/zai-org/glm-4.7-flash",
    },
    ...overrides,
  });
}

/** Force the "high" tier regardless of the fixture diff. */
function highTierConfig(overrides: Record<string, unknown> = {}): ReviewConfig {
  return makeConfig({
    review: { complexity: { thresholds: { low: 0, medium: 0 } } },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Fake runtime
// ---------------------------------------------------------------------------

type Responder = (task: AgentTask, callIndex: number) => unknown;

class FakeRuntime implements AgentRuntime {
  responders: Responder[] = [];
  usageQueue: Array<{ inputTokens?: number; outputTokens?: number; reasoningTokens?: number }> = [];
  started: AgentSessionOptions[] = [];
  tasks: AgentTask[] = [];
  terminated = 0;

  async startSession(options: AgentSessionOptions): Promise<AgentSession> {
    this.started.push(options);
    return {
      id: "sess-fake-1",
      reviewId: options.reviewId,
      workspacePath: options.workspacePath,
      createdAt: new Date().toISOString(),
      timeoutMs: options.timeoutMs ?? 0,
    };
  }

  async execute(session: AgentSession, task: AgentTask): Promise<import("../src/agent/types.js").AgentResult> {
    const callIndex = this.tasks.length;
    this.tasks.push(task);
    const respond = this.responders[callIndex];
    if (!respond) {
      throw new AgentRuntimeError("invalid_output", `no scripted response for call ${callIndex}`);
    }
    const value = respond(task, callIndex);
    if (task.validate) {
      const outcome = task.validate(value);
      if (!outcome.ok) {
        // Mirrors the real runtime: invalid structured output fails immediately.
        throw new AgentRuntimeError("invalid_output", `agent output failed validation: ${outcome.error}`);
      }
      return { sessionId: session.id, text: "", value: outcome.value, durationMs: 5, usage: this.usageQueue.shift() };
    }
    return { sessionId: session.id, text: "", value, durationMs: 5, usage: this.usageQueue.shift() };
  }

  async terminate(): Promise<void> {
    this.terminated += 1;
  }

  async healthCheck() {
    return { healthy: true, detail: "fake", checkedAt: new Date().toISOString() };
  }
}

type AnalysisOverrides = Partial<{
  objective: string;
  conventions: string[];
  tool_requests: unknown[];
  preliminary_findings: unknown[];
  no_additional_context_needed: boolean;
}>;

function analysisResponse(overrides: AnalysisOverrides = {}) {
  return {
    objective: "test objective",
    conventions: [],
    tool_requests: [],
    preliminary_findings: [],
    no_additional_context_needed: true,
    ...overrides,
  };
}

type FindingOverrides = Partial<{
  category: string;
  severity: string;
  confidence: number;
  title: string;
  file: string;
  line: number;
  description: string;
  evidence: unknown[];
  verified: boolean;
}>;

function finding(overrides: FindingOverrides = {}) {
  return {
    category: "functional",
    severity: "high",
    confidence: 0.95,
    title: "Broken caller contract",
    file: "src/utils.ts",
    line: 3,
    description: "The return type changed and callers break.",
    evidence: [{ file: "src/utils.ts", line: 3, excerpt: "return { name }", reason: "shape changed" }],
    verified: true,
    ...overrides,
  };
}

function reportingResponse(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    summary: "Reviewed the change.",
    findings: [],
    uncertain_findings: [],
    conventions: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Complexity scoring
// ---------------------------------------------------------------------------

describe("complexity scoring", () => {
  const config = makeConfig();

  test("small isolated PR scores low", async () => {
    const dir = await makeWorkspaceDir({ "src/index.ts": "console.log('hi');\n" });
    const diff = makeDiff([{ path: "src/index.ts", before: ["old"], after: ["new"] }]);
    const score = scoreComplexity(workspace(dir, diff, [{ path: "src/index.ts", status: "modified" }]), config);
    expect(score.score).toBeLessThan(config.review.complexity.thresholds.low);
    expect(score.tier).toBe("low");
    expect(score.factors).toHaveLength(7);
    for (const factor of score.factors) {
      expect(factor.contribution).toBeCloseTo(factor.subscore * factor.weight, 5);
      expect(factor.detail.length).toBeGreaterThan(0);
    }
    await fsp.rm(dir, { recursive: true, force: true });
  });

  test("complex multi-module PR scores high", async () => {
    const dir = await makeWorkspaceDir({});
    const paths = Array.from({ length: 12 }, (_, i) => `module${i}/service.ts`);
    const after = Array.from({ length: 40 }, (_, i) => `await transaction(saveSession(user${i}, token)); // auth`);
    const diff = makeDiff(paths.map((p) => ({ path: p, before: ["old line"], after })));
    const changed: ChangedFile[] = paths.map((p) => ({ path: p, status: "modified" }));
    changed.push({ path: "package.json", status: "modified" });
    const score = scoreComplexity(workspace(dir, diff, changed), config);
    expect(score.tier).toBe("high");
    expect(score.score).toBeGreaterThanOrEqual(config.review.complexity.thresholds.medium);
    const names = score.factors.map((f) => f.name);
    expect(names).toContain("diffSize");
    expect(names).toContain("dataIntegrity");
    await fsp.rm(dir, { recursive: true, force: true });
  });

  test("scoring is deterministic", async () => {
    const dir = await makeWorkspaceDir({});
    const diff = makeDiff([{ path: "src/auth/login.ts", before: ["a"], after: ["await checkToken(password)"] }]);
    const ws = workspace(dir, diff, [{ path: "src/auth/login.ts", status: "modified" }]);
    const a = scoreComplexity(ws, config);
    const b = scoreComplexity(ws, config);
    expect(a).toEqual(b);
    await fsp.rm(dir, { recursive: true, force: true });
  });

  test("weights are configurable (zero weights → zero score)", () => {
    const zero = makeConfig({
      review: { complexity: { weights: { diffSize: 0, changedFiles: 0, structural: 0, dependencyImpact: 0, riskyCode: 0, concurrency: 0, dataIntegrity: 0 } } },
    });
    const diff = makeDiff([{ path: "src/auth/x.ts", before: ["a"], after: ["transaction(secret)"] }]);
    const score = scoreComplexity(
      workspace("/tmp", diff, [{ path: "src/auth/x.ts", status: "modified" }]),
      zero,
    );
    expect(score.score).toBe(0);
    expect(score.tier).toBe("low");
  });

  test("parseDiffStats separates headers from body", () => {
    const stats = parseDiffStats(makeDiff([{ path: "a.ts", before: ["old"], after: ["new1", "new2"] }]));
    expect(stats.added).toBe(2);
    expect(stats.removed).toBe(1);
    expect(stats.bodyLines).toContain("new1");
    expect(stats.bodyLines.join("\n")).not.toContain("diff --git");
  });
});

// ---------------------------------------------------------------------------
// Adaptive planning & stage skipping
// ---------------------------------------------------------------------------

describe("review plan", () => {
  const config = makeConfig();

  function planFor(diff: string, files: ChangedFile[], cfg: ReviewConfig = config) {
    const complexity = scoreComplexity(workspace("/tmp", diff, files), cfg);
    return { complexity, plan: createReviewPlan(complexity, cfg) };
  }

  test("low-tier clean change skips investigation and verification with justifications", () => {
    const diff = makeDiff([{ path: "src/index.ts", before: ["old"], after: ["new"] }]);
    const { complexity, plan } = planFor(diff, [{ path: "src/index.ts", status: "modified" }]);
    expect(complexity.tier).toBe("low");
    const skipped = skippedStageIds(plan);
    expect(skipped).toContain("context-investigation");
    expect(skipped).toContain("finding-verification");
    const investigation = plan.stages.find((s) => s.id === "context-investigation")!;
    expect(investigation.enabled).toBe(false);
    expect(investigation.justification).toMatch(/^skipped: low-complexity/);
    expect(plan.budgets.maxModelCalls).toBe(2);
    expect(plan.budgets.maxFileRetrievals).toBe(4);
  });

  test("low-tier change with risk-sensitive signals still investigates", () => {
    const diff = makeDiff([{ path: "src/auth/session.ts", before: ["old"], after: ["const token = issueSession();"] }]);
    const { plan } = planFor(diff, [{ path: "src/auth/session.ts", status: "modified" }]);
    const investigation = plan.stages.find((s) => s.id === "context-investigation")!;
    expect(investigation.enabled).toBe(true);
    expect(investigation.justification).toContain("risk-sensitive");
  });

  test("verifyFindings=false skips verification with a config justification", () => {
    const cfg = makeConfig({ review: { strategy: { verifyFindings: false } } });
    const complexity = scoreComplexity(workspace("/tmp", "diff --git a/x b/x", [{ path: "x", status: "modified" }]), cfg);
    const plan = createReviewPlan(complexity, cfg);
    const verification = plan.stages.find((s) => s.id === "finding-verification")!;
    expect(verification.enabled).toBe(false);
    expect(verification.justification).toContain("verifyFindings is disabled");
  });

  test("high tier enables all stages and scales budgets", () => {
    const diff = makeDiff(
      Array.from({ length: 12 }, (_, i) => ({
        path: `module${i}/service.ts`,
        before: ["old line"],
        after: Array.from({ length: 40 }, (_, j) => `await transaction(saveSession(user${j}, token)); // auth`),
      })),
    );
    const { complexity, plan } = planFor(diff, Array.from({ length: 12 }, (_, i) => ({ path: `module${i}/service.ts`, status: "modified" as const })));
    expect(complexity.tier).toBe("high");
    expect(skippedStageIds(plan)).toEqual([]);
    expect(plan.budgets.maxModelCalls).toBe(6);
    expect(plan.budgets.maxFileRetrievals).toBe(30);
    expect(plan.budgets.maxInputTokens).toBe(config.agent.context.maxInputTokens);
  });

  test("absolute agent.context caps win over tier scaling (§11.3)", () => {
    const cfg = makeConfig({ agent: { context: { maxFiles: 2, maxRetrievalCalls: 3 } } });
    const diff = makeDiff(
      Array.from({ length: 12 }, (_, i) => ({
        path: `module${i}/service.ts`,
        before: ["old line"],
        after: Array.from({ length: 40 }, (_, j) => `await transaction(saveSession(user${j}, token)); // auth`),
      })),
    );
    const complexity = scoreComplexity(workspace("/tmp", diff, []), cfg);
    const plan = createReviewPlan(complexity, cfg);
    expect(complexity.tier).toBe("high");
    expect(plan.budgets.maxModelCalls).toBe(3);
    expect(plan.budgets.maxFileRetrievals).toBe(2);
  });

  test("empty workspace is trivially low tier, not an error", () => {
    const complexity = scoreComplexity(workspace("/tmp", "", []), config);
    expect(complexity.tier).toBe("low");
    expect(complexity.score).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tool-request protocol security
// ---------------------------------------------------------------------------

describe("tool-request protocol", () => {
  test("unknown tool names are rejected and recorded as violations", () => {
    const budget = new RetrievalBudget(5);
    const requests = parseToolRequests(
      [
        { tool: "run_shell", command: "rm -rf /" },
        { tool: "read_file", path: "src/a.ts" },
        "not an object",
        { tool: "read_file" }, // missing path
        { tool: "fetch_url", path: "https://evil.test" },
      ],
      budget,
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({ tool: "read_file", path: "src/a.ts", includeDiff: false });
    expect(budget.violations.length).toBeGreaterThanOrEqual(3);
    expect(budget.violations.join("\n")).toContain("run_shell");
    expect(budget.used).toBe(0);
  });

  test("malformed tool_requests container is a violation, not a crash", () => {
    const budget = new RetrievalBudget(5);
    expect(parseToolRequests("I want everything", budget)).toEqual([]);
    expect(budget.violations).toContain("tool_requests: not an array; ignored");
    expect(parseToolRequests(null, budget)).toEqual([]);
  });

  test("path escape attempts are rejected and never read outside the workspace", async () => {
    const dir = await makeWorkspaceDir({ "src/safe.ts": "safe\n" });
    const secret = path.join(os.tmpdir(), "outside-secret.txt");
    await fsp.writeFile(secret, "TOP SECRET");
    const budget = new RetrievalBudget(10);
    const requests = parseToolRequests(
      [
        { tool: "read_file", path: "../outside-secret.txt" },
        { tool: "read_file", path: secret }, // absolute path
        { tool: "read_file", path: "src/safe.ts" },
      ],
      budget,
    );
    const results = await fulfillToolRequests(dir, requests, budget, "diff", 1_000_000);
    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({ ok: false, error: "path_escape" });
    expect(results[1]).toMatchObject({ ok: false, error: "path_escape" });
    expect(results[2]).toMatchObject({ ok: true });
    expect((results[2] as { content: string }).content).toContain("safe");
    expect(budget.violations.join("\n")).toContain("path_escape");
    // The secret file was never delivered.
    expect(JSON.stringify(results)).not.toContain("TOP SECRET");
    expect(budget.used).toBe(1);
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.rm(secret, { force: true });
  });

  test("retrieval budget is enforced: excess requests are dropped with violations", async () => {
    const dir = await makeWorkspaceDir({ "a.ts": "A\n", "b.ts": "B\n", "c.ts": "C\n" });
    const budget = new RetrievalBudget(2);
    const requests = parseToolRequests(
      [
        { tool: "read_file", path: "a.ts" },
        { tool: "read_file", path: "b.ts" },
        { tool: "read_file", path: "c.ts" },
      ],
      budget,
    );
    const results = await fulfillToolRequests(dir, requests, budget, "diff", 1_000_000);
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(results[2]).toMatchObject({ ok: false, error: "budget_exhausted" });
    expect(budget.violations.join("\n")).toContain("budget exhausted");
    expect(budget.used).toBe(2);
    await fsp.rm(dir, { recursive: true, force: true });
  });

  test("binary content is withheld, oversized files rejected", async () => {
    const dir = await makeWorkspaceDir(
      { "big.txt": "x".repeat(100) },
      { "img.bin": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x01, 0x02]) },
    );
    const budget = new RetrievalBudget(10);
    const requests = parseToolRequests(
      [
        { tool: "read_file", path: "img.bin" },
        { tool: "read_file", path: "big.txt" },
      ],
      budget,
    );
    const results = await fulfillToolRequests(dir, requests, budget, "diff", 50);
    expect(results[0]).toMatchObject({ ok: false, error: "binary_file" });
    expect(results[1]).toMatchObject({ ok: false, error: "file_too_large" });
    expect(budget.violations.join("\n")).toContain("binary content withheld");
    await fsp.rm(dir, { recursive: true, force: true });
  });

  test("list_files and get_diff are fulfilled inside the workspace", async () => {
    const dir = await makeWorkspaceDir({ "src/a.ts": "A\n", "src/b.ts": "B\n" });
    const budget = new RetrievalBudget(10);
    const requests = parseToolRequests(
      [
        { tool: "list_files", path: "src" },
        { tool: "get_diff" },
      ],
      budget,
    );
    const results = await fulfillToolRequests(dir, requests, budget, "diff --git a/x b/x", 1_000_000);
    expect(results[0]).toMatchObject({ ok: true });
    expect((results[0] as { content: string }).content).toBe("a.ts\nb.ts");
    expect(results[1]).toMatchObject({ ok: true, content: "diff --git a/x b/x" });
    expect(renderToolContext(results)).toContain("[get_diff]");
    expect(renderToolContext(results)).toContain("[list_files src]");
    await fsp.rm(dir, { recursive: true, force: true });
  });

  test("exhausted budget is visible before any request", () => {
    const budget = new RetrievalBudget(1);
    expect(budget.consume()).toBe(true);
    expect(budget.exhausted).toBe(true);
    expect(budget.remaining).toBe(0);
    expect(budget.consume()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Structured output validation (model → app boundary)
// ---------------------------------------------------------------------------

describe("review result schema", () => {
  test("valid result with snake_case uncertain_findings passes", () => {
    const parsed = reviewResultSchema.safeParse({
      schemaVersion: 1,
      summary: "ok",
      findings: [finding()],
      uncertain_findings: [{ ...finding(), confidence: 0.4, title: "Maybe" }],
      conventions: ["vitest for tests"],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.uncertainFindings).toHaveLength(1);
      expect(parsed.data.findings).toHaveLength(1);
    }
  });

  test("empty findings array is valid (no invented quota)", () => {
    const parsed = reviewResultSchema.safeParse(reportingResponse());
    expect(parsed.success).toBe(true);
  });

  test("finding without evidence is rejected (evidence requirement)", () => {
    const noEvidence = finding({ evidence: [] });
    const parsed = reviewResultSchema.safeParse({ ...reportingResponse(), findings: [noEvidence] });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.message.includes("evidence"))).toBe(true);
    }
  });

  test("null evidence line is treated as unspecified", () => {
    const withNullLine = finding({
      evidence: [{ file: "src/utils.ts", line: null, excerpt: "return { name }", reason: "shape changed" }],
    });
    const parsed = reviewResultSchema.safeParse({ ...reportingResponse(), findings: [withNullLine] });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.findings[0].evidence[0].line).toBeUndefined();
  });

  test("out-of-range confidence and unknown enum values are rejected", () => {
    expect(reviewResultSchema.safeParse({ ...reportingResponse(), findings: [finding({ confidence: 1.5 })] }).success).toBe(false);
    expect(reviewResultSchema.safeParse({ ...reportingResponse(), findings: [finding({ category: "vibes" })] }).success).toBe(false);
    expect(reviewResultSchema.safeParse({ ...reportingResponse(), findings: [finding({ line: 0 })] }).success).toBe(false);
  });

  test("extra keys are rejected (strict boundary)", () => {
    expect(reviewResultSchema.safeParse({ ...reportingResponse(), extra: true }).success).toBe(false);
  });

  test("analysis schema applies defaults for optional fields", () => {
    const parsed = analysisOutputSchema.safeParse({ objective: "x" });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.tool_requests).toEqual([]);
      expect(parsed.data.no_additional_context_needed).toBe(false);
    }
  });

  test("analysis schema absorbs reporting-stage keys from model drift", () => {
    // GLM/Haiku sometimes answer the analysis stage with reporting keys. Those
    // are benign drift: fold findings into preliminary_findings, use summary
    // as the objective when absent, and ignore schemaVersion.
    const prelim = { title: "prelim", file: "a.dart", line: 1 };
    const confident = { title: "final", file: "b.dart", line: 2 };
    const uncertain = { title: "unsure", file: "c.dart", line: 3 };
    const parsed = analysisOutputSchema.safeParse({
      schemaVersion: 1,
      summary: "PR summary",
      preliminary_findings: [prelim],
      findings: [confident],
      uncertain_findings: [uncertain],
      tool_requests: [],
      no_additional_context_needed: true,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.objective).toBe("PR summary");
      expect(parsed.data.preliminary_findings).toEqual([prelim, confident, uncertain]);
      expect(parsed.data.no_additional_context_needed).toBe(true);
    }
  });

  test("analysis schema still rejects genuinely unknown keys", () => {
    expect(analysisOutputSchema.safeParse({ objective: "x", mystery: 1 }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runReview end-to-end with the fake runtime
// ---------------------------------------------------------------------------

describe("runReview (fake runtime)", () => {
  const REVIEW_ID = "rev-1";

  function input(ws: WorkspaceResult) {
    return { reviewId: REVIEW_ID, workspace: ws };
  }

  test("clean low-tier PR produces an empty findings array and ≤2 model calls", async () => {
    const dir = await makeWorkspaceDir({ "src/index.ts": "console.log('hi');\n" });
    const diff = makeDiff([{ path: "src/index.ts", before: ["old"], after: ["new"] }]);
    const runtime = new FakeRuntime();
    runtime.responders = [
      () => analysisResponse({ no_additional_context_needed: true }),
      () => reportingResponse({ summary: "Clean change, no issues found." }),
    ];
    const config = makeConfig();
    const { result, meta } = await runReview(input(workspace(dir, diff, [{ path: "src/index.ts", status: "modified" }])), { runtime, config });

    expect(result.schemaVersion).toBe(1);
    expect(result.findings).toEqual([]);
    expect(result.uncertainFindings).toEqual([]);
    expect(result.summary).toBe("Clean change, no issues found.");
    expect(meta.usage.modelCalls).toHaveLength(2); // analysis + reporting, never more for low tier
    expect(meta.usage.modelCalls.map((c) => c.stage)).toEqual(["initial-analysis", "reporting-prep"]);
    expect(meta.skippedStages).toContain("context-investigation");
    expect(meta.skippedStages).toContain("finding-verification");
    expect(runtime.terminated).toBe(1);
    expect(runtime.started[0]?.reviewId).toBe(REVIEW_ID);
    await fsp.rm(dir, { recursive: true, force: true });
  });

  test("findings are validated: invalid structured output fails immediately with invalid_output", async () => {
    const dir = await makeWorkspaceDir({});
    const runtime = new FakeRuntime();
    runtime.responders = [
      () => analysisResponse(),
      () => ({ schemaVersion: 1, findings: [] }), // summary missing → schema failure
    ];
    await expect(
      runReview(input(workspace(dir, "diff --git a/x b/x", [{ path: "x", status: "modified" }])), {
        runtime,
        config: makeConfig(),
      }),
    ).rejects.toMatchObject({ name: "AgentRuntimeError", code: "invalid_output" });
    expect(runtime.tasks).toHaveLength(2); // no retry after the failure
    expect(runtime.terminated).toBe(1); // session still cleaned up
    await fsp.rm(dir, { recursive: true, force: true });
  });

  test("findings without evidence are rejected at the boundary", async () => {
    const dir = await makeWorkspaceDir({ "src/utils.ts": "code\n" });
    const runtime = new FakeRuntime();
    runtime.responders = [
      () => analysisResponse(),
      () => reportingResponse({ findings: [finding({ evidence: [] })] }),
    ];
    await expect(
      runReview(input(workspace(dir, "diff --git a/src/utils.ts b/src/utils.ts", [{ path: "src/utils.ts", status: "modified" }])), {
        runtime,
        config: makeConfig(),
      }),
    ).rejects.toMatchObject({ code: "invalid_output" });
    await fsp.rm(dir, { recursive: true, force: true });
  });

  test("`verified` is engine-derived and low-confidence findings go to uncertain", async () => {
    const dir = await makeWorkspaceDir({ "src/utils.ts": "code\n" });
    const runtime = new FakeRuntime();
    runtime.responders = [
      () => analysisResponse(),
      () =>
        reportingResponse({
          findings: [finding({ verified: false, confidence: 0.95, file: "src/utils.ts" })],
          uncertain_findings: [finding({ title: "uncertain one", confidence: 0.6, file: "src/utils.ts" })],
        }),
    ];
    const { result } = await runReview(
      input(workspace(dir, "diff --git a/src/utils.ts b/src/utils.ts", [{ path: "src/utils.ts", status: "modified" }])),
      { runtime, config: makeConfig() },
    );
    expect(result.findings).toHaveLength(1);
    // The model claimed verified:false; the engine derives it from thresholds.
    expect(result.findings[0]?.verified).toBe(true);
    expect(result.uncertainFindings).toHaveLength(1);
    expect(result.uncertainFindings[0]?.verified).toBe(false);
    await fsp.rm(dir, { recursive: true, force: true });
  });

  test("findings anchored to files missing from the workspace are demoted to uncertain", async () => {
    const dir = await makeWorkspaceDir({ "src/utils.ts": "code\n" });
    const runtime = new FakeRuntime();
    runtime.responders = [
      () => analysisResponse(),
      () => reportingResponse({ findings: [finding({ file: "ghost/missing.ts", confidence: 0.99 })] }),
    ];
    const { result, meta } = await runReview(
      input(workspace(dir, "diff --git a/src/utils.ts b/src/utils.ts", [{ path: "src/utils.ts", status: "modified" }])),
      { runtime, config: makeConfig() },
    );
    expect(result.findings).toHaveLength(0);
    expect(result.uncertainFindings).toHaveLength(1);
    expect(result.uncertainFindings[0]?.confidence).toBeLessThanOrEqual(0.5);
    expect(meta.retrieval.violations.join("\n")).toContain("demoted");
    await fsp.rm(dir, { recursive: true, force: true });
  });

  test("deduplication, severity and category filters apply deterministically", async () => {
    const dir = await makeWorkspaceDir({ "src/utils.ts": "code\n" });
    const runtime = new FakeRuntime();
    runtime.responders = [
      () => analysisResponse(),
      () =>
        reportingResponse({
          findings: [
            finding(),
            finding(), // duplicate → removed
            finding({ title: "Too minor", severity: "informational" }), // filtered by severity config
            finding({ title: "Style nit", category: "maintainability" }),
          ],
        }),
    ];
    const config = makeConfig({ review: { severity: ["critical", "high"], categories: { maintainability: false } } });
    const { result } = await runReview(
      input(workspace(dir, "diff --git a/src/utils.ts b/src/utils.ts", [{ path: "src/utils.ts", status: "modified" }])),
      { runtime, config },
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.title).toBe("Broken caller contract");
    await fsp.rm(dir, { recursive: true, force: true });
  });

  test("conventions are merged from analysis and reporting without duplicates", async () => {
    const dir = await makeWorkspaceDir({});
    const runtime = new FakeRuntime();
    runtime.responders = [
      () => analysisResponse({ conventions: ["vitest", "pino logging"] }),
      () => reportingResponse({ conventions: ["pino logging", "strict TS"] }),
    ];
    const { result } = await runReview(input(workspace(dir, "diff --git a/x b/x", [{ path: "x", status: "modified" }])), {
      runtime,
      config: makeConfig(),
    });
    expect(result.conventions).toEqual(["vitest", "pino logging", "strict TS"]);
    await fsp.rm(dir, { recursive: true, force: true });
  });

  test("provider failure propagates immediately (no retries, no model switching)", async () => {
    const dir = await makeWorkspaceDir({});
    const runtime = new FakeRuntime();
    runtime.responders = [
      () => {
        throw new AgentRuntimeError("provider_unavailable", "provider rejected the request");
      },
    ];
    await expect(
      runReview(input(workspace(dir, "diff --git a/x b/x", [{ path: "x", status: "modified" }])), {
        runtime,
        config: makeConfig(),
      }),
    ).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(runtime.tasks).toHaveLength(1);
    expect(runtime.terminated).toBe(1);
    await fsp.rm(dir, { recursive: true, force: true });
  });

  test("low tier merges investigation + reporting into a single follow-up call", async () => {
    const dir = await makeWorkspaceDir({
      "src/auth/utils.ts": "export function issueSession(secret: string) {\n  return secret;\n}\n",
    });
    // One risk keyword via the path ("auth") keeps the investigation stage
    // enabled while the score stays below the low-tier threshold.
    const diff = makeDiff([
      { path: "src/auth/utils.ts", before: ["old"], after: ["const value = combine(a, b); // updated"] },
    ]);
    const runtime = new FakeRuntime();
    runtime.responders = [
      () =>
        analysisResponse({
          no_additional_context_needed: false,
          tool_requests: [{ tool: "read_file", path: "src/auth/utils.ts" }],
        }),
      () => reportingResponse(),
    ];
    const { meta } = await runReview(
      input(workspace(dir, diff, [{ path: "src/auth/utils.ts", status: "modified" }])),
      { runtime, config: makeConfig() },
    );
    expect(meta.usage.modelCalls).toHaveLength(2);
    expect(meta.usage.modelCalls.map((c) => c.stage)).toEqual(["initial-analysis", "reporting-prep"]);
    expect(meta.skippedStages).not.toContain("context-investigation"); // risk signals keep it enabled
    expect(runtime.tasks[1]?.instruction).toContain("[read_file src/auth/utils.ts]");
    expect(runtime.tasks[1]?.instruction).toContain("issueSession");
    expect(meta.retrieval.fulfilled).toBe(1);
    await fsp.rm(dir, { recursive: true, force: true });
  });

  test("high tier gets a separate investigation round before the reporting call", async () => {
    const dir = await makeWorkspaceDir({ "src/utils.ts": "code\n" });
    const runtime = new FakeRuntime();
    runtime.responders = [
      () =>
        analysisResponse({
          no_additional_context_needed: false,
          tool_requests: [{ tool: "read_file", path: "src/utils.ts" }],
        }),
      () => analysisResponse({ no_additional_context_needed: true }),
      () => reportingResponse(),
    ];
    const { meta } = await runReview(
      input(workspace(dir, "diff --git a/src/utils.ts b/src/utils.ts", [{ path: "src/utils.ts", status: "modified" }])),
      { runtime, config: highTierConfig() },
    );
    expect(meta.usage.modelCalls.map((c) => c.stage)).toEqual([
      "initial-analysis",
      "context-investigation",
      "reporting-prep",
    ]);
    expect(meta.usage.modelCalls).toHaveLength(3);
    expect(meta.usage.modelCalls.length).toBeLessThanOrEqual(meta.plan.budgets.maxModelCalls);
    await fsp.rm(dir, { recursive: true, force: true });
  });

  test("model-call budget caps total invocations", async () => {
    const dir = await makeWorkspaceDir({ "src/utils.ts": "code\n" });
    const runtime = new FakeRuntime();
    runtime.responders = [
      () => analysisResponse({ no_additional_context_needed: false, tool_requests: [{ tool: "read_file", path: "src/utils.ts" }] }),
      () => reportingResponse(),
    ];
    const config = highTierConfig({ agent: { context: { maxRetrievalCalls: 2 } } });
    const { meta } = await runReview(
      input(workspace(dir, "diff --git a/src/utils.ts b/src/utils.ts", [{ path: "src/utils.ts", status: "modified" }])),
      { runtime, config },
    );
    expect(meta.usage.modelCalls.length).toBeLessThanOrEqual(config.agent.context.maxRetrievalCalls);
    expect(meta.usage.modelCalls).toHaveLength(2);
    await fsp.rm(dir, { recursive: true, force: true });
  });

  test("token budget exhaustion stops further retrieval with a recorded violation", async () => {
    const dir = await makeWorkspaceDir({ "src/utils.ts": "code\n" });
    const runtime = new FakeRuntime();
    runtime.responders = [
      () =>
        analysisResponse({
          no_additional_context_needed: false,
          tool_requests: [{ tool: "read_file", path: "src/utils.ts" }],
        }),
      () => reportingResponse(),
    ];
    runtime.usageQueue = [{ inputTokens: 5_000, outputTokens: 100 }];
    const config = highTierConfig({ agent: { context: { maxInputTokens: 1_000 } } });
    const { meta } = await runReview(
      input(workspace(dir, "diff --git a/src/utils.ts b/src/utils.ts", [{ path: "src/utils.ts", status: "modified" }])),
      { runtime, config },
    );
    expect(meta.retrieval.violations.join("\n")).toContain("token budget exhausted");
    expect(meta.retrieval.fulfilled).toBe(0);
    expect(meta.usage.modelCalls).toHaveLength(2); // reporting still runs
    await fsp.rm(dir, { recursive: true, force: true });
  });

  test("retrieval budget from config is enforced during the review", async () => {
    const dir = await makeWorkspaceDir({ "a.ts": "A\n", "b.ts": "B\n", "c.ts": "C\n" });
    const runtime = new FakeRuntime();
    runtime.responders = [
      () =>
        analysisResponse({
          no_additional_context_needed: false,
          tool_requests: [
            { tool: "read_file", path: "a.ts" },
            { tool: "read_file", path: "b.ts" },
            { tool: "read_file", path: "c.ts" },
          ],
        }),
      () => reportingResponse(),
    ];
    const config = highTierConfig({ agent: { context: { maxFiles: 2, maxRetrievalCalls: 2 } } });
    const { meta } = await runReview(
      input(workspace(dir, "diff --git a/a.ts b/a.ts", [{ path: "a.ts", status: "modified" }])),
      { runtime, config },
    );
    expect(meta.retrieval.fulfilled).toBe(2);
    expect(meta.retrieval.rejected).toBe(1);
    expect(meta.retrieval.requested).toBe(3);
    expect(meta.retrieval.violations.join("\n")).toContain("budget exhausted");
    expect(meta.retrieval.bytesDelivered).toBeGreaterThan(0);
    await fsp.rm(dir, { recursive: true, force: true });
  });

  test("related-file bug: bug outside the diff is surfaced via the tool protocol", async () => {
    // The diff changes utils.ts (return shape: string → object). The buggy
    // caller lives in caller.ts — invisible in the diff, only visible through
    // a controlled read_file request.
    const dir = await makeWorkspaceDir({
      "src/utils.ts": "export function formatName(user: { name: string }) {\n  return { name: user.name };\n}\n",
      "src/caller.ts": 'import { formatName } from "./utils.js";\n\nconst label = formatName(user).toUpperCase();\n',
    });
    const diff = makeDiff([
      {
        path: "src/utils.ts",
        before: ["export function formatName(user: { name: string }) {", "  return user.name;", "}"],
        after: ["export function formatName(user: { name: string }) {", "  return { name: user.name }; // session", "}"],
      },
    ]);
    const runtime = new FakeRuntime();
    runtime.responders = [
      () =>
        analysisResponse({
          objective: "formatName now returns an object instead of a string",
          no_additional_context_needed: false,
          tool_requests: [{ tool: "read_file", path: "src/caller.ts" }],
        }),
      () =>
        reportingResponse({
          findings: [
            finding({
              title: "caller.ts breaks on new formatName return shape",
              file: "src/caller.ts",
              line: 3,
              confidence: 0.95,
              evidence: [
                {
                  file: "src/caller.ts",
                  line: 3,
                  excerpt: "const label = formatName(user).toUpperCase();",
                  reason: "toUpperCase does not exist on the new object return type",
                },
              ],
            }),
          ],
        }),
    ];
    const { result, meta } = await runReview(
      input(workspace(dir, diff, [{ path: "src/utils.ts", status: "modified" }])),
      { runtime, config: makeConfig() },
    );
    // The caller file content was delivered to the agent through the
    // controlled protocol only.
    expect(runtime.tasks[1]?.instruction).toContain("formatName(user).toUpperCase()");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.file).toBe("src/caller.ts");
    expect(result.findings[0]?.verified).toBe(true);
    expect(meta.retrieval.fulfilled).toBe(1);
    await fsp.rm(dir, { recursive: true, force: true });
  });

  test("engine rejects a workspace without a diff", async () => {
    const runtime = new FakeRuntime();
    runtime.responders = [];
    await expect(runReview(input(workspace("/tmp", "", [])), { runtime, config: makeConfig() })).rejects.toMatchObject({
      code: "empty_diff",
    });
    expect(runtime.started).toHaveLength(0); // no model call is ever made
    expect(runtime.terminated).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Misconfiguration
// ---------------------------------------------------------------------------

describe("engine errors", () => {
  test("ReviewEngineError carries a code", () => {
    const error = new ReviewEngineError("empty_diff", "no diff");
    expect(error.code).toBe("empty_diff");
    expect(error.name).toBe("ReviewEngineError");
  });
});
