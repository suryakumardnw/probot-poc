import fs from "node:fs/promises";
import path from "node:path";
import { benchmarkSuiteSchema, type BenchmarkSuite } from "../../contracts/evaluation.js";

/**
 * Benchmark suite loader. Every JSON file in the directory is parsed against
 * the suite contract before the evaluation runner sees it. A malformed file
 * fails the run with the file name and issue paths — values from the fixture
 * are never echoed.
 */
export async function loadBenchmarkSuites(dir: string): Promise<BenchmarkSuite[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const suites: BenchmarkSuite[] = [];
  for (const entry of entries.filter((file) => file.endsWith(".json")).sort()) {
    const text = await fs.readFile(path.join(dir, entry), "utf8");
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new Error(`Invalid benchmark suite file: ${entry} (not valid JSON)`);
    }
    const parsed = benchmarkSuiteSchema.safeParse(raw);
    if (!parsed.success) {
      const details = parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      throw new Error(`Invalid benchmark suite file: ${entry} (${details})`);
    }
    suites.push(parsed.data);
  }
  return suites;
}
