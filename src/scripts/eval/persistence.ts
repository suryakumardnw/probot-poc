/**
 * EvaluationRun persistence (ticket 12 — §19, §13.1).
 *
 * Writes one `evaluation_runs` row keyed by the full evaluation identity
 * (model / provider / runtime / configuration hash / prompt version /
 * benchmark version). Latencies and counts only — never repository content
 * or secrets.
 *
 * The vendor client lives in `src/platform/db`; this tooling maps the
 * benchmark run to the repository's plain record shape.
 */

import { createHash } from "node:crypto";
import type {
  EvaluationRunRecord,
  EvaluationRunRepository,
  PersistedEvaluation,
} from "../../platform/db/evaluation-run.repository.js";
import type { BenchmarkRun } from "./runner.js";

export type { PersistedEvaluation } from "../../platform/db/evaluation-run.repository.js";

export interface EvaluationIdentity {
  model: string;
  provider: string;
  runtime: string;
  configurationHash?: string | null;
  promptVersion?: string | null;
}

/** Deterministic config hash for the identity columns (no content stored). */
export function configurationHashFrom(config: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(config ?? null))
    .digest("hex")
    .slice(0, 16);
}

export async function persistEvaluationRun(
  repository: EvaluationRunRepository,
  run: BenchmarkRun,
  identity: EvaluationIdentity,
  qualityThreshold: number,
): Promise<PersistedEvaluation> {
  const record: EvaluationRunRecord = {
    benchmarkVersion: run.suite.version,
    benchmarkSuite: run.suite.id,
    model: identity.model,
    provider: identity.provider,
    runtime: identity.runtime,
    configurationHash: identity.configurationHash ?? null,
    promptVersion: identity.promptVersion ?? null,
    completedAt: new Date(),
    totalCases: run.score.totalCases,
    passedCases: run.score.passedCases,
    truePositives: run.score.truePositives,
    falsePositives: run.score.falsePositives,
    falseNegatives: run.score.falseNegatives,
    precision: run.score.precision,
    recall: run.score.recall,
    severityAccuracy: run.score.severityAccuracy,
    lineAccuracy: run.score.lineAccuracy,
    latencyP50Ms: run.score.latencyP50Ms,
    latencyP95Ms: run.score.latencyP95Ms,
    overallScore: run.score.overall,
    qualityThreshold,
    passed: run.score.passed,
    details: {
      durationMs: run.durationMs,
      perCase: run.cases.map((c) => ({
        caseId: c.caseId,
        passed: c.score.passed,
        tp: c.score.truePositives,
        fp: c.score.falsePositives,
        fn: c.score.falseNegatives,
        latencyMs: c.score.latencyMs,
      })),
    },
  };
  return repository.persist(record);
}
