/**
 * Prisma adapter for benchmark evaluation runs.
 *
 * The evaluation tooling under `src/scripts/eval` builds a plain
 * `EvaluationRunRecord`; this repository is the only owner of the
 * `evaluation_runs` vendor types. It stores counts, scores and latencies only
 * — never repository content or secrets.
 */
import type { PrismaClient } from "@prisma/client";

export interface EvaluationRunCaseDetail {
  caseId: string;
  passed: boolean;
  tp: number;
  fp: number;
  fn: number;
  latencyMs: number;
}

export interface EvaluationRunDetails {
  durationMs: number;
  perCase: EvaluationRunCaseDetail[];
}

export interface EvaluationRunRecord {
  benchmarkVersion: string;
  benchmarkSuite: string;
  model: string;
  provider: string;
  runtime: string;
  configurationHash: string | null;
  promptVersion: string | null;
  completedAt: Date;
  totalCases: number;
  passedCases: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  severityAccuracy: number;
  lineAccuracy: number;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  overallScore: number;
  qualityThreshold: number;
  passed: boolean;
  details: EvaluationRunDetails;
}

export interface PersistedEvaluation {
  id: string;
  passed: boolean;
  overallScore: number;
  qualityThreshold: number;
}

export interface EvaluationRunRepository {
  persist(record: EvaluationRunRecord): Promise<PersistedEvaluation>;
}

export function createPrismaEvaluationRunRepository(prisma: PrismaClient): EvaluationRunRepository {
  return {
    async persist(record) {
      return prisma.evaluationRun.create({
        data: {
          benchmarkVersion: record.benchmarkVersion,
          benchmarkSuite: record.benchmarkSuite,
          model: record.model,
          provider: record.provider,
          runtime: record.runtime,
          configurationHash: record.configurationHash,
          promptVersion: record.promptVersion,
          completedAt: record.completedAt,
          totalCases: record.totalCases,
          passedCases: record.passedCases,
          truePositives: record.truePositives,
          falsePositives: record.falsePositives,
          falseNegatives: record.falseNegatives,
          precision: record.precision,
          recall: record.recall,
          severityAccuracy: record.severityAccuracy,
          lineAccuracy: record.lineAccuracy,
          latencyP50Ms: record.latencyP50Ms,
          latencyP95Ms: record.latencyP95Ms,
          overallScore: record.overallScore,
          qualityThreshold: record.qualityThreshold,
          passed: record.passed,
          details: {
            durationMs: record.details.durationMs,
            perCase: record.details.perCase.map((entry) => ({
              caseId: entry.caseId,
              passed: entry.passed,
              tp: entry.tp,
              fp: entry.fp,
              fn: entry.fn,
              latencyMs: entry.latencyMs,
            })),
          },
        },
        select: { id: true, passed: true, overallScore: true, qualityThreshold: true },
      });
    },
  };
}
