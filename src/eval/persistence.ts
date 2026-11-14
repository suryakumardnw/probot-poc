/**
 * EvaluationRun persistence (ticket 12 — §19, §13.1).
 *
 * Writes one `evaluation_runs` row keyed by the full evaluation identity
 * (model / provider / runtime / configuration hash / prompt version /
 * benchmark version). Latencies and counts only — never repository content
 * or secrets.
 */

import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { BenchmarkRun } from "./runner.js";

export interface EvaluationIdentity {
  model: string;
  provider: string;
  runtime: string;
  configurationHash?: string | null;
  promptVersion?: string | null;
}

export interface PersistedEvaluation {
  id: string;
  passed: boolean;
  overallScore: number;
  qualityThreshold: number;
}

/** Deterministic config hash for the identity columns (no content stored). */
export function configurationHashFrom(config: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(config ?? null))
    .digest("hex")
    .slice(0, 16);
}

export async function persistEvaluationRun(
  prisma: PrismaClient,
  run: BenchmarkRun,
  identity: EvaluationIdentity,
  qualityThreshold: number,
): Promise<PersistedEvaluation> {
  const row = await prisma.evaluationRun.create({
    data: {
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
    },
    select: { id: true, passed: true, overallScore: true, qualityThreshold: true },
  });
  return row;
}
