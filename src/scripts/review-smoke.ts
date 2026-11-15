/**
 * Real-endpoint smoke test for the adaptive review engine (ticket 07
 * completion evidence). Runs ONE full `runReview` against the real GLM
 * endpoint via the OpenCode agent runtime, on the mandatory "related-file
 * bug" fixture: the diff changes utils.ts's return shape (string → object)
 * while the broken caller lives in caller.ts — invisible in the diff and
 * reachable only through the controlled tool-request protocol.
 *
 * Environment (same as model:smoke):
 *   MODEL_BASE_URL / MODEL_API_KEY / MODEL_NAME  — provider config
 *
 * Usage: npm run build && npx dotenv -e .env -- node lib/scripts/review-smoke.js
 * (or: MODEL_BASE_URL=... MODEL_API_KEY=... MODEL_NAME=... node lib/scripts/review-smoke.js)
 *
 * Secrets are never printed: the report contains only the model name,
 * complexity tier/score, stage usage, call latencies, retrieval counts and
 * the structured review result.
 */

import "dotenv/config";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runReview } from "../modules/review/index.js";
import type { ChangedFile, WorkspaceResult } from "../modules/workspace/index.js";
import { createAgentRuntime } from "../platform/agents/index.js";
import { readEnv } from "../platform/config/env.js";
import { DEFAULT_CONFIG_PATH, loadReviewConfig } from "../platform/config/review-loader.js";

const UTILS_TS = "export function formatName(user: { name: string }) {\n  return { name: user.name };\n}\n";
const CALLER_TS = 'import { formatName } from "./utils.js";\n\nconst label = formatName(user).toUpperCase();\n';
const DIFF = [
  "diff --git a/src/utils.ts b/src/utils.ts",
  "index 0000000..1111111 100644",
  "--- a/src/utils.ts",
  "+++ b/src/utils.ts",
  "@@ -1,3 +1,3 @@",
  "-  return user.name;",
  "+  return { name: user.name }; // session",
].join("\n");
const CHANGED: ChangedFile[] = [{ path: "src/utils.ts", status: "modified" }];

async function makeWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "review-smoke-"));
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.writeFile(path.join(dir, "src", "utils.ts"), UTILS_TS);
  await fs.writeFile(path.join(dir, "src", "caller.ts"), CALLER_TS);
  return dir;
}

function truncate(text: string, max = 400): string {
  return text.length <= max ? text : `${text.slice(0, max)}… (${text.length} chars)`;
}

async function main(): Promise<void> {
  if (!readEnv("MODEL_API_KEY")) {
    console.error("MODEL_API_KEY is not set — cannot run the real-endpoint smoke test.");
    process.exitCode = 1;
    return;
  }

  const loaded = loadReviewConfig(DEFAULT_CONFIG_PATH);
  const config = loaded.config;
  const workspacePath = await makeWorkspace();
  const workspace: WorkspaceResult = {
    workspacePath,
    headSha: "smoke-head",
    baseSha: "smoke-base",
    mergeBaseSha: "smoke-merge-base",
    diff: DIFF,
    changedFiles: CHANGED,
  };

  const runtime = createAgentRuntime(config);
  try {
    console.log(`model: ${config.provider.model} (env MODEL_NAME wins when set)`);
    const started = Date.now();
    const output = await runReview({ reviewId: "smoke-07", workspace }, { runtime, config });
    const wallMs = Date.now() - started;

    const { result, meta } = output;
    console.log("--- smoke report (redacted) ---");
    console.log(`complexity: tier=${meta.plan.tier} score=${meta.plan.complexity.score}`);
    console.log(`stages skipped: ${meta.skippedStages.join(", ") || "(none)"}`);
    for (const call of meta.usage.modelCalls) {
      console.log(
        `call ${call.stage}: ${call.durationMs}ms in=${call.inputTokens ?? "?"} out=${call.outputTokens ?? "?"}`,
      );
    }
    console.log(`tokens: in=${meta.usage.totalInputTokens} out=${meta.usage.totalOutputTokens}; wall=${wallMs}ms`);
    console.log(
      `retrieval: requested=${meta.retrieval.requested} fulfilled=${meta.retrieval.fulfilled} ` +
        `rejected=${meta.retrieval.rejected} bytes=${meta.retrieval.bytesDelivered}`,
    );
    if (meta.retrieval.violations.length > 0) {
      console.log(`violations: ${meta.retrieval.violations.join(" | ")}`);
    }
    console.log(`summary: ${truncate(result.summary)}`);
    console.log(`conventions: ${result.conventions.join(" | ") || "(none)"}`);
    console.log(`findings (${result.findings.length}):`);
    for (const f of result.findings) {
      console.log(
        `  - [${f.severity}/${f.category}] ${f.title} @ ${f.file}:${f.line} ` +
          `confidence=${Math.round(f.confidence * 100)}% verified=${f.verified}`,
      );
      console.log(`    ${truncate(f.description, 240)}`);
      for (const e of f.evidence) {
        console.log(`    evidence ${e.file}:${e.line} — ${truncate(e.excerpt, 160)}`);
      }
    }
    console.log(`uncertain (${result.uncertainFindings.length}):`);
    for (const f of result.uncertainFindings) {
      console.log(`  - ${f.title} @ ${f.file}:${f.line} confidence=${Math.round(f.confidence * 100)}%`);
    }
    const sawCaller = result.findings.some((f) => f.file.endsWith("caller.ts"));
    console.log(
      sawCaller ? "RESULT: PASS — caller.ts bug surfaced via tool protocol" : "RESULT: caller.ts bug NOT surfaced",
    );
  } finally {
    await fs.rm(workspacePath, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(`smoke failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
