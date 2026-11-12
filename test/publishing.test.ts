import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type pino from "pino";
import { getPrisma, disconnectPrisma } from "../src/lib/prisma.js";
import { reviewConfigSchema, type ReviewConfig } from "../src/config/review-schema.js";
import type { Finding, FindingEvidence, ReviewResult } from "../src/review-engine/index.js";
import type { ReviewRunMetadata } from "../src/review-engine/types.js";
import type { ReviewJobPayload } from "../src/ingestion/queue.js";
import type { WorkspaceResult } from "../src/workspace/workspace.js";
import type { AgentRuntime } from "../src/agent/types.js";
import type { StoredFinding } from "../src/findings/index.js";
import {
  parseUnifiedDiff,
  resolveInlinePosition,
} from "../src/publishing/diff-positions.js";
import {
  buildInlineCommentBody,
  buildReviewBody,
  extractFingerprint,
  fingerprintMarker,
} from "../src/publishing/summary.js";
import {
  DEFAULT_RETRY,
  StaleHeadError,
  appendSummaryMarker,
  publishReview,
  recordPublicationFailure,
  withRetry,
  type PublisherOctokit,
  type ReviewCommentParams,
} from "../src/publishing/publisher.js";
import { finalizeReview, type ReviewPipelineDeps } from "../src/publishing/pipeline.js";

/**
 * Ticket 09 tests: diff position resolution, review body generation,
 * publication via a fake octokit (dedup, stale SHA protection, retries,
 * COMMENT-only) and the end-to-end pipeline wiring through `finalizeReview`
 * (real Postgres, ARCHITECTURE.md §4.3/§4.4, §6.4, §7.4, §13.1).
 */

// persistReviewFindings is mocked so the persistence-failure path of
// finalizeReview can be exercised deterministically; every other export of
// the findings module stays real.
vi.mock("../src/findings/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/findings/index.js")>();
  return { ...actual, persistReviewFindings: vi.fn(actual.persistReviewFindings) };
});

import { persistReviewFindings, getFindingsForReview } from "../src/findings/index.js";

process.env.DATABASE_URL ??= "postgres://postgres:postgres@localhost:5432/reviewer";

const prisma = getPrisma();

const REPO_FULL_NAME = "fixture/publish-repo";
const INSTALLATION_ID = 77_009n;
const GITHUB_REPO_ID = 88_456n;
const PR_NUMBER = 12;

function makeConfig(overrides: Record<string, unknown> = {}): ReviewConfig {
  return reviewConfigSchema.parse({
    schemaVersion: 1,
    github: { organization: "fixture-org" },
    provider: {
      baseURL: "https://llm.example.test/compat",
      apiKeyEnv: "MODEL_API_KEY",
      model: "workers-ai/@cf/zai-org/glm-4.7-flash",
    },
    ...overrides,
  });
}

const config = makeConfig();

// Workspace fixture -------------------------------------------------------------

const APP_V1 = [
  "const x = require('x');",
  "function broken(a, b) {",
  "  return a + b; // fine",
  "}",
  "",
  "function unused() {",
  "  return 1;",
  "}",
].join("\n");

let workspacePath: string;

async function writeWorkspace(): Promise<void> {
  workspacePath = await fsp.mkdtemp(path.join(os.tmpdir(), "publish-ws-"));
  await fsp.mkdir(path.join(workspacePath, "src"), { recursive: true });
  await fsp.writeFile(path.join(workspacePath, "src", "app.js"), APP_V1 + "\n", "utf-8");
}

function evidence(partial: Partial<FindingEvidence> = {}): FindingEvidence[] {
  return [
    {
      file: "src/app.js",
      line: 2,
      excerpt: "function broken(a, b) {",
      reason: "the function shown is the one with the issue",
      ...partial,
    },
  ];
}

let findingSeq = 0;
function makeFinding(overrides: Partial<Finding> = {}): Finding {
  findingSeq += 1;
  return {
    category: "maintainability",
    severity: "medium",
    confidence: 0.9,
    title: `Issue ${findingSeq}`,
    file: "src/app.js",
    line: 2,
    description: "the broken function has a real problem",
    evidence: evidence(),
    verified: false,
    ...overrides,
  };
}

// Diff fixture ------------------------------------------------------------------
// src/app.js has an added line at new-side line 4 (inline-eligible), src/mod.js
// has a deleted line at old-side line 6 (summary-only), src/gone.js is deleted,
// src/missing.js is not in the diff at all.

const DIFF = [
  "diff --git a/src/app.js b/src/app.js",
  "index 111111..222222 100644",
  "--- a/src/app.js",
  "+++ b/src/app.js",
  "@@ -1,5 +1,6 @@",
  " const x = require('x');",
  "+function broken(a, b) {",
  " function broken(a, b) {",
  "+  return a + b; // fine",
  " }",
  "",
  "diff --git a/src/mod.js b/src/mod.js",
  "index 333333..444444 100644",
  "--- a/src/mod.js",
  "+++ b/src/mod.js",
  "@@ -5,2 +5,1 @@",
  " context a",
  "-deleted old line 6",
  "diff --git a/src/gone.js b/src/gone.js",
  "deleted file mode 100644",
  "index 555555..000000",
  "--- a/src/gone.js",
  "+++ /dev/null",
  "@@ -1,1 +0,0 @@",
  "-gone content",
].join("\n");

const diffFiles = parseUnifiedDiff(DIFF);

// Database helpers --------------------------------------------------------------

async function cleanDatabase(): Promise<void> {
  await prisma.reviewComment.deleteMany();
  await prisma.findingStatusTransition.deleteMany();
  await prisma.finding.deleteMany();
  await prisma.reviewWorkspace.deleteMany();
  await prisma.reviewStateTransition.deleteMany();
  await prisma.outboxEvent.deleteMany();
  await prisma.reviewJob.deleteMany();
  await prisma.review.deleteMany();
  await prisma.pullRequest.deleteMany();
  await prisma.repository.deleteMany();
  await prisma.installation.deleteMany();
}

let shaSeq = 0;

/** Seed Installation → Repository → PullRequest → one Review (state queued). */
async function seedReview(headLabel: string): Promise<{ reviewId: string; headSha: string; repositoryId: string }> {
  shaSeq += 1;
  const headSha = `sha-${shaSeq.toString().padStart(3, "0")}-${headLabel}`;
  const installation = await prisma.installation.upsert({
    where: { githubInstallationId: INSTALLATION_ID },
    create: { githubInstallationId: INSTALLATION_ID, organization: "fixture-owner", status: "active" },
    update: {},
  });
  const repository = await prisma.repository.upsert({
    where: { githubRepositoryId: GITHUB_REPO_ID },
    create: {
      githubRepositoryId: GITHUB_REPO_ID,
      installationId: installation.id,
      fullName: REPO_FULL_NAME,
      defaultBranch: "main",
      status: "active",
    },
    update: {},
  });
  const pullRequest = await prisma.pullRequest.upsert({
    where: { repositoryId_githubPrNumber: { repositoryId: repository.id, githubPrNumber: PR_NUMBER } },
    create: { repositoryId: repository.id, githubPrNumber: PR_NUMBER, status: "open", headSha },
    update: {},
  });
  const review = await prisma.review.create({
    data: {
      pullRequestId: pullRequest.id,
      githubInstallationId: INSTALLATION_ID,
      githubRepositoryId: GITHUB_REPO_ID,
      pullRequestNumber: PR_NUMBER,
      headSha,
      state: "queued",
      trigger: "opened",
    },
  });
  return { reviewId: review.id, headSha, repositoryId: repository.id };
}

/** Insert a Finding row directly and build its StoredFinding view. */
async function insertStoredFinding(
  reviewId: string,
  repositoryId: string,
  overrides: Partial<StoredFinding> = {},
): Promise<StoredFinding> {
  findingSeq += 1;
  const base: StoredFinding = {
    id: "",
    fingerprint: "",
    category: "maintainability",
    severity: "medium",
    confidence: 0.9,
    title: `Stored issue ${findingSeq}`,
    filePath: "src/app.js",
    lineNumber: 4,
    description: "a real problem in the added code",
    verified: true,
    status: "new",
    reopened: false,
    ...overrides,
  };
  if (!base.fingerprint) base.fingerprint = `fp1:${base.title.replace(/\s+/g, "-").toLowerCase()}-test`;
  const row = await prisma.finding.create({
    data: {
      reviewId,
      repositoryId,
      fingerprint: base.fingerprint,
      category: base.category,
      severity: base.severity,
      confidence: base.confidence,
      title: base.title,
      filePath: base.filePath,
      lineNumber: base.lineNumber,
      description: base.description,
      evidence: [],
      verified: base.verified,
      status: base.status,
    },
  });
  return { ...base, id: row.id };
}

// Fake octokit ------------------------------------------------------------------

interface FakeState {
  currentSha: string | null;
  existingComments: Array<{ id: number; body: string | null }>;
  existingReviews: Array<{ id: number; body: string | null; state: string }>;
  /** Number of times createReview should fail before succeeding. */
  failCreateTimes: number;
  getPullCalls: number;
  createReviewCalls: Array<{
    event: string;
    body: string;
    comments: Array<ReviewCommentParams>;
  }>;
}

let commentIdSeq = 10_000;

function makeFakeOctokit(state: FakeState): PublisherOctokit {
  return {
    rest: {
      pulls: {
        get: async () => {
          state.getPullCalls += 1;
          return { data: { head: { sha: state.currentSha } } };
        },
        listReviewComments: async () => ({ data: state.existingComments }),
        listReviews: async () => ({ data: state.existingReviews }),
        createReview: async (params: {
          event: string;
          body: string;
          comments?: ReviewCommentParams[];
        }) => {
          state.createReviewCalls.push({
            event: params.event,
            body: params.body,
            comments: params.comments ?? [],
          });
          if (state.failCreateTimes > 0) {
            state.failCreateTimes -= 1;
            throw new Error("simulated GitHub 502");
          }
          const created = (params.comments ?? []).map((c) => {
            commentIdSeq += 1;
            return { id: commentIdSeq, body: c.body };
          });
          // Real GitHub attaches inline comments and the review itself to the
          // PR; mirror that so subsequent list* calls see them.
          for (const c of created) state.existingComments.push(c);
          state.existingReviews.push({ id: 5001, body: params.body, state: params.event });
          return { data: { id: 5001, comments: created } };
        },
      },
    },
  } as unknown as PublisherOctokit;
}

function makeState(headSha: string): FakeState {
  return {
    currentSha: headSha,
    existingComments: [],
    existingReviews: [],
    failCreateTimes: 0,
    getPullCalls: 0,
    createReviewCalls: [],
  };
}

/** Standard publishReview input for the seeded review. `headSha` is the SHA
 *  the review was produced for (defaults to the fake's current SHA). */
function makePublishInput(
  reviewId: string,
  state: FakeState,
  findings: StoredFinding[],
  headSha: string = state.currentSha ?? "missing",
) {
  return {
    prisma,
    octokit: makeFakeOctokit(state),
    reviewId,
    repositoryFullName: REPO_FULL_NAME,
    pullNumber: PR_NUMBER,
    headSha,
    diff: DIFF,
    summary: "The change introduces one verified issue.",
    findings,
    config: { publishUncertainInSummary: true, publishCleanReview: true },
    retry: { maxAttempts: 1, baseDelayMs: 0 },
  };
}

// finalizeReview fixtures --------------------------------------------------------

const fakeLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as pino.Logger;

function makePayload(reviewId: string, headSha: string): ReviewJobPayload {
  return {
    reviewId,
    jobKey: `job-${reviewId}`,
    githubInstallationId: "77009",
    githubRepositoryId: "88456",
    repositoryFullName: REPO_FULL_NAME,
    pullRequestNumber: PR_NUMBER,
    headSha,
    reviewMode: "full",
    trigger: "synchronize",
  };
}

function makeWorkspace(headSha: string): WorkspaceResult {
  return {
    workspacePath,
    headSha,
    baseSha: "base-sha",
    mergeBaseSha: "base-sha",
    diff: DIFF,
    changedFiles: [],
  };
}

function makeResult(output: Partial<ReviewResult> = {}): ReviewResult {
  return {
    schemaVersion: 1,
    summary: "One verified issue was found.",
    findings: [makeFinding()],
    uncertainFindings: [],
    conventions: [],
    ...output,
  };
}

function makeMeta(): ReviewRunMetadata {
  return {
    plan: {
      complexity: { score: 1, tier: "low" as const, factors: [] },
      tier: "low" as const,
      stages: [],
      budgets: {
        maxModelCalls: 1,
        maxFileRetrievals: 1,
        maxInputTokens: 1,
        maxOutputTokens: 1,
        timeoutMs: 1,
      },
    },
    usage: { modelCalls: [], totalInputTokens: 0, totalOutputTokens: 0, durationMs: 0 },
    retrieval: { requested: 0, fulfilled: 0, rejected: 0, bytesDelivered: 0, violations: [] },
    skippedStages: [],
  };
}

function makeDeps(state: FakeState, overrides: Partial<ReviewPipelineDeps> = {}): ReviewPipelineDeps {
  return {
    runtime: {} as AgentRuntime,
    config,
    logger: fakeLogger,
    prisma,
    tokenProvider: {
      getInstallationToken: async () => ({ token: "fake-installation-token", expiresAt: new Date(Date.now() + 60_000) }),
    },
    octokitFactory: () => makeFakeOctokit(state),
    publishRetry: { maxAttempts: 1, baseDelayMs: 0 },
    ...overrides,
  };
}

// Tests ---------------------------------------------------------------------------

beforeAll(async () => {
  await writeWorkspace();
});

afterAll(async () => {
  await fsp.rm(workspacePath, { recursive: true, force: true }).catch(() => {});
  await disconnectPrisma();
});

beforeEach(async () => {
  await cleanDatabase();
});

afterEach(async () => {
  vi.mocked(persistReviewFindings).mockClear();
});

describe("diff position resolution (§7.4)", () => {
  test("parses hunks with correct old/new line numbers", () => {
    const app = diffFiles.get("src/app.js")!;
    expect(app).toBeDefined();
    expect(app.isNewFile).toBe(false);
    // New side: added + context lines (1, 2, 3, 4, 5).
    expect(resolveInlinePosition(diffFiles, "src/app.js", 4)).toEqual({
      kind: "anchored",
      position: { path: "src/app.js", line: 4, side: "RIGHT" },
    });
  });

  test("added lines in a new file are inline-eligible on the RIGHT side", () => {
    const diff = [
      "diff --git a/src/new.js b/src/new.js",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/new.js",
      "@@ -0,0 +1,3 @@",
      "+first",
      "+second",
      "+third",
    ].join("\n");
    const files = parseUnifiedDiff(diff);
    const file = files.get("src/new.js")!;
    expect(file.isNewFile).toBe(true);
    expect(resolveInlinePosition(files, "src/new.js", 2)).toEqual({
      kind: "anchored",
      position: { path: "src/new.js", line: 2, side: "RIGHT" },
    });
  });

  test("modified (context) lines are inline-eligible", () => {
    expect(resolveInlinePosition(diffFiles, "src/app.js", 5)).toMatchObject({ kind: "anchored" });
  });

  test("deleted lines resolve to deleted_line (summary-only fallback)", () => {
    expect(resolveInlinePosition(diffFiles, "src/mod.js", 6).kind).toBe("deleted_line");
  });

  test("lines outside every hunk are not inline-eligible", () => {
    expect(resolveInlinePosition(diffFiles, "src/app.js", 400).kind).toBe("line_not_in_diff");
  });

  test("files not in the diff are not inline-eligible", () => {
    expect(resolveInlinePosition(diffFiles, "src/missing.js", 1).kind).toBe("file_not_in_diff");
  });

  test("deleted files are not inline-eligible", () => {
    expect(resolveInlinePosition(diffFiles, "src/gone.js", 1).kind).toBe("deleted_file");
  });

  test("binary files are not inline-eligible", () => {
    const diff = [
      "diff --git a/asset.bin b/asset.bin",
      "index 111..222 100644",
      "Binary files a/asset.bin and b/asset.bin differ",
    ].join("\n");
    const files = parseUnifiedDiff(diff);
    expect(resolveInlinePosition(files, "asset.bin", 1).kind).toBe("binary_file");
  });
});

describe("review body generation", () => {
  const finding = (overrides: Partial<StoredFinding> = {}): StoredFinding => ({
    id: "f1",
    fingerprint: "fp1:abc",
    category: "security",
    severity: "medium",
    confidence: 0.9,
    title: "Finding",
    filePath: "src/app.js",
    lineNumber: 2,
    description: "a problem",
    verified: true,
    status: "new",
    reopened: false,
    ...overrides,
  });

  test("inline comment bodies carry a hidden fingerprint marker that round-trips", () => {
    const f: StoredFinding = {
      id: "f1",
      fingerprint: "fp1:abc",
      category: "security",
      severity: "high",
      confidence: 0.9,
      title: "Leak",
      filePath: "src/app.js",
      lineNumber: 2,
      description: "a secret may leak here",
      verified: true,
      status: "new",
      reopened: false,
    };
    const body = buildInlineCommentBody(f);
    expect(extractFingerprint(body)).toBe("fp1:abc");
    expect(fingerprintMarker("fp1:abc")).not.toMatch(/[A-Za-z]\s+secret/); // hidden marker format
  });

  test("extractFingerprint tolerates whitespace inside the marker", () => {
    expect(extractFingerprint("x <!--  ai-pr-reviewer:fingerprint:fp1:zzz  --> y")).toBe("fp1:zzz");
    expect(extractFingerprint("no marker")).toBeNull();
  });

  test("uncertain findings only appear when configured, never as inline content", () => {
    const verified: StoredFinding[] = [
      {
        id: "v1", fingerprint: "fp-v", category: "maintainability", severity: "medium",
        confidence: 0.9, title: "V", filePath: "a.js", lineNumber: 1,
        description: "a verified problem", verified: true, status: "new", reopened: false,
      },
    ];
    const uncertain: StoredFinding[] = [
      {
        id: "u1", fingerprint: "fp-u", category: "maintainability", severity: "low",
        confidence: 0.5, title: "U", filePath: "a.js", lineNumber: 2,
        description: "a maybe problem", verified: false, status: "uncertain", reopened: false,
      },
    ];
    const withUncertain = buildReviewBody({
      summary: "s",
      verified,
      uncertain,
      config: { publishUncertainInSummary: true, publishCleanReview: true },
    });
    expect(withUncertain).toContain("V");
    expect(withUncertain).toContain("Uncertain findings");
    expect(withUncertain).toContain("U");

    const withoutUncertain = buildReviewBody({
      summary: "s",
      verified,
      uncertain,
      config: { publishUncertainInSummary: false, publishCleanReview: true },
    });
    expect(withoutUncertain).not.toContain("Uncertain findings");
  });

  test("clean reviews publish a short message when enabled, nothing when disabled", () => {
    const input = {
      summary: "no issues",
      verified: [],
      uncertain: [],
      config: { publishUncertainInSummary: true, publishCleanReview: true },
    };
    expect(buildReviewBody(input)).toContain("No verified findings");
    expect(
      buildReviewBody({ ...input, config: { ...input.config, publishCleanReview: false } }),
    ).not.toContain("No verified findings");
  });

  test("groups verified findings by category with counts and recommendation", () => {
    const verified = [
      finding({ category: "maintainability", severity: "low", title: "Naming drift" }),
      finding({ category: "security", severity: "high", title: "Unredacted dump" }),
      finding({ category: "security", severity: "medium", title: "Unbounded write" }),
    ];
    const body = buildReviewBody({
      summary: "Two domains affected.",
      verified,
      uncertain: [],
      config: { publishUncertainInSummary: true, publishCleanReview: true },
    });

    // Canonical category order: security before maintainability.
    expect(body.indexOf("## 1\\. Security")).toBeGreaterThan(-1);
    expect(body.indexOf("## 2\\. Code Quality")).toBeGreaterThan(body.indexOf("## 1\\. Security"));
    expect(body).toContain("**Severity:** 🟠 2 findings (1 high · 1 medium)");
    expect(body).toContain("**Recommendation:** ⚠️ Major Comments");
    expect(body).toContain("**Recommendation:** 💬 Optional Nits");
  });

  test("derives the review status and final decision from the most severe finding", () => {
    const high = buildReviewBody({
      summary: "s",
      verified: [finding({ category: "security", severity: "high" })],
      uncertain: [],
      config: { publishUncertainInSummary: true, publishCleanReview: true },
    });
    expect(high).toContain("**Review Status:** 🔴 Significant Concerns");
    expect(high).toContain("**Final Review Decision:** Changes requested.");

    const low = buildReviewBody({
      summary: "s",
      verified: [finding({ category: "maintainability", severity: "low" })],
      uncertain: [],
      config: { publishUncertainInSummary: true, publishCleanReview: true },
    });
    expect(low).toContain("**Review Status:** 🔵 Minor Suggestions");
    expect(low).toContain("**Final Review Decision:** Comment.");
  });

  test("renders header metadata when provided", () => {
    const body = buildReviewBody({
      summary: "s",
      verified: [],
      uncertain: [],
      config: { publishUncertainInSummary: true, publishCleanReview: true },
      meta: {
        reviewer: "ai-pr-reviewer",
        source: "acme/widgets#42 @ abc1234",
        reviewedAt: new Date("2026-11-12T00:30:00Z"),
        timezone: "UTC",
      },
    });
    expect(body).toContain("# AI Code Review — ai-pr-reviewer");
    expect(body).toContain("**Source:** acme/widgets#42 @ abc1234");
    expect(body).toContain("**Review Date:** 12 November 2026, 00:30");
  });

  test("clean reviews report no concerns and omit category sections", () => {
    const body = buildReviewBody({
      summary: "no issues",
      verified: [],
      uncertain: [],
      config: { publishUncertainInSummary: true, publishCleanReview: true },
    });
    expect(body).toContain("**Review Status:** ✅ No Concerns");
    expect(body).not.toMatch(/^## 1\\./m);
    expect(body).toContain("Review Actions");
  });

  test("the summary marker is appended exactly once", () => {
    const marked = appendSummaryMarker("body text");
    expect(marked).toContain("<!-- ai-pr-reviewer:summary -->");
    expect(marked.match(/ai-pr-reviewer:summary/g)).toHaveLength(1);
  });

  test("oversized summaries are truncated below the GitHub limit", () => {
    const body = buildReviewBody({
      summary: "x".repeat(70_000),
      verified: [],
      uncertain: [],
      config: { publishUncertainInSummary: false, publishCleanReview: false },
    });
    expect(body.length).toBeLessThanOrEqual(60_000);
  });
});

describe("retry policy", () => {
  test("withRetry retries until success within the attempt budget", async () => {
    let attempts = 0;
    const value = await withRetry(
      "test",
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("boom");
        return "ok";
      },
      { maxAttempts: 3, baseDelayMs: 1 },
    );
    expect(value).toBe("ok");
    expect(attempts).toBe(3);
  });

  test("withRetry throws after exhausting attempts", async () => {
    await expect(
      withRetry(
        "test",
        async () => {
          throw new Error("always");
        },
        { maxAttempts: 2, baseDelayMs: 1 },
      ),
    ).rejects.toThrow(/failed after 2 attempts/);
  });

  test("DEFAULT_RETRY is bounded (no infinite retries)", () => {
    expect(DEFAULT_RETRY.maxAttempts).toBeLessThanOrEqual(5);
    expect(DEFAULT_RETRY.maxAttempts).toBeGreaterThanOrEqual(2);
  });
});

describe("publishReview (fake octokit + Postgres)", () => {
  test("publishes inline comments for anchored findings, summary for the rest, always COMMENT", async () => {
    const seed = await seedReview("pub1");
    const anchored = await insertStoredFinding(seed.reviewId, seed.repositoryId, {
      filePath: "src/app.js",
      lineNumber: 4,
    });
    const deletedLine = await insertStoredFinding(seed.reviewId, seed.repositoryId, {
      filePath: "src/mod.js",
      lineNumber: 6,
    });
    const state = makeState(seed.headSha);
    const result = await publishReview({ ...makePublishInput(seed.reviewId, state, [anchored, deletedLine]) });

    // Only the anchored finding became an inline comment.
    expect(result.outcome).toBe("published");
    expect(result.inlineCreated).toBe(1);
    expect(result.summaryOnlyFindings).toBe(1);
    expect(state.createReviewCalls).toHaveLength(1);

    const call = state.createReviewCalls[0];
    // §23: the review event is ALWAYS COMMENT — never APPROVE / REQUEST_CHANGES.
    expect(call.event).toBe("COMMENT");
    expect(call.event === "APPROVE" || call.event === "REQUEST_CHANGES").toBe(false);
    expect(call.body).toContain("Stored issue");
    expect(call.body).toContain("ai-pr-reviewer:summary");
    expect(call.comments).toHaveLength(1);
    expect(call.comments[0]).toMatchObject({ path: "src/app.js", line: 4, side: "RIGHT" });
    expect(extractFingerprint(call.comments[0].body)).toBe(anchored.fingerprint);

    // §13.1: publication rows are persisted with the GitHub ids.
    const rows = await prisma.reviewComment.findMany({ where: { reviewId: seed.reviewId } });
    expect(rows).toHaveLength(2); // one summary + one inline
    const inline = rows.find((r) => r.commentType === "inline");
    expect(inline?.githubCommentId).toBeTypeOf("bigint");
    expect(Number(inline!.githubCommentId!)).toBeGreaterThan(0);
    expect(inline?.fingerprint).toBe(anchored.fingerprint);
    const summaryRow = rows.find((r) => r.commentType === "summary");
    expect(summaryRow?.githubCommentId).not.toBeNull();
  });

  test("uncertain findings go to the summary only, never inline", async () => {
    const seed = await seedReview("pub-unc");
    const uncertain = await insertStoredFinding(seed.reviewId, seed.repositoryId, {
      filePath: "src/app.js",
      lineNumber: 4,
      verified: false,
      status: "uncertain",
    });
    const state = makeState(seed.headSha);
    const result = await publishReview({ ...makePublishInput(seed.reviewId, state, [uncertain]) });

    expect(result.inlineCreated).toBe(0);
    expect(state.createReviewCalls[0].comments).toHaveLength(0);
    expect(state.createReviewCalls[0].body).toContain("Uncertain findings");
    // Uncertain findings are not recorded as published inline comments.
    const inlineRows = await prisma.reviewComment.findMany({ where: { reviewId: seed.reviewId, commentType: "inline" } });
    expect(inlineRows).toHaveLength(0);
  });

  test("re-publishing the same review is deduped (no duplicate comments)", async () => {
    const seed = await seedReview("pub2");
    const anchored = await insertStoredFinding(seed.reviewId, seed.repositoryId, { lineNumber: 4 });
    const state = makeState(seed.headSha);
    const input = { ...makePublishInput(seed.reviewId, state, [anchored]) };

    const first = await publishReview(input);
    expect(first.outcome).toBe("published");
    expect(state.createReviewCalls).toHaveLength(1);

    // Second publication: the fingerprint markers persisted in review_comments
    // (and echoed on the PR by the fake) block every duplicate.
    const second = await publishReview(input);
    expect(second.outcome).toBe("already_published");
    expect(second.inlineCreated).toBe(0);
    expect(second.inlineDeduped).toBe(1);
    expect(state.createReviewCalls).toHaveLength(1); // no second createReview

    // Dedup also holds when the GitHub comments are no longer listed but the
    // publication rows remain (reconciliation via the DB placeholder).
    state.existingComments = [];
    state.existingReviews = [];
    const third = await publishReview(input);
    expect(third.outcome).toBe("already_published");
    expect(state.createReviewCalls).toHaveLength(1);
  });

  test("a summary already on the PR (by marker) prevents a second summary review", async () => {
    const seed = await seedReview("pub3");
    const anchored = await insertStoredFinding(seed.reviewId, seed.repositoryId, { lineNumber: 4 });
    const state = makeState(seed.headSha);
    await publishReview({ ...makePublishInput(seed.reviewId, state, [anchored]) });

    // Wipe the DB publication rows but keep the summary review on GitHub:
    // reconciliation must rely on the SUMMARY_MARKER in pulls.listReviews.
    await prisma.reviewComment.deleteMany({ where: { reviewId: seed.reviewId } });
    const again = await publishReview({ ...makePublishInput(seed.reviewId, state, [anchored]) });
    expect(again.outcome).toBe("already_published");
    expect(state.createReviewCalls).toHaveLength(1);
  });

  test("a new fingerprint after a deduped summary publishes a second review with only the new inline comment", async () => {
    const seed = await seedReview("pub4");
    const a = await insertStoredFinding(seed.reviewId, seed.repositoryId, { title: "First", lineNumber: 4 });
    const state = makeState(seed.headSha);
    const first = await publishReview({ ...makePublishInput(seed.reviewId, state, [a]) });
    expect(first.inlineCreated).toBe(1);

    // A brand-new finding on the same file: summary is deduped, inline is new.
    const b = await insertStoredFinding(seed.reviewId, seed.repositoryId, { title: "Second", fingerprint: "fp1:brand-new-issue", lineNumber: 5 });
    const second = await publishReview({ ...makePublishInput(seed.reviewId, state, [a, b]) });
    expect(second.outcome).toBe("published");
    expect(second.inlineCreated).toBe(1);
    expect(second.inlineDeduped).toBe(1);
    expect(state.createReviewCalls).toHaveLength(2);
    expect(state.createReviewCalls[1].comments[0].body).toContain("Second");
    // Two published inline rows now exist, each with its own comment id.
    const inlineRows = await prisma.reviewComment.findMany({ where: { reviewId: seed.reviewId, commentType: "inline" } });
    expect(inlineRows).toHaveLength(2);
    const ids = inlineRows.map((r) => Number(r.githubCommentId));
    expect(new Set(ids).size).toBe(2);
  });

  test("stale SHA protection rejects the whole publication when the PR head moved", async () => {
    const seed = await seedReview("pub5");
    const anchored = await insertStoredFinding(seed.reviewId, seed.repositoryId, { lineNumber: 4 });
    const state = makeState(seed.headSha);
    state.currentSha = "different-new-sha-after-push"; // PR advanced past the reviewed commit

    await expect(
      publishReview({ ...makePublishInput(seed.reviewId, state, [anchored], seed.headSha) }),
    ).rejects.toBeInstanceOf(StaleHeadError);

    // Nothing was published and nothing recorded (§4.4).
    expect(state.createReviewCalls).toHaveLength(0);
    expect(state.getPullCalls).toBe(1);
    expect(await prisma.reviewComment.findMany({ where: { reviewId: seed.reviewId } })).toHaveLength(0);
  });

  test("null head SHA from the API is also treated as stale", async () => {
    const seed = await seedReview("pub5b");
    const state = makeState(seed.headSha);
    state.currentSha = null;
    await expect(publishReview({ ...makePublishInput(seed.reviewId, state, [], seed.headSha) })).rejects.toBeInstanceOf(StaleHeadError);
  });

  test("createReview failures are retried; success after transient errors publishes", async () => {
    const seed = await seedReview("pub6");
    const anchored = await insertStoredFinding(seed.reviewId, seed.repositoryId, { lineNumber: 4 });
    const state = makeState(seed.headSha);
    state.failCreateTimes = 2; // fail twice, succeed on the third attempt

    const result = await publishReview({
      ...makePublishInput(seed.reviewId, state, [anchored]),
      retry: { maxAttempts: 3, baseDelayMs: 1 },
    });
    expect(result.outcome).toBe("published");
    expect(result.inlineCreated).toBe(1);
    expect(state.createReviewCalls).toHaveLength(3);
  });

  test("createReview exhausting retries throws and recordPublicationFailure persists the failure", async () => {
    const seed = await seedReview("pub7");
    const anchored = await insertStoredFinding(seed.reviewId, seed.repositoryId, { lineNumber: 4 });
    const state = makeState(seed.headSha);
    state.failCreateTimes = 999;

    await expect(
      publishReview({
        ...makePublishInput(seed.reviewId, state, [anchored]),
        retry: { maxAttempts: 2, baseDelayMs: 1 },
      }),
    ).rejects.toThrow(/createReview failed after 2 attempts/);
    // The failed attempt DID hit the API twice (retried).
    expect(state.createReviewCalls).toHaveLength(2);
    // Nothing was published, so nothing is marked published.
    expect(
      await prisma.reviewComment.count({ where: { reviewId: seed.reviewId, status: "published" } }),
    ).toBe(0);

    await recordPublicationFailure(prisma, seed.reviewId);
    const failed = await prisma.reviewComment.findFirst({ where: { reviewId: seed.reviewId, status: "failed" } });
    expect(failed?.commentType).toBe("summary");
    expect(failed?.githubCommentId).toBeNull();
  });

  test("a clean review publishes a COMMENT review with no inline comments", async () => {
    const seed = await seedReview("pub8");
    const state = makeState(seed.headSha);
    const result = await publishReview({ ...makePublishInput(seed.reviewId, state, []) });
    expect(result.outcome).toBe("clean_review_published");
    expect(state.createReviewCalls[0].event).toBe("COMMENT");
    expect(state.createReviewCalls[0].comments).toHaveLength(0);
    expect(state.createReviewCalls[0].body).toContain("No verified findings");
  });
});

describe("finalizeReview pipeline (engine → persist → publish → terminal state)", () => {
  test("happy path: persists findings, publishes and completes the review", async () => {
    const seed = await seedReview("fp1");
    await prisma.review.update({ where: { id: seed.reviewId }, data: { state: "validating" } });
    const state = makeState(seed.headSha);

    await finalizeReview(
      makeDeps(state),
      { payload: makePayload(seed.reviewId, seed.headSha), workspace: makeWorkspace(seed.headSha) },
      { result: makeResult(), meta: makeMeta() },
    );

    const review = await prisma.review.findUniqueOrThrow({ where: { id: seed.reviewId } });
    expect(review.state).toBe("completed");
    expect(review.completedAt).not.toBeNull();

    // Findings persisted (ticket 08) and publication rows recorded (ticket 09).
    const findings = await getFindingsForReview(prisma, seed.reviewId);
    expect(findings).toHaveLength(1);
    expect(findings[0].status).toBe("new");
    const rows = await prisma.reviewComment.findMany({ where: { reviewId: seed.reviewId } });
    expect(rows.some((r) => r.commentType === "summary" && r.status === "published")).toBe(true);
    expect(state.createReviewCalls[0].event).toBe("COMMENT");

    // State transitions are auditable: validating → publishing → completed.
    const transitions = await prisma.reviewStateTransition.findMany({
      where: { reviewId: seed.reviewId },
      orderBy: { createdAt: "asc" },
    });
    expect(transitions.map((t) => `${t.fromState}->${t.toState}`)).toEqual([
      "validating->publishing",
      "publishing->completed",
    ]);
  });

  test("logs one post-publication telemetry summary with per-stage token usage", async () => {
    const seed = await seedReview("fp-telemetry");
    await prisma.review.update({ where: { id: seed.reviewId }, data: { state: "validating" } });
    const state = makeState(seed.headSha);
    const info = vi.fn();
    const deps = makeDeps(state, {
      logger: { info, warn: () => {}, error: () => {}, debug: () => {} } as unknown as pino.Logger,
    });
    const meta = makeMeta();
    meta.usage = {
      modelCalls: [
        {
          stage: "initial-analysis",
          inputTokens: 900,
          outputTokens: 300,
          reasoningTokens: 120,
          durationMs: 1_000,
        },
        {
          stage: "reporting-prep",
          inputTokens: 400,
          outputTokens: 200,
          reasoningTokens: 30,
          durationMs: 800,
        },
      ],
      totalInputTokens: 1_300,
      totalOutputTokens: 500,
      durationMs: 1_800,
    };

    await finalizeReview(
      deps,
      { payload: makePayload(seed.reviewId, seed.headSha), workspace: makeWorkspace(seed.headSha) },
      { result: makeResult(), meta },
    );

    const telemetry = info.mock.calls
      .map(([record]) => record as Record<string, unknown>)
      .find((record) => record?.event === "review_telemetry");
    expect(telemetry).toBeDefined();
    expect(telemetry).toMatchObject({
      reviewId: seed.reviewId,
      repository: REPO_FULL_NAME,
      pullRequestNumber: PR_NUMBER,
      outcome: "published",
      modelCalls: 2,
      inputTokens: 1_300,
      outputTokens: 500,
      reasoningTokens: 150,
      totalTokens: 1_950,
      usagePersisted: true,
    });
    expect(telemetry?.calls).toEqual([
      { stage: "initial-analysis", input: 900, output: 300, reasoning: 120, durationMs: 1_000 },
      { stage: "reporting-prep", input: 400, output: 200, reasoning: 30, durationMs: 800 },
    ]);

    // The same totals are persisted on the review row (§16.1).
    const review = await prisma.review.findUniqueOrThrow({ where: { id: seed.reviewId } });
    expect(review.inputTokens).toBe(1_300);
    expect(review.outputTokens).toBe(500);
  });

  test("publication failure still logs telemetry and persists the tokens already spent", async () => {
    const seed = await seedReview("fp-telemetry-failed");
    await prisma.review.update({ where: { id: seed.reviewId }, data: { state: "validating" } });
    const state = makeState(seed.headSha);
    state.failCreateTimes = 999;
    const info = vi.fn();
    const deps = makeDeps(state, {
      logger: { info, warn: () => {}, error: () => {}, debug: () => {} } as unknown as pino.Logger,
    });
    const meta = makeMeta();
    meta.usage = {
      modelCalls: [
        { stage: "initial-analysis", inputTokens: 700, outputTokens: 100, durationMs: 500 },
      ],
      totalInputTokens: 700,
      totalOutputTokens: 100,
      durationMs: 500,
    };

    await finalizeReview(
      deps,
      { payload: makePayload(seed.reviewId, seed.headSha), workspace: makeWorkspace(seed.headSha) },
      { result: makeResult(), meta },
    );

    const telemetry = info.mock.calls
      .map(([record]) => record as Record<string, unknown>)
      .find((record) => record?.event === "review_telemetry");
    expect(telemetry).toMatchObject({
      outcome: "publication_failed",
      inputTokens: 700,
      outputTokens: 100,
      reasoningTokens: 0,
      usagePersisted: true,
    });
    const review = await prisma.review.findUniqueOrThrow({ where: { id: seed.reviewId } });
    expect(review.state).toBe("completed_with_warnings");
    expect(review.inputTokens).toBe(700);
    expect(review.outputTokens).toBe(100);
  });

  test("findings persistence failure → review failed with findings_persist_failed", async () => {
    vi.mocked(persistReviewFindings).mockRejectedValueOnce(new Error("persist exploded"));
    const seed = await seedReview("fp2");
    await prisma.review.update({ where: { id: seed.reviewId }, data: { state: "validating" } });
    const state = makeState(seed.headSha);

    await expect(
      finalizeReview(
        makeDeps(state),
        { payload: makePayload(seed.reviewId, seed.headSha), workspace: makeWorkspace(seed.headSha) },
        { result: makeResult(), meta: makeMeta() },
      ),
    ).rejects.toThrow("persist exploded");

    const review = await prisma.review.findUniqueOrThrow({ where: { id: seed.reviewId } });
    expect(review.state).toBe("failed");
    expect(review.errorCode).toBe("findings_persist_failed");
    // Nothing was published.
    expect(state.createReviewCalls).toHaveLength(0);
  });

  test("stale PR head at publish time → review failed with stale_commit, nothing published", async () => {
    const seed = await seedReview("fp3");
    await prisma.review.update({ where: { id: seed.reviewId }, data: { state: "validating" } });
    const state = makeState(seed.headSha);
    state.currentSha = "moved-on-sha"; // PR advanced between review and publish

    await expect(
      finalizeReview(
        makeDeps(state),
        { payload: makePayload(seed.reviewId, seed.headSha), workspace: makeWorkspace(seed.headSha) },
        { result: makeResult(), meta: makeMeta() },
      ),
    ).rejects.toBeInstanceOf(StaleHeadError);

    const review = await prisma.review.findUniqueOrThrow({ where: { id: seed.reviewId } });
    expect(review.state).toBe("failed");
    expect(review.errorCode).toBe("stale_commit");
    expect(state.createReviewCalls).toHaveLength(0);
    expect(await prisma.reviewComment.count({ where: { reviewId: seed.reviewId } })).toBe(0);
    // Findings were still persisted before the stale check (data retained).
    expect(await prisma.finding.count({ where: { reviewId: seed.reviewId } })).toBe(1);
  });

  test("GitHub API failure after retries → completed_with_warnings with a failure record", async () => {
    const seed = await seedReview("fp4");
    await prisma.review.update({ where: { id: seed.reviewId }, data: { state: "validating" } });
    const state = makeState(seed.headSha);
    state.failCreateTimes = 999;

    await finalizeReview(
      makeDeps(state),
      { payload: makePayload(seed.reviewId, seed.headSha), workspace: makeWorkspace(seed.headSha) },
      { result: makeResult(), meta: makeMeta() },
    );

    const review = await prisma.review.findUniqueOrThrow({ where: { id: seed.reviewId } });
    expect(review.state).toBe("completed_with_warnings");
    expect(review.completedAt).not.toBeNull();
    // Findings persisted, publication marked failed, no published comments.
    expect(await prisma.finding.count({ where: { reviewId: seed.reviewId } })).toBe(1);
    const failedRow = await prisma.reviewComment.findFirst({ where: { reviewId: seed.reviewId, status: "failed" } });
    expect(failedRow).not.toBeNull();
    expect(await prisma.reviewComment.count({ where: { reviewId: seed.reviewId, status: "published" } })).toBe(0);
  });

  test("review already in a terminal state is not published again", async () => {
    const seed = await seedReview("fp5");
    await prisma.review.update({ where: { id: seed.reviewId }, data: { state: "superseded" } });
    const state = makeState(seed.headSha);

    // The engine hook would have driven the state machine; with the review
    // superseded, finalizeReview must fail loudly rather than publish.
    await expect(
      finalizeReview(
        makeDeps(state),
        { payload: makePayload(seed.reviewId, seed.headSha), workspace: makeWorkspace(seed.headSha) },
        { result: makeResult(), meta: makeMeta() },
      ),
    ).rejects.toThrow(/Invalid review state transition|superseded/);
    expect(state.createReviewCalls).toHaveLength(0);
  });
});
