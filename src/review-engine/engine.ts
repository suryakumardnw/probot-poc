/**
 * Adaptive repository-aware review engine (ARCHITECTURE.md §5.2–§5.4, §6).
 *
 * Drives the staged review over the `AgentRuntime` abstraction (ticket 06):
 *
 *   1. initial analysis       — diff understanding, risk detection, planning
 *   2. context investigation  — controlled tool-request protocol (only when
 *                               the planner enabled the stage)
 *   3. finding verification   — findings rechecked against retrieved source
 *   4. reporting preparation  — validated structured ReviewResult
 *
 * Call structure (adaptivity §6.1):
 * - low tier:  ≤2 calls (analysis; merged investigation+reporting when the
 *              agent requests context, otherwise a plain reporting call).
 * - higher tiers: analysis, optional investigation rounds, then a separate
 *   reporting/verification call — all capped by the plan's maxModelCalls.
 *
 * Hard guarantees:
 * - The agent never touches the filesystem or network directly; all
 *   repository access flows through the controlled tool-request protocol
 *   (path-safe resolvers, retrieval budget, size limits).
 * - Fail-immediately: any AgentRuntimeError (including schema-invalid model
 *   output) propagates and fails the review. No retries, no model switching.
 * - Budgets (model calls, retrievals, tokens) are enforced by the engine;
 *   the agent cannot raise them.
 * - No finding quota: an empty `findings` array is a valid outcome; findings
 *   without support are demoted to uncertain, never padded.
 * - `verified` on every finding is derived by the engine from the configured
 *   confidence thresholds, never trusted from the model.
 */

import fs from "node:fs";
import path from "node:path";
import type { AgentRuntime, AgentSession, AgentTask } from "../agent/types.js";
import type { ReviewConfig } from "../config/review-schema.js";
import { scoreComplexity } from "./complexity.js";
import { createReviewPlan, skippedStageIds } from "./plan.js";
import {
  RetrievalBudget,
  fulfillToolRequests,
  parseToolRequests,
  renderToolContext,
  type ToolResult,
} from "./tools.js";
import { analysisOutputSchema, findingSchema, reviewResultSchema } from "./result-schema.js";
import { ReviewEngineError } from "./types.js";
import type {
  Finding,
  ModelCallUsage,
  PromptInjection,
  ReviewInput,
  ReviewResult,
  RetrievalUsage,
  RunReviewOutput,
} from "./types.js";
import type { ParsedAnalysisOutput } from "./result-schema.js";
import {
  COMMON_REVIEW_INSTRUCTIONS,
  CONVENTIONS_INSTRUCTIONS,
  HANDBOOK_MODE_INSTRUCTIONS,
} from "./prompts/index.js";

/** Diff characters delivered in the initial-analysis instruction. */
const MAX_DIFF_CHARS = 30_000;
/** Character budget for accumulated tool context inside later instructions. */
const MAX_TOOL_CONTEXT_CHARS = 48_000;

function truncate(text: string, max: number, note: string): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n${note}`;
}

// The security/scope rules live in the shared trusted instruction profile
// (src/review-engine/prompts/common.ts) so standard, skill and handbook
// reviews are all composed from the same base (§4.1).
const COMMON_RULES = COMMON_REVIEW_INSTRUCTIONS;
const CONVENTIONS_BLOCK = CONVENTIONS_INSTRUCTIONS;

const REVIEW_RESULT_FORMAT = `
Answer with ONE JSON object exactly in this shape (no extra keys):
{
  "schemaVersion": 1,
  "summary": "PR overview + what was checked",
  "findings": [
    {
      "category": "functional|regression|security|performance|concurrency|dataIntegrity|errorHandling|apiCompatibility|maintainability|testing",
      "severity": "critical|high|medium|low|informational",
      "confidence": 0.0,
      "title": "short title",
      "file": "workspace-relative path",
      "line": 1,
      "description": "what is wrong and why it matters",
      "evidence": [ { "file": "...", "line": 1, "excerpt": "verbatim code", "reason": "why this supports the finding" } ],
      "verified": true
    }
  ],
  "uncertain_findings": [ ...same shape... ],
  "conventions": ["observed project conventions relevant to this review"]
}
"findings" = high-confidence findings, "uncertain_findings" = findings you
could not fully verify. An empty "findings" array is a valid, expected
outcome when the change is correct.
`.trim();

interface EngineDeps {
  runtime: AgentRuntime;
  config: ReviewConfig;
}

interface TokenAccounting {
  inputTokens: number;
  outputTokens: number;
  calls: ModelCallUsage[];
}

/** File exists inside the workspace (path-safe)? Used to demote unverifiable findings. */
function fileExistsInWorkspace(workspacePath: string, relativePath: string): boolean {
  try {
    const root = path.resolve(workspacePath);
    const resolved = path.resolve(root, relativePath);
    if (!resolved.startsWith(root + path.sep)) return false;
    return fs.statSync(resolved).isFile();
  } catch {
    return false;
  }
}

/**
 * Deterministic post-processing owned by the engine (never the model):
 * dedupe, filter by configured categories/severities, split findings vs
 * uncertain by the configured confidence thresholds, and derive `verified`.
 */
export function normalizeFindings(
  raw: Finding[],
  config: ReviewConfig,
): { findings: Finding[]; uncertainFindings: Finding[] } {
  const seen = new Set<string>();
  const deduped: Finding[] = [];
  for (const finding of raw) {
    const key = `${finding.file}::${finding.category}::${finding.title.trim().toLowerCase()}`;
    if (config.review.findings.deduplication && seen.has(key)) continue;
    seen.add(key);
    if (!config.review.severity.includes(finding.severity)) continue;
    if (config.review.categories[finding.category] === false) continue;
    deduped.push({ ...finding, verified: finding.confidence >= config.review.confidence.minimumVerified });
  }
  const findings = deduped.filter((f) => f.confidence >= config.review.confidence.minimumInline);
  const uncertainFindings = deduped.filter((f) => f.confidence < config.review.confidence.minimumInline);
  return { findings, uncertainFindings };
}

/**
 * Run the full adaptive review for one prepared workspace.
 *
 * Throws AgentRuntimeError on runtime/provider failure or schema-invalid
 * output; ReviewEngineError on engine misconfiguration. Both fail the review
 * immediately (the caller transitions the review to `failed`).
 */
export async function runReview(input: ReviewInput, deps: EngineDeps): Promise<RunReviewOutput> {
  const startedAt = Date.now();
  const { workspace, reviewId } = input;
  const config = deps.config;

  // A workspace without a diff is a deterministic engine error, never a
  // model call (the agent has nothing to review).
  assertWorkspaceReviewable(workspace);

  const complexity = scoreComplexity(workspace, config);
  const plan = createReviewPlan(complexity, config);

  const session = await deps.runtime.startSession({
    reviewId,
    workspacePath: workspace.workspacePath,
    timeoutMs: plan.budgets.timeoutMs,
    maxOutputTokens: plan.budgets.maxOutputTokens,
    traceCorrelation: input.correlation,
    context: {
      maxFiles: plan.budgets.maxFileRetrievals,
      maxRetrievalCalls: plan.budgets.maxModelCalls,
      maxInputTokens: plan.budgets.maxInputTokens,
      maxOutputTokens: plan.budgets.maxOutputTokens,
    },
  });

  const accounting: TokenAccounting = { inputTokens: 0, outputTokens: 0, calls: [] };
  const budget = new RetrievalBudget(plan.budgets.maxFileRetrievals);
  const toolContexts: string[] = [];
  const allFulfilled: ToolResult[] = [];

  const changedFilesList = workspace.changedFiles
    .map((f) => `- ${f.status}: ${f.path}${f.previousPath ? ` (was ${f.previousPath})` : ""}`)
    .join("\n");
  const customInstructions = config.review.conventions.customInstructions.trim();
  // Review-type injection (§4.1): composed ONCE from the trusted instruction
  // profile plus the review's own injection — the full knowledge text goes
  // into the analysis stage; later stages reuse it by reference so the same
  // block is never re-injected in full.
  const methodologyStage1 = composeInjectionStage1(input.promptInjection);
  const methodologyLaterStages = composeInjectionLaterStages(input.promptInjection);

  try {
    // ------------------------------------------------------------------
    // Stage 1 — initial analysis (+ stage 2 request planning)
    // ------------------------------------------------------------------
    const analysis = await executeAnalysisCall(deps, session, accounting, workspace, changedFilesList, customInstructions, methodologyStage1);

    // ------------------------------------------------------------------
    // Stage 2 — context investigation via the controlled tool protocol
    // ------------------------------------------------------------------
    const investigationEnabled = plan.stages.find((s) => s.id === "context-investigation")?.enabled ?? false;
    let latest = analysis;
    if (investigationEnabled && !analysis.no_additional_context_needed) {
      const maxRounds = plan.tier === "low" ? 1 : plan.tier === "medium" ? 2 : 3;
      let round = 0;
      while (round < maxRounds) {
        if (accounting.inputTokens >= plan.budgets.maxInputTokens) {
          budget.violation("token budget exhausted; further context retrieval skipped");
          break;
        }
        if (accounting.calls.length >= plan.budgets.maxModelCalls) {
          budget.violation("model-call budget exhausted; further context retrieval skipped");
          break;
        }
        const requests = parseToolRequests(latest.tool_requests, budget);
        const results = await fulfillToolRequests(
          workspace.workspacePath,
          requests,
          budget,
          workspace.diff,
          config.repository.files.maxFileBytes,
        );
        const useful = results.some((r) => r.ok);
        if (results.length > 0) toolContexts.push(renderToolContext(results).slice(0, MAX_TOOL_CONTEXT_CHARS));
        allFulfilled.push(...results);
        if (!useful) break; // nothing usable came back; don't burn calls on a loop
        round++;

        // Low tier merges investigation + verification + reporting into this
        // call (≤2 model calls total). Higher tiers investigate first and get
        // a dedicated reporting call afterwards, budget permitting.
        const mergeReporting = plan.tier === "low";
        const callsLeft = plan.budgets.maxModelCalls - accounting.calls.length;
        if (mergeReporting || callsLeft <= 1) {
          return await finishWithReportingCall({
            deps,
            session,
            accounting,
            budget,
            plan,
            analysis: latest,
            toolContext: toolContexts.join("\n\n"),
            allFulfilled,
            startedAt,
            mergedWithInvestigation: mergeReporting,
            workspacePath: workspace.workspacePath,
            config,
            methodologyLaterStages,
          });
        }
        latest = await executeInvestigationCall(deps, session, accounting, latest, toolContexts, customInstructions, methodologyLaterStages);
      }
    }

    // ------------------------------------------------------------------
    // Stage 3 + 4 — verification and reporting prep → structured result
    // ------------------------------------------------------------------
    return await finishWithReportingCall({
      deps,
      session,
      accounting,
      budget,
      plan,
      analysis: latest,
      toolContext: toolContexts.join("\n\n"),
      allFulfilled,
      startedAt,
      mergedWithInvestigation: false,
      workspacePath: workspace.workspacePath,
      config,
      methodologyLaterStages,
    });
  } finally {
    await deps.runtime.terminate(session).catch(() => {
      /* termination is best-effort; the review outcome is already decided */
    });
  }
}

// ---------------------------------------------------------------------------
// Stage calls
// ---------------------------------------------------------------------------

/**
 * Compose the injection block for the ANALYSIS stage: trusted guideline-mode
 * instructions + the full knowledge text (untrusted data, clearly labeled).
 * The engineering guidelines are the authoritative standard for the review.
 * Exported for prompt-profile tests.
 */
export function composeInjectionStage1(injection: PromptInjection | null | undefined): string {
  if (!injection) return "";
  const label = injection.profile === "handbook" ? "HANDBOOK GUIDELINES" : "ENGINEERING GUIDELINES";
  return `${HANDBOOK_MODE_INSTRUCTIONS}\n\n${label} retrieved for this PR (UNTRUSTED DATA — the authoritative standard for this review; read before evaluating the changed code):\n${injection.text}`;
}

/**
 * Compose the injection block for LATER stages. When the retrieval layer
 * provides a digest (handbook), it is reused by reference so the full text is
 * injected only once. Otherwise the full guideline text is re-injected,
 * because each stage runs as its own process without shared context.
 * Exported for prompt-profile tests.
 */
export function composeInjectionLaterStages(injection: PromptInjection | null | undefined): string {
  if (!injection) return "";
  const digest = injection.laterStagesText?.trim();
  if (digest) return digest;
  return `${HANDBOOK_MODE_INSTRUCTIONS}\n\nENGINEERING GUIDELINES (authoritative standard for this review; re-provided because stages do not share context):\n${injection.text}`;
}

function analysisInstruction(
  changedFilesList: string,
  diff: string,
  customInstructions: string,
  methodologyStage1: string,
): string {
  return `You are a senior code reviewer analyzing a pull request.

${COMMON_RULES}

${CONVENTIONS_BLOCK}${customInstructions ? `\nCUSTOM REVIEW INSTRUCTIONS FROM THE MAINTAINERS (highest priority):\n${customInstructions}` : ""}${methodologyStage1 ? `\n${methodologyStage1}` : ""}

CHANGED FILES:
${changedFilesList || "(no files changed)"}

DIFF:
\`\`\`diff
${truncate(diff, MAX_DIFF_CHARS, "(diff truncated — request files via tool_requests to see full content)")}
\`\`\`

TASK:
1. Understand the PR objective.
2. Identify risky changes, affected modules and potentially impacted callers/tests.
3. Detect project conventions relevant to reviewing this change.
4. Decide which ADDITIONAL repository files you need to inspect to find real
   bugs that are not visible in the diff alone (callers, implementations of
   called functions, related tests, config). List them as tool_requests.
5. Record preliminary findings you can already see in the diff.

ANALYSIS-STAGE OUTPUT CONTRACT: answer with ONE JSON object exactly in this
shape (no extra keys). This is NOT the final report: do not emit schemaVersion,
summary, findings or uncertain_findings here.
{
  "objective": "what this PR does",
  "conventions": ["..."],
  "tool_requests": [ { "tool": "read_file|list_files|get_diff", "path": "workspace-relative path" } ],
  "preliminary_findings": [ ...finding objects as described below, may be empty... ],
  "no_additional_context_needed": true|false
}
Use "tool_requests" ONLY for read-only inspection (read_file, list_files, get_diff).`;
}

async function executeAnalysisCall(
  deps: EngineDeps,
  session: AgentSession,
  accounting: TokenAccounting,
  workspace: { diff: string },
  changedFilesList: string,
  customInstructions: string,
  methodology: string,
): Promise<ParsedAnalysisOutput> {
  const task: AgentTask = {
    instruction: analysisInstruction(changedFilesList, workspace.diff, customInstructions, methodology),
    output: "json",
    validate: validateAnalysisOutput,
  };
  const run = await deps.runtime.execute(session, task);
  recordUsage(accounting, "initial-analysis", run);
  return run.value as ParsedAnalysisOutput;
}

const validateAnalysisOutput = (value: unknown) => {
  const parsed = analysisOutputSchema.safeParse(value);
  return parsed.success
    ? { ok: true as const, value: parsed.data }
    : { ok: false as const, error: zodDetail(parsed.error) };
};

const validateReviewResultOutput = (value: unknown) => {
  const parsed = reviewResultSchema.safeParse(value);
  return parsed.success
    ? { ok: true as const, value: parsed.data }
    : { ok: false as const, error: zodDetail(parsed.error) };
};

function zodDetail(error: { issues: { path: (string | number | symbol)[]; message: string }[] }): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.map(String).join(".")}: ${i.message}`)
    .join("; ");
}

async function executeInvestigationCall(
  deps: EngineDeps,
  session: AgentSession,
  accounting: TokenAccounting,
  previous: ParsedAnalysisOutput,
  toolContexts: string[],
  customInstructions: string,
  methodologyLaterStages: string,
): Promise<ParsedAnalysisOutput> {
  const task: AgentTask = {
    instruction: `You are the same senior code reviewer. The application fulfilled your read-only
tool_requests. Reconcile what you now know.

${COMMON_RULES}${customInstructions ? `\nCUSTOM REVIEW INSTRUCTIONS FROM THE MAINTAINERS (highest priority):\n${customInstructions}` : ""}${methodologyLaterStages ? `\n${methodologyLaterStages}` : ""}

PR OBJECTIVE: ${previous.objective || "(as analyzed)"}

ADDITIONAL REPOSITORY CONTEXT (read-only retrieval results):
${toolContexts.join("\n\n")}

TASK:
1. Trace the affected code paths, check callers and related tests against the diff.
2. Compare the change against the project conventions you detected.
3. Identify concrete bugs and regressions. Adjust your preliminary findings:
   keep only what the retrieved context supports and add new evidence-backed
   findings. Do not add an "uncertain_findings" key at this stage — the
   reporting stage decides which findings are uncertain.
4. If you still need another file, list it in tool_requests. Otherwise set
   "no_additional_context_needed": true.

INVESTIGATION-STAGE OUTPUT CONTRACT: answer with ONE JSON object exactly in this
shape (no extra keys). This is NOT the final report: do not emit schemaVersion,
summary, findings or uncertain_findings here.
{
  "objective": "updated PR objective",
  "conventions": ["..."],
  "tool_requests": [ ...only if you still need a file... ],
  "preliminary_findings": [ ...updated finding list, may be empty... ],
  "no_additional_context_needed": true|false
}`,
    output: "json",
    validate: validateAnalysisOutput,
  };
  const run = await deps.runtime.execute(session, task);
  recordUsage(accounting, "context-investigation", run);
  return run.value as ParsedAnalysisOutput;
}

interface ReportingContext {
  deps: EngineDeps;
  session: AgentSession;
  accounting: TokenAccounting;
  budget: RetrievalBudget;
  plan: import("./types.js").ReviewPlan;
  analysis: ParsedAnalysisOutput;
  toolContext: string;
  allFulfilled: ToolResult[];
  startedAt: number;
  mergedWithInvestigation: boolean;
  workspacePath: string;
  config: ReviewConfig;
  /** Later-stage injection text (profile instructions + guidelines reference). */
  methodologyLaterStages: string;
}

async function finishWithReportingCall(ctx: ReportingContext): Promise<RunReviewOutput> {
  const { deps, session, accounting, plan, config } = ctx;
  const verificationEnabled = plan.stages.find((s) => s.id === "finding-verification")?.enabled ?? false;
  const preliminaryBlock = (ctx.analysis.preliminary_findings ?? []).length
    ? `\nPRELIMINARY FINDINGS FROM EARLIER STAGES:\n${JSON.stringify(ctx.analysis.preliminary_findings, null, 2).slice(0, 12_000)}`
    : "";

  const task: AgentTask = {
    instruction: `You are the same senior code reviewer producing the FINAL structured review.

OUTPUT CONTRACT: answer NOW with ONE JSON object only. Do NOT call tools in
this stage, do NOT narrate what you are about to do, and do not wrap the JSON
in prose. If you have already seen enough context, report it; do not request
more files here. The object MUST begin with "schemaVersion": 1 and use only
the keys shown below — never analysis-stage keys (objective, tool_requests,
preliminary_findings, no_additional_context_needed).

${COMMON_RULES}
${verificationEnabled ? "\nVERIFICATION (mandatory): recheck every finding against the source you have seen. Verify the affected line, whether the behavior is intentional, and the severity. Keep a finding only when the evidence supports it; otherwise drop it or move it to uncertain_findings with reduced confidence.\n" : ""}
ANCHORING: anchor each finding at the file and line where the defect MANIFESTS
(for example, a caller broken by a changed contract is anchored in the caller
file, not in the changed file), with evidence from that file.
${ctx.toolContext ? `\nADDITIONAL REPOSITORY CONTEXT (read-only retrieval results):\n${ctx.toolContext}\n` : "No additional repository context was retrieved for this review.\n"}
${ctx.methodologyLaterStages ? `\n${ctx.methodologyLaterStages}\n` : ""}
PR OBJECTIVE: ${ctx.analysis.objective || "(as analyzed)"}
${preliminaryBlock}

PROJECT CONVENTIONS DETECTED: ${ctx.analysis.conventions.join("; ") || "(none detected)"}

${REVIEW_RESULT_FORMAT}`,
    output: "json",
    validate: validateReviewResultOutput,
  };

  const run = await deps.runtime.execute(session, task);
  recordUsage(accounting, "reporting-prep", run);
  const modelResult = run.value as {
    schemaVersion: 1;
    summary: string;
    findings: Finding[];
    uncertainFindings: Finding[];
    conventions: string[];
  };

  // Findings whose anchor file does not exist in the workspace cannot be
  // verified — demote to uncertain rather than trust the model.
  const checked: Finding[] = [];
  for (const raw of [...modelResult.findings, ...modelResult.uncertainFindings]) {
    const parsed = findingSchema.safeParse(raw);
    if (!parsed.success) continue; // malformed single findings are dropped, not fatal
    const finding = parsed.data as Finding;
    if (!fileExistsInWorkspace(ctx.workspacePath, finding.file)) {
      checked.push({ ...finding, confidence: Math.min(finding.confidence, 0.5) });
      ctx.budget.violation(
        `finding '${finding.title}': anchor file '${finding.file}' not present in workspace; demoted to uncertain`,
      );
    } else {
      checked.push(finding);
    }
  }

  const conventions = [
    ...new Set([...ctx.analysis.conventions, ...modelResult.conventions].map((c) => c.trim()).filter(Boolean)),
  ];
  const { findings, uncertainFindings } = normalizeFindings(checked, config);
  const result: ReviewResult = {
    schemaVersion: 1,
    summary:
      modelResult.summary.trim() ||
      ctx.analysis.objective.trim() ||
      "Pull request reviewed.",
    findings,
    uncertainFindings,
    conventions,
  };

  const retrieval: RetrievalUsage = {
    requested: allRequestedCount(ctx.budget, ctx.allFulfilled),
    fulfilled: ctx.allFulfilled.filter((r) => r.ok).length,
    rejected: ctx.allFulfilled.filter((r) => !r.ok).length,
    bytesDelivered: ctx.allFulfilled.reduce((sum, r) => sum + (r.ok ? r.content.length : 0), 0),
    violations: [...ctx.budget.violations],
  };

  return {
    result,
    meta: {
      plan,
      usage: {
        modelCalls: accounting.calls,
        totalInputTokens: accounting.inputTokens,
        totalOutputTokens: accounting.outputTokens,
        durationMs: Date.now() - ctx.startedAt,
      },
      retrieval,
      skippedStages: skippedStageIds(plan),
    },
  };
}

/** Total tool requests the agent made = delivered/failed results + parse-level rejections. */
function allRequestedCount(budget: RetrievalBudget, fulfilled: ToolResult[]): number {
  const parseRejections = budget.violations.filter(
    (v) =>
      v.includes("rejected") ||
      v.includes("not an object") ||
      v.includes("not an array") ||
      v.includes("out of bounds"),
  ).length;
  // Every fulfillToolRequests outcome (ok or per-request error) is one request.
  return fulfilled.length + parseRejections;
}

function recordUsage(
  accounting: TokenAccounting,
  stage: string,
  run: import("../agent/types.js").AgentResult,
): void {
  accounting.inputTokens += run.usage?.inputTokens ?? 0;
  accounting.outputTokens += run.usage?.outputTokens ?? 0;
  accounting.calls.push({
    stage,
    inputTokens: run.usage?.inputTokens,
    outputTokens: run.usage?.outputTokens,
    reasoningTokens: run.usage?.reasoningTokens,
    durationMs: run.durationMs,
  });
}

/** Guard for callers wiring the engine into the workspace processor hook. */
export function assertWorkspaceReviewable(workspace: { diff: string }): void {
  if (typeof workspace.diff !== "string" || workspace.diff.trim().length === 0) {
    throw new ReviewEngineError("empty_diff", "Workspace has no diff to review");
  }
}

export { reviewResultSchema, analysisOutputSchema };
export type { AgentSession };
