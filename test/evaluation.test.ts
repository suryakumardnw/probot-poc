import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import type { ReviewConfig } from "../src/config/review-schema.js";
import { reviewConfigSchema } from "../src/config/review-schema.js";
import { configurationHashFrom, persistEvaluationRun } from "../src/eval/persistence.js";
import { runBenchmarkSuite } from "../src/eval/runner.js";
import { scoreCase, aggregateScores, percentile, DEFAULT_LINE_TOLERANCE } from "../src/eval/scoring.js";
import { loadBenchmarkSuites } from "../src/eval/suite-loader.js";
import type { BenchmarkCase, BenchmarkSuite, CaseScore } from "../src/eval/types.js";
import type { Finding, RunReviewOutput } from "../src/review-engine/types.js";
import { prisma, disconnectDatabase } from "./helpers/db.js";

/**
 * Ticket 12 unit/integration tests: benchmark scoring math, benchmark runner
 * behavior, EvaluationRun persistence and the quality threshold gate.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    category: "functional",
    severity: "high",
    confidence: 0.9,
    title: "t",
    file: "src/a.ts",
    line: 10,
    description: "d",
    evidence: [],
    verified: true,
    ...overrides,
  };
}

function expected(overrides: Partial<Parameters<typeof scoreCase>[2][number]> = {}) {
  return {
    category: "functional",
    severity: "high",
    file: "src/a.ts",
    line: 10,
    ...overrides,
  } as Parameters<typeof scoreCase>[2][number];
}

function caseScoreFrom(partial: Partial<CaseScore>): CaseScore {
  return {
    caseId: "c",
    truePositives: 0,
    falsePositives: 0,
    falseNegatives: 0,
    precision: 1,
    recall: 1,
    severityAccuracy: 1,
    lineAccuracy: 1,
    latencyMs: 10,
    passed: true,
    ...partial,
  };
}

function benchmarkCase(overrides: Partial<BenchmarkCase> = {}): BenchmarkCase {
  return {
    id: "case-1",
    name: "case 1",
    files: [{ path: "src/a.ts", content: "export const x = 1;\n" }],
    diff: "diff --git a/src/a.ts b/src/a.ts\n@@ -1,1 +1,1 @@\n+export const x = 1;\n",
    changedFiles: [{ path: "src/a.ts", status: "modified" }],
    expectedFindings: [],
    ...overrides,
  };
}

function suiteOf(cases: BenchmarkCase[]): BenchmarkSuite {
  return { id: "unit-suite", name: "Unit suite", version: "1.0.0", cases };
}

// ---------------------------------------------------------------------------
// Suite loading (§19 fixture contract)
// ---------------------------------------------------------------------------

describe("loadBenchmarkSuites", () => {
  test("loads every checked-in benchmark suite", async () => {
    const suites = await loadBenchmarkSuites(path.join(process.cwd(), "benchmarks"));

    expect(suites.length).toBeGreaterThan(0);
    expect(suites.map((suite) => suite.id)).toContain("security");
    expect(suites.every((suite) => suite.cases.length > 0)).toBe(true);
  });

  test("returns an empty list when the directory is absent", async () => {
    await expect(loadBenchmarkSuites(path.join(process.cwd(), "benchmarks-missing"))).resolves.toEqual([]);
  });

  test("rejects malformed JSON and contract drift with the file name", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eval-suites-"));
    try {
      await fs.writeFile(path.join(dir, "broken.json"), "{ not json", "utf8");
      await expect(loadBenchmarkSuites(dir)).rejects.toThrow(
        "Invalid benchmark suite file: broken.json (not valid JSON)",
      );

      await fs.writeFile(
        path.join(dir, "broken.json"),
        JSON.stringify({ id: "x", name: "x", version: "1.0.0", cases: [{ id: "c" }] }),
        "utf8",
      );
      await expect(loadBenchmarkSuites(dir)).rejects.toThrow(/Invalid benchmark suite file: broken\.json \(cases\.0/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Scoring math (§19.2)
// ---------------------------------------------------------------------------

describe("scoreCase", () => {
  test("matches by category + file within the line tolerance", () => {
    const score = scoreCase("c", { findings: [finding({ line: 14 })] }, [expected({ line: 10 })], 42);
    expect(DEFAULT_LINE_TOLERANCE).toBe(5);
    expect(score.truePositives).toBe(1);
    expect(score.falsePositives).toBe(0);
    expect(score.falseNegatives).toBe(0);
    expect(score.precision).toBe(1);
    expect(score.recall).toBe(1);
    expect(score.latencyMs).toBe(42);
    expect(score.passed).toBe(true);
  });

  test("misses beyond the tolerance count as false negatives", () => {
    const score = scoreCase("c", { findings: [finding({ line: 50 })] }, [expected({ line: 10 })], 1);
    expect(score.truePositives).toBe(0);
    expect(score.falseNegatives).toBe(1);
    expect(score.recall).toBe(0);
    expect(score.passed).toBe(false);
  });

  test("category or file mismatch is never a match", () => {
    const score = scoreCase(
      "c",
      { findings: [finding({ category: "security", line: 10 }), finding({ file: "src/b.ts", line: 10 })] },
      [expected({ line: 10 })],
      1,
    );
    expect(score.truePositives).toBe(0);
    expect(score.falsePositives).toBe(2);
    expect(score.falseNegatives).toBe(1);
  });

  test("severity accuracy and line accuracy are measured on matches", () => {
    const score = scoreCase(
      "c",
      { findings: [finding({ severity: "critical", line: 10 })] },
      [expected({ severity: "high", line: 10 })],
      1,
    );
    expect(score.truePositives).toBe(1);
    expect(score.severityAccuracy).toBe(0);
    expect(score.lineAccuracy).toBe(1);
  });

  test("duplicate predictions inflate precision only, never recall", () => {
    const score = scoreCase(
      "c",
      { findings: [finding({ line: 10 }), finding({ line: 11 }), finding({ line: 12 })] },
      [expected({ line: 10 })],
      1,
    );
    expect(score.truePositives).toBe(1);
    expect(score.falsePositives).toBe(2);
    expect(score.recall).toBe(1);
    expect(score.precision).toBeCloseTo(1 / 3);
  });

  test("clean-PR cases score every prediction as a false positive", () => {
    const clean = scoreCase("c", { findings: [], uncertainFindings: [] }, [], 5);
    expect(clean.passed).toBe(true);
    expect(clean.precision).toBe(1);
    expect(clean.recall).toBe(1);

    const fp = scoreCase("c", { findings: [finding()], uncertainFindings: [finding()] }, [], 5);
    expect(fp.falsePositives).toBe(2);
    expect(fp.passed).toBe(false);
  });

  test("uncertain findings count as false positives on clean cases", () => {
    const fp = scoreCase("c", { findings: [], uncertainFindings: [finding()] }, [], 5);
    expect(fp.falsePositives).toBe(1);
    expect(fp.passed).toBe(false);
  });
});

describe("aggregateScores", () => {
  test("percentile uses the nearest-rank method", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([100, 10, 40], 50)).toBe(40);
    expect(percentile([10, 20, 30, 40], 95)).toBe(40);
  });

  test("aggregates with weighted overall (0.35 recall + 0.25 precision + 0.2 severity + 0.2 line)", () => {
    const score = aggregateScores(
      [caseScoreFrom({ precision: 1, recall: 1, severityAccuracy: 1, lineAccuracy: 1, latencyMs: 100 })],
      0.85,
    );
    expect(score.overall).toBe(1);
    expect(score.totalCases).toBe(1);
    expect(score.passedCases).toBe(1);
    expect(score.latencyP50Ms).toBe(100);
    expect(score.passed).toBe(true);
  });

  test("quality gate fails below the configured threshold", () => {
    const failing = aggregateScores(
      [caseScoreFrom({ truePositives: 0, falseNegatives: 1, recall: 0, precision: 0, passed: false })],
      0.85,
    );
    expect(failing.recall).toBe(0);
    expect(failing.overall).toBeLessThan(0.85);
    expect(failing.passed).toBe(false);
  });

  test("threshold comparison is inclusive at the boundary", () => {
    const score = aggregateScores(
      [caseScoreFrom({ precision: 1, recall: 1, severityAccuracy: 1, lineAccuracy: 1 })],
      1,
    );
    expect(score.overall).toBe(1);
    expect(score.passed).toBe(true);
  });

  test("counts true/false positives and negatives across cases", () => {
    const score = aggregateScores(
      [
        caseScoreFrom({
          truePositives: 2,
          falsePositives: 1,
          falseNegatives: 0,
          recall: 1,
          precision: 2 / 3,
          passed: false,
        }),
        caseScoreFrom({
          truePositives: 0,
          falsePositives: 0,
          falseNegatives: 2,
          recall: 0,
          precision: 1,
          passed: false,
        }),
      ],
      0.85,
    );
    expect(score.truePositives).toBe(2);
    expect(score.falsePositives).toBe(1);
    expect(score.falseNegatives).toBe(2);
    expect(score.precision).toBeCloseTo(2 / 3);
    expect(score.recall).toBeCloseTo(0.5);
  });
});

// ---------------------------------------------------------------------------
// Benchmark runner (§19.1)
// ---------------------------------------------------------------------------

function outputFor(
  result: Partial<{ findings: Finding[]; uncertainFindings: Finding[]; summary: string }>,
): RunReviewOutput {
  return {
    result: {
      schemaVersion: 1,
      summary: result.summary ?? "ok",
      findings: result.findings ?? [],
      uncertainFindings: result.uncertainFindings ?? [],
      conventions: [],
    },
    meta: {
      plan: {
        complexity: { score: 0, tier: "low", factors: [] },
        tier: "low",
        stages: [],
        budgets: { maxModelCalls: 0, maxFileRetrievals: 0, maxInputTokens: 0, maxOutputTokens: 0, timeoutMs: 0 },
      },
      usage: { modelCalls: [], totalInputTokens: 0, totalOutputTokens: 0, durationMs: 0 },
      retrieval: { requested: 0, fulfilled: 0, rejected: 0, bytesDelivered: 0, violations: [] },
      skippedStages: [],
    },
  };
}

function fakeDeps(qualityThreshold = 0.85) {
  const config: ReviewConfig = reviewConfigSchema.parse({
    schemaVersion: 1,
    github: { organization: "fixture-org" },
    provider: {
      baseURL: "https://llm.example.test/compat",
      apiKeyEnv: "MODEL_API_KEY",
      model: "workers-ai/@cf/zai-org/glm-4.7-flash",
    },
  });
  return {
    runtime: {} as never,
    config,
    qualityThreshold,
  };
}

describe("runBenchmarkSuite", () => {
  test("scores every case and materializes a real workspace", async () => {
    const suite = suiteOf([
      benchmarkCase({
        id: "hit",
        expectedFindings: [expected({ line: 1, file: "src/a.ts" })],
        files: [{ path: "src/a.ts", content: "export const x = 1;\n" }],
      }),
      benchmarkCase({ id: "clean", expectedFindings: [], expectClean: true }),
    ]);

    const seenWorkspaces: string[] = [];
    const run = await runBenchmarkSuite(suite, fakeDeps(), async ({ case: benchCase, workspace }) => {
      seenWorkspaces.push(workspace.workspacePath);
      if (benchCase.expectClean) {
        return outputFor({});
      }
      return outputFor({ findings: [finding({ line: 1, file: "src/a.ts" })] });
    });

    expect(run.cases).toHaveLength(2);
    expect(run.score.totalCases).toBe(2);
    expect(run.score.truePositives).toBe(1);
    expect(run.score.passedCases).toBe(2);
    expect(run.score.passed).toBe(true);
    expect(run.durationMs).toBeGreaterThanOrEqual(0);
    // A synthetic workspace was materialized per case (then cleaned up).
    expect(seenWorkspaces).toHaveLength(2);
    expect(new Set(seenWorkspaces).size).toBe(2);
    for (const dir of seenWorkspaces) {
      expect(
        await fs.stat(dir).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
    }
  });

  test("a crashing case is scored as a total miss, not thrown away", async () => {
    const suite = suiteOf([benchmarkCase({ id: "boom", expectedFindings: [expected()] })]);
    const run = await runBenchmarkSuite(suite, fakeDeps(), async () => {
      throw new Error("engine exploded");
    });
    expect(run.cases).toHaveLength(1);
    expect(run.cases[0].score.truePositives).toBe(0);
    expect(run.cases[0].score.falseNegatives).toBe(1);
    expect(run.score.recall).toBe(0);
    expect(run.score.passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Persistence + quality gate (§13.1, §19.4)
// ---------------------------------------------------------------------------

process.env.DATABASE_URL ??= "postgres://postgres:postgres@localhost:5432/reviewer";

describe("evaluation persistence", () => {
  const createdIds: string[] = [];

  afterAll(async () => {
    await prisma.evaluationRun.deleteMany({ where: { id: { in: createdIds } } }).catch(() => {});
    await disconnectDatabase();
  });

  beforeEach(() => {
    createdIds.length = 0;
  });

  test("configurationHashFrom is deterministic and content-derived", () => {
    const a = configurationHashFrom({ model: "x" });
    const b = configurationHashFrom({ model: "x" });
    const c = configurationHashFrom({ model: "y" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toHaveLength(16);
  });

  test("persists one EvaluationRun per suite with the full evaluation identity", async () => {
    const suite = suiteOf([
      benchmarkCase({
        id: "persist-hit",
        expectedFindings: [expected({ line: 1, file: "src/a.ts" })],
      }),
    ]);
    const run = await runBenchmarkSuite(suite, fakeDeps(0.85), async () =>
      outputFor({ findings: [finding({ line: 1, file: "src/a.ts" })] }),
    );

    const persisted = await persistEvaluationRun(
      prisma,
      run,
      {
        model: "glm-4.7-flash",
        provider: "openai-compat",
        runtime: "opencode",
        configurationHash: configurationHashFrom({ model: "glm-4.7-flash" }),
        promptVersion: null,
      },
      0.85,
    );
    createdIds.push(persisted.id);

    expect(persisted.passed).toBe(true);
    expect(persisted.qualityThreshold).toBe(0.85);
    expect(persisted.overallScore).toBeGreaterThan(0);

    const row = await prisma.evaluationRun.findUnique({ where: { id: persisted.id } });
    expect(row).not.toBeNull();
    expect(row?.benchmarkSuite).toBe("unit-suite");
    expect(row?.benchmarkVersion).toBe("1.0.0");
    expect(row?.model).toBe("glm-4.7-flash");
    expect(row?.provider).toBe("openai-compat");
    expect(row?.runtime).toBe("opencode");
    expect(row?.totalCases).toBe(1);
    expect(row?.truePositives).toBe(1);
    expect(row?.falseNegatives).toBe(0);
    expect(row?.passed).toBe(true);
    // No repository content is stored — only counts and scores.
    expect(JSON.stringify(row?.details)).not.toContain("src/a.ts");
  });

  test("gate-failing runs are persisted with passed=false", async () => {
    const suite = suiteOf([benchmarkCase({ id: "persist-miss", expectedFindings: [expected()] })]);
    const run = await runBenchmarkSuite(suite, fakeDeps(0.85), async () => outputFor({}));

    const persisted = await persistEvaluationRun(
      prisma,
      run,
      { model: "glm-4.7-flash", provider: "openai-compat", runtime: "opencode" },
      0.85,
    );
    createdIds.push(persisted.id);

    expect(persisted.passed).toBe(false);
    const row = await prisma.evaluationRun.findUnique({ where: { id: persisted.id } });
    expect(row?.passed).toBe(false);
    expect(row?.recall).toBe(0);
  });
});
