/**
 * Benchmark evaluation tooling (ticket 12 — §13.1, §19).
 *
 * Public surface for the `npm run eval:run` CLI and the evaluation tests.
 */
export type {
  BenchmarkCase,
  BenchmarkChangedFile,
  BenchmarkFile,
  BenchmarkScore,
  BenchmarkSuite,
  CaseScore,
  ExpectedFinding,
} from "./types.js";
export { aggregateScores, DEFAULT_LINE_TOLERANCE, percentile, scoreCase } from "./scoring.js";
export { loadBenchmarkSuites } from "./suite-loader.js";
export {
  runBenchmarkCase,
  runBenchmarkSuite,
  synthesizeWorkspace,
  type BenchmarkExecutor,
  type BenchmarkRun,
  type BenchmarkRunCase,
} from "./runner.js";
export {
  configurationHashFrom,
  persistEvaluationRun,
  type EvaluationIdentity,
  type PersistedEvaluation,
} from "./persistence.js";
