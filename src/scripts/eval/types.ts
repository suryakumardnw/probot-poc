/**
 * Quality evaluation types (ticket 12 — §13.1, §19).
 *
 * A benchmark is a JSON fixture describing one review scenario: the files in
 * the synthetic workspace, the diff under review and the findings a competent
 * reviewer MUST surface (and, for false-positive traps and clean PRs, the
 * findings it must NOT raise). Scoring compares the engine output against the
 * expectations — the fixtures never contain secrets or repository content.
 *
 * The file contract lives in `src/contracts/evaluation.ts`; this module keeps
 * the public type surface plus the scoring output types.
 */

export type {
  BenchmarkCase,
  BenchmarkChangedFile,
  BenchmarkFile,
  BenchmarkSuite,
  ExpectedFinding,
} from "../../contracts/evaluation.js";

/** Per-case score (scoring.ts). */
export interface CaseScore {
  caseId: string;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  /** precision = tp / (tp + fp), 0..1 (1 when no predictions). */
  precision: number;
  /** recall = tp / (tp + fn), 0..1 (1 when no expectations). */
  recall: number;
  /** Matched findings whose severity equals the expected severity. */
  severityAccuracy: number;
  /** Predicted findings anchored within tolerance of an expected line. */
  lineAccuracy: number;
  latencyMs: number;
  passed: boolean;
}

/** Aggregated suite score (scoring.ts). */
export interface BenchmarkScore {
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
  /** Weighted overall score in [0, 1] (see scoring.ts). */
  overall: number;
  /** True when overall >= the configured quality threshold. */
  passed: boolean;
}
