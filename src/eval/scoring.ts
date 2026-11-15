/**
 * Benchmark scoring (ticket 12 — §19.2/§19.4). Pure functions, no I/O.
 *
 * Matching rule: a predicted finding matches an expected finding when
 * category AND file are equal and the predicted line is within the
 * expected finding's tolerance (default ±5 lines — models anchor to nearby
 * lines of the same defect). Each expected finding consumes at most one
 * predicted finding (greedy, closest line first) so duplicates inflate
 * precision only, never recall.
 */

import type { Finding } from "../modules/review/index.js";
import type { CaseScore, BenchmarkScore, ExpectedFinding } from "./types.js";

export const DEFAULT_LINE_TOLERANCE = 5;

interface Match {
  expectedIndex: number;
  expected: ExpectedFinding;
  predicted: Finding;
  lineDelta: number;
}

function matchFindings(predicted: Finding[], expected: ExpectedFinding[]): Match[] {
  const matches: Match[] = [];
  const usedPredicted = new Set<number>();

  const candidates: Array<{
    expectedIndex: number;
    predictedIndex: number;
    expected: ExpectedFinding;
    predicted: Finding;
    delta: number;
  }> = [];
  for (const [expectedIndex, exp] of expected.entries()) {
    for (const [predictedIndex, pred] of predicted.entries()) {
      if (usedPredicted.has(predictedIndex)) {
        continue;
      }
      if (pred.category !== exp.category || pred.file !== exp.file) {
        continue;
      }
      const tolerance = exp.lineTolerance ?? DEFAULT_LINE_TOLERANCE;
      const delta = Math.abs(pred.line - exp.line);
      if (delta <= tolerance) {
        candidates.push({ expectedIndex, predictedIndex, expected: exp, predicted: pred, delta });
      }
    }
  }
  // Greedy: closest line pairs first.
  candidates.sort((a, b) => a.delta - b.delta);
  for (const c of candidates) {
    if (usedPredicted.has(c.predictedIndex) || matches.some((m) => m.expectedIndex === c.expectedIndex)) {
      continue;
    }
    usedPredicted.add(c.predictedIndex);
    matches.push({
      expectedIndex: c.expectedIndex,
      expected: c.expected,
      predicted: c.predicted,
      lineDelta: c.delta,
    });
  }
  return matches;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

/** Score one review result against one benchmark case's expectations. */
export function scoreCase(
  caseId: string,
  result: { findings: Finding[]; uncertainFindings?: Finding[] },
  expected: ExpectedFinding[],
  latencyMs: number,
): CaseScore {
  const predicted = [...result.findings];
  const uncertain = result.uncertainFindings ?? [];

  if (expected.length === 0) {
    // Clean-PR / false-positive-trap case: everything predicted is a FP.
    const fp = predicted.length + uncertain.length;
    return {
      caseId,
      truePositives: 0,
      falsePositives: fp,
      falseNegatives: 0,
      precision: ratio(0, predicted.length + uncertain.length) === 1 ? 1 : 0,
      recall: 1,
      severityAccuracy: 1,
      lineAccuracy: 1,
      latencyMs,
      passed: fp === 0,
    };
  }

  const matches = matchFindings(predicted, expected);
  const tp = matches.length;
  const fp = predicted.length - tp;
  const fn = expected.length - tp;

  const severityMatches = matches.filter((m) => m.predicted.severity === m.expected.severity).length;
  const lineMatches = matches.filter((m) => m.lineDelta === 0).length;

  return {
    caseId,
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    precision: ratio(tp, tp + fp),
    recall: ratio(tp, tp + fn),
    severityAccuracy: ratio(severityMatches, matches.length),
    lineAccuracy: ratio(lineMatches, predicted.length),
    latencyMs,
    passed: fn === 0 && fp === 0,
  };
}

/** Nearest-rank percentile of a numeric list (null when empty). */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  // `p = 0` produces a negative index. `?? Number.NaN` keeps the historical
  // NaN result rather than substituting a made-up value.
  const value = sorted[index] ?? Number.NaN;
  return Math.max(0, Math.floor(value));
}

const WEIGHTS = { recall: 0.35, precision: 0.25, severity: 0.2, line: 0.2 } as const;

/**
 * Aggregate per-case scores into a suite score. `overall` weights recall
 * highest (missing a real bug is worse than a cautious duplicate), then
 * precision, then severity and line anchoring accuracy.
 */
export function aggregateScores(scores: CaseScore[], qualityThreshold: number): BenchmarkScore {
  const sum = (pick: (s: CaseScore) => number): number => scores.reduce((acc, s) => acc + pick(s), 0);

  const counts = {
    totalCases: scores.length,
    passedCases: scores.filter((s) => s.passed).length,
    truePositives: sum((s) => s.truePositives),
    falsePositives: sum((s) => s.falsePositives),
    falseNegatives: sum((s) => s.falseNegatives),
  };

  const precision = ratio(counts.truePositives, counts.truePositives + counts.falsePositives);
  const recall = ratio(counts.truePositives, counts.truePositives + counts.falseNegatives);
  const severityAccuracy = scores.length === 0 ? 1 : sum((s) => s.severityAccuracy) / scores.length;
  const lineAccuracy = scores.length === 0 ? 1 : sum((s) => s.lineAccuracy) / scores.length;

  const latencies = scores.map((s) => s.latencyMs).filter((n) => Number.isFinite(n));
  const overall =
    WEIGHTS.recall * recall +
    WEIGHTS.precision * precision +
    WEIGHTS.severity * severityAccuracy +
    WEIGHTS.line * lineAccuracy;

  return {
    ...counts,
    precision,
    recall,
    severityAccuracy,
    lineAccuracy,
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
    overall,
    passed: scores.length > 0 && overall >= qualityThreshold,
  };
}
