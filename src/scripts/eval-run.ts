/**
 * Benchmark evaluation CLI (ticket 12 — §19). Runs every benchmark suite in
 * `benchmarks/*.json` against the configured agent runtime, scores the
 * results, persists one EvaluationRun per suite (when PostgreSQL is
 * reachable) and applies the quality gate
 * (`evaluation.minimumQualityThreshold`, default 0.85).
 *
 * Usage:  npm run eval:run
 * Exit 1 when any suite fails the quality gate (CI blocking).
 *
 * Secrets are never printed: the report contains counts and scores only.
 */

import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { createAgentRuntime } from "../agent/index.js";
import { loadEnv } from "../config/env.js";
import { DEFAULT_CONFIG_PATH, loadReviewConfig } from "../config/review-loader.js";
import { configurationHashFrom, persistEvaluationRun } from "../eval/persistence.js";
import { runBenchmarkSuite } from "../eval/runner.js";
import type { BenchmarkSuite } from "../eval/types.js";
import { createLogger } from "../lib/logger.js";
import { getPrisma } from "../lib/prisma.js";
import { disconnectPrisma } from "../lib/prisma.js";

const BENCHMARKS_DIR = path.join(process.cwd(), "benchmarks");

async function loadSuites(dir: string): Promise<BenchmarkSuite[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const suites: BenchmarkSuite[] = [];
  for (const entry of entries.filter((f) => f.endsWith(".json")).sort()) {
    const raw = JSON.parse(await fs.readFile(path.join(dir, entry), "utf8")) as BenchmarkSuite;
    if (!raw?.id || !Array.isArray(raw.cases)) {
      throw new Error(`Invalid benchmark suite file: ${entry}`);
    }
    suites.push(raw);
  }
  return suites;
}

function printSuiteReport(suite: BenchmarkSuite, run: Awaited<ReturnType<typeof runBenchmarkSuite>>): void {
  const s = run.score;
  console.log(`\n=== ${suite.name} (v${suite.version}) ===`);
  console.log(
    `cases: ${s.passedCases}/${s.totalCases} passed · ` +
      `tp=${s.truePositives} fp=${s.falsePositives} fn=${s.falseNegatives}`,
  );
  console.log(
    `precision=${s.precision.toFixed(3)} recall=${s.recall.toFixed(3)} ` +
      `severity=${s.severityAccuracy.toFixed(3)} line=${s.lineAccuracy.toFixed(3)}`,
  );
  console.log(
    `latency p50=${s.latencyP50Ms ?? "-"}ms p95=${s.latencyP95Ms ?? "-"}ms · ` + `overall=${s.overall.toFixed(3)}`,
  );
  for (const c of run.cases) {
    const mark = c.score.passed ? "PASS" : "FAIL";
    console.log(
      `  [${mark}] ${c.caseId}: tp=${c.score.truePositives} fp=${c.score.falsePositives} ` +
        `fn=${c.score.falseNegatives} latency=${c.score.latencyMs}ms`,
    );
  }
}

async function main(): Promise<void> {
  const loaded = loadReviewConfig(DEFAULT_CONFIG_PATH);
  const config = loaded.config;
  const qualityThreshold = config.evaluation.minimumQualityThreshold;

  const suites = await loadSuites(BENCHMARKS_DIR);
  if (suites.length === 0) {
    console.error(`No benchmark suites found in ${BENCHMARKS_DIR}`);
    process.exitCode = 1;
    return;
  }

  const runtime = createAgentRuntime(config);
  const env = loadEnv();
  const logger = createLogger(env);

  let allPassed = true;
  for (const suite of suites) {
    const run = await runBenchmarkSuite(suite, {
      runtime,
      config,
      qualityThreshold,
    });
    printSuiteReport(suite, run);
    if (!run.score.passed) allPassed = false;

    // Persistence is best-effort: an offline run still prints its report.
    try {
      const prisma = getPrisma(env);
      const persisted = await persistEvaluationRun(
        prisma,
        run,
        {
          model: config.provider.model,
          provider: config.provider.type,
          runtime: config.agent.runtime.type,
          configurationHash: configurationHashFrom(config),
          promptVersion: null,
        },
        qualityThreshold,
      );
      console.log(`  persisted: EvaluationRun ${persisted.id} (passed=${persisted.passed})`);
    } catch (error) {
      logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "EvaluationRun persistence skipped (PostgreSQL unreachable?)",
      );
    }
  }

  console.log(
    allPassed
      ? `\nQUALITY GATE: PASS (threshold ${qualityThreshold})`
      : `\nQUALITY GATE: FAIL (threshold ${qualityThreshold})`,
  );
  process.exitCode = allPassed ? 0 : 1;
}

main()
  .catch((error: unknown) => {
    console.error(`eval:run failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => {
    void disconnectPrisma();
  });
