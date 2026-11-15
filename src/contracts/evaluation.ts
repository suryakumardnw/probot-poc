import { z } from "zod";
import { findingCategorySchema, findingSeveritySchema } from "./review.js";

/**
 * Benchmark suite file contract (`benchmarks/*.json`, ticket 12 — §19).
 *
 * A suite is authored test data, not runtime input, so the schemas are strict:
 * an unknown key is a typo in a fixture and should fail the evaluation run
 * before any case executes. Scoring types (`CaseScore`, `BenchmarkScore`) stay
 * in `src/eval/types.ts` because they are outputs, not file contracts.
 *
 * This module is a contract only: it imports Zod and the review taxonomy.
 */

/** One synthetic workspace file materialized for a case. */
export const benchmarkFileSchema = z
  .object({
    /** Workspace-relative path. */
    path: z.string().min(1),
    content: z.string(),
  })
  .strict();
export type BenchmarkFile = z.infer<typeof benchmarkFileSchema>;

/** A finding a competent reviewer must surface. */
export const expectedFindingSchema = z
  .object({
    category: findingCategorySchema,
    severity: findingSeveritySchema,
    file: z.string().min(1),
    /** 1-based line the finding should anchor to. */
    line: z.number().int().min(1),
    /** Allowed |predicted - expected| deviation. Default 5 (§19.2). */
    lineTolerance: z.number().int().min(0).optional(),
  })
  .strict();
export type ExpectedFinding = z.infer<typeof expectedFindingSchema>;

/** One changed file in the synthetic diff. */
export const benchmarkChangedFileSchema = z
  .object({
    path: z.string().min(1),
    status: z.enum(["added", "modified", "deleted"]),
  })
  .strict();
export type BenchmarkChangedFile = z.infer<typeof benchmarkChangedFileSchema>;

/** One benchmark scenario. */
export const benchmarkCaseSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    files: z.array(benchmarkFileSchema),
    diff: z.string(),
    changedFiles: z.array(benchmarkChangedFileSchema),
    /** Findings the reviewer must surface (recall). */
    expectedFindings: z.array(expectedFindingSchema),
    /**
     * Clean-PR / false-positive-trap case: true when NO inline finding is
     * acceptable — any predicted finding counts as a false positive.
     */
    expectClean: z.boolean().optional(),
  })
  .strict();
export type BenchmarkCase = z.infer<typeof benchmarkCaseSchema>;

/** A complete benchmark suite file. */
export const benchmarkSuiteSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    /** Benchmark version — part of the EvaluationRun identity (§19). */
    version: z.string().min(1),
    cases: z.array(benchmarkCaseSchema),
  })
  .strict();
export type BenchmarkSuite = z.infer<typeof benchmarkSuiteSchema>;
