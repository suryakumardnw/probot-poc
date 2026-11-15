/**
 * Benchmark runner (ticket 12 — §19.1). For every benchmark case a synthetic
 * workspace is materialized in a temporary directory (the same shape
 * `ReviewWorkspaceService.prepare` produces), then `runReview` executes with
 * the injected AgentRuntime. The default executor is the real engine; tests
 * and offline runs inject a scripted runtime instead.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentRuntime } from "../agent/types.js";
import type { ReviewConfig } from "../config/review-schema.js";
import { runReview, type RunReviewOutput } from "../modules/review/index.js";
import type { WorkspaceResult } from "../modules/workspace/index.js";
import { aggregateScores, scoreCase } from "./scoring.js";
import type { BenchmarkCase, BenchmarkSuite, CaseScore, BenchmarkScore } from "./types.js";

export type BenchmarkExecutor = (
  input: { reviewId: string; workspace: WorkspaceResult; case: BenchmarkCase },
  deps: { runtime: AgentRuntime; config: ReviewConfig },
) => Promise<RunReviewOutput>;

export interface BenchmarkRunCase {
  suiteId: string;
  caseId: string;
  output: RunReviewOutput;
  score: CaseScore;
}

export interface BenchmarkRun {
  suite: BenchmarkSuite;
  cases: BenchmarkRunCase[];
  score: BenchmarkScore;
  /** Wall-clock duration of the whole run. */
  durationMs: number;
}

/** Materialize the case's files into a fresh temporary directory. */
export async function synthesizeWorkspace(caseDef: BenchmarkCase): Promise<{
  workspace: WorkspaceResult;
  cleanup: () => Promise<void>;
}> {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "eval-case-"));
  for (const file of caseDef.files) {
    const abs = path.join(workspacePath, file.path);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, file.content, "utf8");
  }
  const workspace: WorkspaceResult = {
    workspacePath,
    headSha: "bench-head",
    baseSha: "bench-base",
    mergeBaseSha: "bench-merge-base",
    diff: caseDef.diff,
    changedFiles: caseDef.changedFiles,
  };
  return {
    workspace,
    cleanup: () => fs.rm(workspacePath, { recursive: true, force: true }),
  };
}

export async function runBenchmarkCase(
  suite: BenchmarkSuite,
  caseDef: BenchmarkCase,
  deps: { runtime: AgentRuntime; config: ReviewConfig },
  executor: BenchmarkExecutor = runReview,
): Promise<BenchmarkRunCase> {
  const { workspace, cleanup } = await synthesizeWorkspace(caseDef);
  const started = Date.now();
  try {
    const output = await executor({ reviewId: `eval-${caseDef.id}`, workspace, case: caseDef }, deps);
    const score = scoreCase(caseDef.id, output.result, caseDef.expectedFindings, Date.now() - started);
    return { suiteId: suite.id, caseId: caseDef.id, output, score };
  } finally {
    await cleanup();
  }
}

/**
 * Run a full benchmark suite. Never throws per-case: a crashing case is
 * scored as a total miss (0 matches, all expectations as false negatives) so
 * one bad fixture cannot hide a regression.
 */
export async function runBenchmarkSuite(
  suite: BenchmarkSuite,
  deps: { runtime: AgentRuntime; config: ReviewConfig; qualityThreshold: number },
  executor: BenchmarkExecutor = runReview,
): Promise<BenchmarkRun> {
  const started = Date.now();
  const cases: BenchmarkRunCase[] = [];
  for (const caseDef of suite.cases) {
    try {
      cases.push(await runBenchmarkCase(suite, caseDef, deps, executor));
    } catch {
      cases.push({
        suiteId: suite.id,
        caseId: caseDef.id,
        output: {
          result: { schemaVersion: 1, summary: "", findings: [], uncertainFindings: [], conventions: [] },
          meta: {
            plan: {
              complexity: { score: 0, tier: "low", factors: [] },
              tier: "low",
              stages: [],
              budgets: {
                maxModelCalls: 0,
                maxFileRetrievals: 0,
                maxInputTokens: 0,
                maxOutputTokens: 0,
                timeoutMs: 0,
              },
            },
            usage: { modelCalls: [], totalInputTokens: 0, totalOutputTokens: 0, durationMs: 0 },
            retrieval: { requested: 0, fulfilled: 0, rejected: 0, bytesDelivered: 0, violations: [] },
            skippedStages: [],
          },
        },
        score: scoreCase(caseDef.id, { findings: [], uncertainFindings: [] }, caseDef.expectedFindings, 0),
      });
    }
  }
  const score = aggregateScores(
    cases.map((c) => c.score),
    deps.qualityThreshold,
  );
  return { suite, cases, score, durationMs: Date.now() - started };
}
