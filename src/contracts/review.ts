/**
 * Zod schema for the structured review result (ARCHITECTURE.md §6, §7.1).
 *
 * This is the validation boundary between the model and the application: the
 * agent's JSON answer must parse against this schema or the review fails with
 * `invalid_output` (fail-immediately; no retries, no model switching).
 *
 * Invariants enforced here:
 * - Every finding carries at least one evidence reference (file + excerpt +
 *   why). The reviewer must never invent findings for a quota, and empty
 *   `findings` arrays are valid — a clean review is a legitimate outcome.
 * - Confidence is 0..1; category/severity come from the configured enums.
 */

import { z } from "zod";
import { FINDING_CATEGORIES } from "../modules/review/types.js";

const findingEvidenceSchema = z.object({
  file: z.string().min(1).max(512),
  // Models emit `null` (or 0) when they cannot pin an evidence line. Treat it
  // as "unspecified" rather than aborting the whole review: `excerpt` +
  // `reason` still anchor the evidence.
  line: z
    .number()
    .int()
    .min(0)
    .nullable()
    .optional()
    .transform((v) => (v === 0 ? undefined : (v ?? undefined))),
  excerpt: z.string().min(1).max(2_000),
  reason: z.string().min(1).max(2_000),
});

/**
 * Conventions are prompt context, never user-facing content. Models routinely
 * paste whole guideline paragraphs here, so an over-long entry is clamped
 * instead of failing the entire review (a 500-char Zod cap used to abort the
 * analysis stage with `invalid_output`).
 */
const MAX_CONVENTION_CHARS = 500;
const conventionSchema = z.string().transform((value) => {
  const trimmed = value.trim();
  return trimmed.length <= MAX_CONVENTION_CHARS ? trimmed : `${trimmed.slice(0, MAX_CONVENTION_CHARS - 1)}…`;
});

/** Optional string that the model may legitimately omit as `null`/empty. */
const optionalString = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((v) => {
      const trimmed = v?.trim();
      return trimmed ? trimmed : undefined;
    });

/** Finding category taxonomy, shared with the evaluation benchmark contract. */
export const findingCategorySchema = z.enum(FINDING_CATEGORIES);
export type FindingCategoryValue = z.infer<typeof findingCategorySchema>;

/** Finding severity taxonomy, shared with the evaluation benchmark contract. */
export const findingSeveritySchema = z.enum(["critical", "high", "medium", "low", "informational"]);
export type FindingSeverityValue = z.infer<typeof findingSeveritySchema>;

export const findingSchema = z.object({
  category: findingCategorySchema,
  severity: findingSeveritySchema,
  confidence: z.number().min(0).max(1),
  title: z.string().min(1).max(300),
  file: z.string().min(1).max(512),
  line: z.number().int().min(1),
  description: z.string().min(1).max(2_000),
  impact: optionalString(1_000),
  recommendation: optionalString(1_000),
  guideline: optionalString(300),
  evidence: z.array(findingEvidenceSchema).min(1, "every finding must carry at least one evidence reference"),
  verified: z
    .boolean()
    .nullish()
    .transform((v) => v ?? undefined),
});

export const reviewResultSchema = z.preprocess(
  (raw) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return raw;
    }
    const value = { ...(raw as Record<string, unknown>) };
    // The model is shown snake_case keys in the prompt template; accept both
    // spellings so the validation boundary stays strict on content, not casing.
    if ("uncertain_findings" in value) {
      value.uncertainFindings = value.uncertain_findings;
      delete value.uncertain_findings;
    }
    // Models sometimes omit or null an empty list. Normalize it to the
    // documented empty-array shape instead of failing the whole review.
    for (const key of ["findings", "uncertainFindings", "conventions"] as const) {
      if (value[key] === null || value[key] === undefined) {
        value[key] = [];
      }
    }
    // The engine already falls back to the analysis objective; accept a
    // missing/null summary rather than failing the whole review.
    if (value.summary === null || value.summary === undefined) {
      value.summary = "";
    }
    // schemaVersion is a constant in this protocol; normalize omission.
    if (value.schemaVersion === null || value.schemaVersion === undefined) {
      value.schemaVersion = 1;
    }
    return value;
  },
  z
    .object({
      schemaVersion: z.literal(1),
      /** Two-sentence verdict for developers; the full audit answer is in findings. */
      summary: z.string().max(4_000),
      /** Inline-eligible findings. An empty array is VALID (no invented quota). */
      findings: z.array(findingSchema),
      /** Low-confidence findings; published in the summary, never inline. */
      uncertainFindings: z.array(findingSchema).default([]),
      /** Detected project conventions relevant to this review (§6.5). */
      conventions: z.array(conventionSchema).default([]),
    })
    .strict(),
);

export type ParsedReviewResult = z.infer<typeof reviewResultSchema>;

/** Lenient schema for the analysis-stage answer (stage 1/2 combined call). */
export const analysisOutputSchema = z.preprocess(
  (input) => {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return input;
    }
    // Models occasionally answer an analysis stage with reporting-stage keys
    // (`summary`, `findings`, `uncertain_findings`). These are benign drift,
    // not a failure: fold the findings into the analysis list and keep the
    // report's summary as the objective when the model omitted one. Unknown
    // keys still fail the strict schema below.
    const value: Record<string, unknown> = { ...(input as Record<string, unknown>) };
    const preliminary = Array.isArray(value.preliminary_findings) ? [...(value.preliminary_findings as unknown[])] : [];
    for (const key of ["findings", "uncertain_findings"] as const) {
      const extra = value[key];
      if (Array.isArray(extra)) {
        preliminary.push(...extra);
      }
      delete value[key];
    }
    if (preliminary.length > 0) {
      value.preliminary_findings = preliminary;
    }
    if ((typeof value.objective !== "string" || value.objective.length === 0) && typeof value.summary === "string") {
      value.objective = value.summary;
    }
    delete value.summary;
    delete value.schemaVersion;
    return value;
  },
  z
    .object({
      objective: z.string().max(5_000).default(""),
      conventions: z.array(conventionSchema).default([]),
      /** Requests for additional repository context (controlled protocol). */
      tool_requests: z.array(z.unknown()).default([]),
      /** Preliminary findings; finalized (or dropped) by the reporting call. */
      preliminary_findings: z.array(z.unknown()).default([]),
      /** When true the agent claims the diff needs no additional context. */
      no_additional_context_needed: z.boolean().default(false),
    })
    .strict(),
);

export type ParsedAnalysisOutput = z.infer<typeof analysisOutputSchema>;
