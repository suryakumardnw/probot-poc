import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type pino from "pino";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { reviewConfigSchema, type ReviewConfig } from "../../src/contracts/config.js";
import type { ReviewJobPayload } from "../../src/contracts/queue.js";
import type { StoredFinding } from "../../src/modules/findings/index.js";
import {
  createFindingsDependencies,
  getFindingsForReview,
  persistReviewFindings,
  supersedeFindingsForReview,
} from "../../src/modules/findings/index.js";
import { parseUnifiedDiff, resolveInlinePosition } from "../../src/modules/publishing/diff-positions.js";
import { finalizeReview, type ReviewPipelineDeps } from "../../src/modules/publishing/pipeline.js";
import { createPublishingRepositories } from "../../src/modules/publishing/prisma-publishing.repository.js";
import {
  DEFAULT_RETRY,
  StaleHeadError,
  appendSummaryMarker,
  isRetryableGitHubError,
  publishReview,
  recordPublicationFailure,
  withRetry,
  type PublisherOctokit,
  type ReviewCommentParams,
} from "../../src/modules/publishing/publisher.js";
import {
  buildInlineCommentBody,
  buildReviewBody,
  extractFingerprint,
  fingerprintMarker,
} from "../../src/modules/publishing/summary.js";
import type { Finding, FindingEvidence, ReviewResult } from "../../src/modules/review/index.js";
import type { ReviewRunMetadata } from "../../src/modules/review/types.js";
import type { WorkspaceResult } from "../../src/modules/workspace/workspace.js";
import { createObservability } from "../../src/platform/observability/index.js";
import type { AgentRuntime } from "../../src/ports/agent-runtime.js";
import { at, defined, first } from "../helpers/assert.js";
import { prisma, disconnectDatabase } from "../helpers/db.js";
import { createTestReviewState } from "../helpers/ingestion.js";

/**
 * Ticket 09 tests: diff position resolution, review body generation,
 * publication via a fake octokit (dedup, stale SHA protection, retries,
 * COMMENT-only) and the end-to-end pipeline wiring through `finalizeReview`
 * (real Postgres, ARCHITECTURE.md §4.3/§4.4, §6.4, §7.4, §13.1).
 */

// persistReviewFindings is mocked so the persistence-failure path of
// finalizeReview can be exercised deterministically; every other export of
// the findings module stays real.
vi.mock("../../src/modules/findings/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/modules/findings/index.js")>();
  return { ...actual, persistReviewFindings: vi.fn(actual.persistReviewFindings) };
});

process.env.DATABASE_URL ??= "postgres://postgres:postgres@localhost:5432/reviewer";

const publishing = createPublishingRepositories(prisma);

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
  if (!base.fingerprint) {
    base.fingerprint = `fp1:${base.title.replace(/\s+/g, "-").toLowerCase()}-test`;
  }
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
  /** Errors thrown by successive createReview calls (before failCreateTimes). */
  createReviewErrors: unknown[];
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
        createReview: async (params: { event: string; body: string; comments?: ReviewCommentParams[] }) => {
          state.createReviewCalls.push({
            event: params.event,
            body: params.body,
            comments: params.comments ?? [],
          });
          const queuedError = state.createReviewErrors.shift();
          if (queuedError !== undefined) {
            throw queuedError;
          }
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
          for (const c of created) {
            state.existingComments.push(c);
          }
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
    createReviewErrors: [],
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
    comments: publishing.comments,
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
    reviewMode: "adaptive",
    reviewType: "standard",
    trigger: "synchronized",
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
    observability: createObservability(),
    transitionReviewState: createTestReviewState().transitionReviewState,
    publishing,
    findings: createFindingsDependencies(prisma),
    knowledge: {
      materialize: async () => ({ knowledgeDir: null, snapshot: null }),
      persistMetrics: async () => {},
    },
    tokenProvider: {
      getInstallationToken: async () => ({
        token: "fake-installation-token",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    },
    env: process.env,
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
  await disconnectDatabase();
});

beforeEach(async () => {
  await cleanDatabase();
});

afterEach(async () => {
  vi.mocked(persistReviewFindings).mockClear();
});

describe("diff position resolution (§7.4)", () => {
  test("parses hunks with correct old/new line numbers", () => {
    const app = defined(diffFiles.get("src/app.js"), "app diff");
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
    const file = defined(files.get("src/new.js"), "new file diff");
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
    expect(body).toContain("<!-- review-bot:v1 rule=SECURITY fp=fp1:abc sev=high conf=0.9 -->");
    expect(body).toContain("🔴 Leak");
    expect(body).toContain("High · Security · Confidence: High (90%)");
    expect(body).toContain("a secret may leak here");
    expect(body).not.toContain("Technical details");
    expect(fingerprintMarker("fp1:abc")).not.toMatch(/[A-Za-z]\s+secret/); // hidden marker format
  });

  test("extractFingerprint tolerates whitespace inside the marker", () => {
    expect(extractFingerprint("x <!--  ai-pr-reviewer:fingerprint:fp1:zzz  --> y")).toBe("fp1:zzz");
    expect(extractFingerprint("x <!--  review-bot:v1 rule=RULE fp=fp1:zzz sev=low conf=0.5  --> y")).toBe("fp1:zzz");
    expect(extractFingerprint("no marker")).toBeNull();
  });

  test("uncertain findings only appear when configured, never as inline content", () => {
    const verified: StoredFinding[] = [
      {
        id: "v1",
        fingerprint: "fp-v",
        category: "maintainability",
        severity: "medium",
        confidence: 0.9,
        title: "V",
        filePath: "a.js",
        lineNumber: 1,
        description: "a verified problem",
        verified: true,
        status: "new",
        reopened: false,
      },
    ];
    const uncertain: StoredFinding[] = [
      {
        id: "u1",
        fingerprint: "fp-u",
        category: "maintainability",
        severity: "low",
        confidence: 0.5,
        title: "U",
        filePath: "a.js",
        lineNumber: 2,
        description: "a maybe problem",
        verified: false,
        status: "uncertain",
        reopened: false,
      },
    ];
    const withUncertain = buildReviewBody({
      summary: "s",
      verified,
      uncertain,
      config: { publishUncertainInSummary: true, publishCleanReview: true },
    });
    expect(withUncertain).toContain("V");
    expect(withUncertain).toContain("Additional observation (1, unverified)");
    expect(withUncertain).toContain("U");

    const withoutUncertain = buildReviewBody({
      summary: "s",
      verified,
      uncertain,
      config: { publishUncertainInSummary: false, publishCleanReview: true },
    });
    expect(withoutUncertain).not.toContain("Additional observation");
  });

  test("clean reviews publish a short message when enabled, nothing when disabled", () => {
    const input = {
      summary: "no issues",
      verified: [],
      uncertain: [],
      config: { publishUncertainInSummary: true, publishCleanReview: true },
    };
    expect(buildReviewBody(input)).toContain("No confirmed findings");
    expect(buildReviewBody({ ...input, config: { ...input.config, publishCleanReview: false } })).not.toContain(
      "No confirmed findings",
    );
  });

  test("renders a flat numbered list of findings, most severe first", () => {
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

    expect(body).toContain("**Changes requested** · 1 high · 1 medium · 1 low");
    expect(body.indexOf("## Findings (3)")).toBeGreaterThan(-1);
    expect(body.indexOf("### 1. Unredacted dump")).toBeGreaterThan(-1);
    expect(body.indexOf("### 2. Unbounded write")).toBeGreaterThan(body.indexOf("### 1. Unredacted dump"));
    expect(body.indexOf("### 3. Naming drift")).toBeGreaterThan(body.indexOf("### 2. Unbounded write"));
    expect(body).toContain("`src/app.js:2` · Security");
    expect(body).toContain("Technical details");
    expect(body).not.toContain("Findings at a glance");
  });

  test("renders impact and suggested fix when the finding carries them", () => {
    const body = buildReviewBody({
      summary: "s",
      verified: [
        finding({
          category: "dataIntegrity",
          severity: "high",
          title: "Counts cover only one page",
          impact: "Per-status counts can disagree with the total.",
          recommendation: "Aggregate in SQL instead of loading a page.",
          guideline: "03_contracts-schemas.md §3",
          evidence: [{ file: "src/app.js", line: 2, excerpt: "count()", reason: "counts the full table" }],
        }),
      ],
      uncertain: [],
      config: { publishUncertainInSummary: true, publishCleanReview: true },
    });
    expect(body).toContain("**Impact:** Per-status counts can disagree with the total.");
    expect(body).toContain("**Suggested fix:** Aggregate in SQL instead of loading a page.");
    expect(body).toContain("- Guideline: 03_contracts-schemas.md §3");
    expect(body).toContain("- Evidence: `src/app.js:2` — counts the full table");
  });

  test("derives the verdict from the most severe finding", () => {
    const high = buildReviewBody({
      summary: "s",
      verified: [finding({ category: "security", severity: "high" })],
      uncertain: [],
      config: { publishUncertainInSummary: true, publishCleanReview: true },
    });
    expect(high).toContain("**Changes requested** · 1 high");

    const low = buildReviewBody({
      summary: "s",
      verified: [finding({ category: "maintainability", severity: "low" })],
      uncertain: [],
      config: { publishUncertainInSummary: true, publishCleanReview: true },
    });
    expect(low).toContain("**Comment** · 1 low");
  });

  test("renders PR title and compact metadata footer", () => {
    const body = buildReviewBody({
      summary: "s",
      verified: [],
      uncertain: [],
      config: { publishUncertainInSummary: true, publishCleanReview: true },
      meta: {
        reviewer: "ai-pr-reviewer",
        source: "acme/widgets#42 @ abc1234",
        model: "workers-ai/@cf/zai-org/glm-4.7-flash",
        reviewedAt: new Date("2026-11-12T00:30:00Z"),
        timezone: "UTC",
      },
    });
    expect(body).toContain("# PR #42 Review");
    expect(body).toContain("<sub>GLM 4.7 Flash · 12 Nov 2026 · `abc1234`</sub>");
    expect(body).not.toContain("**Source:**");
    expect(body).not.toContain("**Review Date:**");
  });

  test("clean reviews report no concerns and omit finding sections", () => {
    const body = buildReviewBody({
      summary: "no issues",
      verified: [],
      uncertain: [],
      config: { publishUncertainInSummary: true, publishCleanReview: true },
    });
    expect(body).toContain("**No changes requested** · 0 confirmed findings");
    expect(body).not.toMatch(/^## 1\./m);
    expect(body).toContain("Break glass");
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
        if (attempts < 3) {
          throw new Error("boom");
        }
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

describe("GitHub error classification", () => {
  const withStatus = (status: number) => Object.assign(new Error("api error"), { status });

  test("transient statuses and unknown failures are retryable", () => {
    for (const status of [408, 409, 429, 500, 502, 503]) {
      expect(isRetryableGitHubError(withStatus(status))).toBe(true);
    }
    expect(isRetryableGitHubError(new Error("socket closed"))).toBe(true);
  });

  test("deterministic client errors are not retried", () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(isRetryableGitHubError(withStatus(status))).toBe(false);
    }
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

    const call = first(state.createReviewCalls);
    // §23: the review event is ALWAYS COMMENT — never APPROVE / REQUEST_CHANGES.
    expect(call.event).toBe("COMMENT");
    expect(call.event === "APPROVE" || call.event === "REQUEST_CHANGES").toBe(false);
    expect(call.body).toContain("Stored issue");
    expect(call.body).toContain("ai-pr-reviewer:summary");
    expect(call.comments).toHaveLength(1);
    expect(first(call.comments)).toMatchObject({ path: "src/app.js", line: 4, side: "RIGHT" });
    expect(extractFingerprint(first(call.comments).body)).toBe(anchored.fingerprint);

    // §13.1: publication rows are persisted with the GitHub ids.
    const rows = await prisma.reviewComment.findMany({ where: { reviewId: seed.reviewId } });
    expect(rows).toHaveLength(2); // one summary + one inline
    const inline = defined(
      rows.find((r) => r.commentType === "inline"),
      "inline review comment",
    );
    expect(inline.githubCommentId).toBeTypeOf("bigint");
    expect(Number(defined(inline.githubCommentId, "inline comment id"))).toBeGreaterThan(0);
    expect(inline.fingerprint).toBe(anchored.fingerprint);
    const summaryRow = rows.find((r) => r.commentType === "summary");
    expect(summaryRow?.githubCommentId).not.toBeNull();
  });

  test("summary disabled publishes inline comments only, without a summary body or row", async () => {
    const seed = await seedReview("pub-inline-only");
    const anchored = await insertStoredFinding(seed.reviewId, seed.repositoryId, {
      filePath: "src/app.js",
      lineNumber: 4,
    });
    const deletedLine = await insertStoredFinding(seed.reviewId, seed.repositoryId, {
      filePath: "src/mod.js",
      lineNumber: 6,
    });
    const state = makeState(seed.headSha);
    const input = makePublishInput(seed.reviewId, state, [anchored, deletedLine]);
    const inlineOnlyInput = {
      ...input,
      config: { ...input.config, publishSummary: false },
    };
    const result = await publishReview(inlineOnlyInput);

    expect(result.outcome).toBe("published");
    expect(result.inlineCreated).toBe(1);
    expect(result.summaryOnlyFindings).toBe(1);
    expect(state.createReviewCalls).toHaveLength(1);

    const call = first(state.createReviewCalls);
    expect(call.body).toBe("");
    expect(call.comments).toHaveLength(1);
    expect(extractFingerprint(first(call.comments).body)).toBe(anchored.fingerprint);

    const rows = await prisma.reviewComment.findMany({ where: { reviewId: seed.reviewId } });
    expect(rows.some((row) => row.commentType === "summary")).toBe(false);
    expect(rows.filter((row) => row.commentType === "inline")).toHaveLength(1);

    const second = await publishReview(inlineOnlyInput);
    expect(second.outcome).toBe("already_published");
    expect(second.inlineCreated).toBe(0);
    expect(state.createReviewCalls).toHaveLength(1);
  });

  test("summary disabled skips publication when no finding can be anchored inline", async () => {
    const seed = await seedReview("pub-inline-only-skip");
    const deletedLine = await insertStoredFinding(seed.reviewId, seed.repositoryId, {
      filePath: "src/mod.js",
      lineNumber: 6,
    });
    const state = makeState(seed.headSha);
    const input = makePublishInput(seed.reviewId, state, [deletedLine]);
    const result = await publishReview({
      ...input,
      config: { ...input.config, publishSummary: false },
    });

    expect(result.outcome).toBe("nothing_to_publish");
    expect(result.reviewId).toBeNull();
    expect(state.createReviewCalls).toHaveLength(0);
    expect(await prisma.reviewComment.count({ where: { reviewId: seed.reviewId } })).toBe(0);
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
    expect(first(state.createReviewCalls).comments).toHaveLength(0);
    expect(first(state.createReviewCalls).body).toContain("Additional observation (1, unverified)");
    // Uncertain findings are not recorded as published inline comments.
    const inlineRows = await prisma.reviewComment.findMany({
      where: { reviewId: seed.reviewId, commentType: "inline" },
    });
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
    const firstPublish = await publishReview({ ...makePublishInput(seed.reviewId, state, [a]) });
    expect(firstPublish.inlineCreated).toBe(1);

    // A brand-new finding on the same file: summary is deduped, inline is new.
    const b = await insertStoredFinding(seed.reviewId, seed.repositoryId, {
      title: "Second",
      fingerprint: "fp1:brand-new-issue",
      lineNumber: 5,
    });
    const second = await publishReview({ ...makePublishInput(seed.reviewId, state, [a, b]) });
    expect(second.outcome).toBe("published");
    expect(second.inlineCreated).toBe(1);
    expect(second.inlineDeduped).toBe(1);
    expect(state.createReviewCalls).toHaveLength(2);
    expect(first(at(state.createReviewCalls, 1).comments).body).toContain("Second");
    // Two published inline rows now exist, each with its own comment id.
    const inlineRows = await prisma.reviewComment.findMany({
      where: { reviewId: seed.reviewId, commentType: "inline" },
    });
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
    await expect(publishReview({ ...makePublishInput(seed.reviewId, state, [], seed.headSha) })).rejects.toBeInstanceOf(
      StaleHeadError,
    );
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

  test("a 422 path rejection falls back to a summary-only review instead of failing", async () => {
    const seed = await seedReview("pub-path");
    const anchored = await insertStoredFinding(seed.reviewId, seed.repositoryId, { lineNumber: 4 });
    const state = makeState(seed.headSha);
    state.createReviewErrors.push(
      Object.assign(new Error("Unprocessable Entity: Path could not be resolved"), { status: 422 }),
    );

    const result = await publishReview({
      ...makePublishInput(seed.reviewId, state, [anchored]),
      retry: { maxAttempts: 3, baseDelayMs: 1 },
    });

    // The 422 is not retried three times; one summary-only retry is made.
    expect(state.createReviewCalls).toHaveLength(2);
    expect(first(state.createReviewCalls).comments).toHaveLength(1);
    expect(at(state.createReviewCalls, 1).comments).toHaveLength(0);
    expect(at(state.createReviewCalls, 1).body).toContain("Stored issue");
    expect(result.outcome).toBe("published");
    expect(result.inlineCreated).toBe(0);
    expect(result.summaryOnlyFindings).toBe(1);
    // Nothing was published inline, so no inline rows are recorded.
    expect(
      await prisma.reviewComment.findMany({ where: { reviewId: seed.reviewId, commentType: "inline" } }),
    ).toHaveLength(0);
    const summary = await prisma.reviewComment.findFirst({
      where: { reviewId: seed.reviewId, commentType: "summary" },
    });
    expect(summary?.status).toBe("published");
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
    expect(await prisma.reviewComment.count({ where: { reviewId: seed.reviewId, status: "published" } })).toBe(0);

    await recordPublicationFailure(publishing.comments, seed.reviewId);
    const failed = await prisma.reviewComment.findFirst({ where: { reviewId: seed.reviewId, status: "failed" } });
    expect(failed?.commentType).toBe("summary");
    expect(failed?.githubCommentId).toBeNull();
  });

  test("a clean review publishes a COMMENT review with no inline comments", async () => {
    const seed = await seedReview("pub8");
    const state = makeState(seed.headSha);
    const result = await publishReview({ ...makePublishInput(seed.reviewId, state, []) });
    expect(result.outcome).toBe("clean_review_published");
    expect(first(state.createReviewCalls).event).toBe("COMMENT");
    expect(first(state.createReviewCalls).comments).toHaveLength(0);
    expect(first(state.createReviewCalls).body).toContain("No confirmed findings");
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
    const findings = await getFindingsForReview(seed.reviewId, makeDeps(state).findings);
    expect(findings).toHaveLength(1);
    expect(first(findings).status).toBe("new");
    const rows = await prisma.reviewComment.findMany({ where: { reviewId: seed.reviewId } });
    expect(rows.some((r) => r.commentType === "summary" && r.status === "published")).toBe(true);
    expect(first(state.createReviewCalls).event).toBe("COMMENT");

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

  test("publication reads only active findings in deterministic severity-rank order", async () => {
    const seed = await seedReview("fp-active-order");
    await prisma.review.update({ where: { id: seed.reviewId }, data: { state: "validating" } });

    // A finding of this review that a newer review superseded must never be
    // published, even though it still points at this review id.
    const inactive = await insertStoredFinding(seed.reviewId, seed.repositoryId, {
      title: "Superseded issue",
      fingerprint: "fp1:superseded-issue",
      severity: "high",
      lineNumber: 2,
    });
    expect(await supersedeFindingsForReview(seed.reviewId, "newer-review-id", createFindingsDependencies(prisma))).toBe(
      1,
    );

    // Persist in the opposite order of the repository's read order
    // (verified desc, severity rank, createdAt asc).
    const medium = makeFinding({ title: "Medium issue", severity: "medium", line: 2 });
    const critical = makeFinding({
      title: "Critical issue",
      severity: "critical",
      line: 4,
      description: "the added return line is unsafe",
      evidence: evidence({ line: 4, excerpt: "  return a + b; // fine" }),
    });
    const state = makeState(seed.headSha);

    await finalizeReview(
      makeDeps(state),
      { payload: makePayload(seed.reviewId, seed.headSha), workspace: makeWorkspace(seed.headSha) },
      { result: makeResult({ findings: [medium, critical] }), meta: makeMeta() },
    );

    expect(state.createReviewCalls).toHaveLength(1);
    const call = first(state.createReviewCalls);
    expect(call.comments).toHaveLength(2);
    // Severity-rank repository order, not the persist order.
    expect(first(call.comments)?.body).toContain("Critical issue");
    expect(call.comments[1]?.body).toContain("Medium issue");
    expect(call.body).not.toContain("Superseded issue");

    expect(await prisma.reviewComment.count({ where: { reviewId: seed.reviewId, findingId: inactive.id } })).toBe(0);
    const inlineRows = await prisma.reviewComment.findMany({
      where: { reviewId: seed.reviewId, commentType: "inline" },
    });
    expect(inlineRows).toHaveLength(2);
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
      modelCalls: [{ stage: "initial-analysis", inputTokens: 700, outputTokens: 100, durationMs: 500 }],
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
