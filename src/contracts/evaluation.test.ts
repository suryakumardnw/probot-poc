import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { benchmarkCaseSchema, benchmarkSuiteSchema, expectedFindingSchema } from "./evaluation.js";

/**
 * Contract tests for `benchmarks/*.json`. Every checked-in suite must parse
 * before the evaluation runner can execute it.
 */

function suite(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "unit-suite",
    name: "Unit suite",
    version: "1.0.0",
    cases: [
      {
        id: "case-1",
        name: "case 1",
        files: [{ path: "src/a.ts", content: "export const x = 1;\n" }],
        diff: "diff --git a/src/a.ts b/src/a.ts\n@@ -1,1 +1,1 @@\n+export const x = 1;\n",
        changedFiles: [{ path: "src/a.ts", status: "modified" }],
        expectedFindings: [],
      },
    ],
    ...overrides,
  };
}

describe("benchmarkSuiteSchema", () => {
  test("accepts a minimal suite", () => {
    const parsed = benchmarkSuiteSchema.parse(suite());

    expect(parsed.id).toBe("unit-suite");
    expect(parsed.cases[0]?.changedFiles[0]?.status).toBe("modified");
  });

  test("accepts optional description, expectClean and lineTolerance", () => {
    const parsed = benchmarkSuiteSchema.parse(
      suite({
        cases: [
          {
            id: "case-2",
            name: "case 2",
            description: "trap",
            files: [{ path: "test/a.test.ts", content: "" }],
            diff: "",
            changedFiles: [{ path: "test/a.test.ts", status: "added" }],
            expectedFindings: [
              { category: "security", severity: "high", file: "test/a.test.ts", line: 1, lineTolerance: 2 },
            ],
            expectClean: false,
          },
        ],
      }),
    );

    expect(parsed.cases[0]?.description).toBe("trap");
    expect(parsed.cases[0]?.expectClean).toBe(false);
    expect(parsed.cases[0]?.expectedFindings[0]?.lineTolerance).toBe(2);
  });

  test("rejects a suite without id or cases", () => {
    expect(benchmarkSuiteSchema.safeParse({ name: "x", version: "1", cases: [] }).success).toBe(false);
    expect(benchmarkSuiteSchema.safeParse({ id: "x", name: "x", version: "1" }).success).toBe(false);
    expect(benchmarkSuiteSchema.safeParse({ id: "x", name: "x", version: "1", cases: "nope" }).success).toBe(false);
  });

  test("rejects unknown keys so fixture typos fail the run", () => {
    expect(benchmarkSuiteSchema.safeParse(suite({ unexpected: true })).success).toBe(false);
    expect(
      benchmarkCaseSchema.safeParse({
        id: "c",
        name: "c",
        files: [],
        diff: "",
        changedFiles: [],
        expectedFindings: [],
        unexpected: true,
      }).success,
    ).toBe(false);
  });

  test("rejects an unknown changed-file status", () => {
    const base = benchmarkSuiteSchema.parse(suite());
    const invalid = {
      ...base,
      cases: base.cases.map((benchmarkCase) => ({
        ...benchmarkCase,
        changedFiles: [{ path: "a", status: "renamed" }],
      })),
    };

    expect(benchmarkSuiteSchema.safeParse(invalid).success).toBe(false);
  });

  test("rejects an unknown finding category or severity", () => {
    expect(expectedFindingSchema.safeParse({ category: "style", severity: "high", file: "a", line: 1 }).success).toBe(
      false,
    );
    expect(
      expectedFindingSchema.safeParse({ category: "security", severity: "blocker", file: "a", line: 1 }).success,
    ).toBe(false);
  });

  test("every checked-in benchmark suite parses", () => {
    const dir = path.join(process.cwd(), "benchmarks");
    const files = fs.readdirSync(dir).filter((file) => file.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const raw: unknown = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      const result = benchmarkSuiteSchema.safeParse(raw);
      expect(result.success, `${file}: ${result.success ? "" : result.error.message}`).toBe(true);
    }
  });
});
