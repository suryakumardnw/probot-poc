import { afterAll, beforeEach, describe, expect, test } from "vitest";
import type { StoredFinding } from "../../src/findings/index.js";
import {
  StaleHeadError,
  publishReview,
  type PublisherOctokit,
  type ReviewCommentParams,
} from "../../src/publishing/publisher.js";
import { cleanDatabase, disconnectDatabase, prisma, seedReviewChain, silentLogger } from "./support.js";

/**
 * Characterization: GitHub publication (ARCHITECTURE.md §4.4, §7.4, §13.1).
 *
 * `publishReview` is exercised through a fake Octokit (the injectable GitHub
 * boundary). Assertions cover the API calls GitHub would observe and the
 * durable publication rows the rest of the system reads.
 */

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
].join("\n");

interface FakeState {
  currentSha: string | null;
  existingComments: Array<{ id: number; body: string | null }>;
  existingReviews: Array<{ id: number; body: string | null; state: string }>;
  createReviewErrors: unknown[];
  createReviewCalls: Array<{ event: string; body: string; comments: ReviewCommentParams[] }>;
}

let commentIdSeq = 20_000;
let findingSeq = 0;

function makeFakeState(currentSha: string | null): FakeState {
  return {
    currentSha,
    existingComments: [],
    existingReviews: [],
    createReviewErrors: [],
    createReviewCalls: [],
  };
}

function makeFakeOctokit(state: FakeState): PublisherOctokit {
  return {
    rest: {
      pulls: {
        get: async () => ({ data: { head: { sha: state.currentSha } } }),
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
          const created = (params.comments ?? []).map((comment) => {
            commentIdSeq += 1;
            return { id: commentIdSeq, body: comment.body };
          });
          // Mirror GitHub: created comments/reviews become visible to later listings.
          state.existingComments.push(...created);
          state.existingReviews.push({ id: 7001, body: params.body, state: params.event });
          return { data: { id: 7001, comments: created } };
        },
      },
    },
  } as unknown as PublisherOctokit;
}

async function insertStoredFinding(
  chain: { reviewId: string; repositoryId: string },
  overrides: Partial<StoredFinding> = {},
): Promise<StoredFinding> {
  findingSeq += 1;
  const base: StoredFinding = {
    id: "",
    fingerprint: `fp1:characterization-${findingSeq}`,
    category: "maintainability",
    severity: "medium",
    confidence: 0.9,
    title: `Characterized issue ${findingSeq}`,
    filePath: "src/app.js",
    lineNumber: 4,
    description: "a real problem in the added code",
    verified: true,
    status: "new",
    reopened: false,
    ...overrides,
  };
  const row = await prisma.finding.create({
    data: {
      reviewId: chain.reviewId,
      repositoryId: chain.repositoryId,
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

function makeInput(
  chain: { reviewId: string; repositoryFullName: string; headSha: string },
  state: FakeState,
  findings: StoredFinding[],
  headSha = state.currentSha ?? chain.headSha,
) {
  return {
    prisma,
    octokit: makeFakeOctokit(state),
    reviewId: chain.reviewId,
    repositoryFullName: chain.repositoryFullName,
    pullNumber: 101,
    headSha,
    diff: DIFF,
    summary: "The change introduces one verified issue.",
    findings,
    config: { publishUncertainInSummary: true, publishCleanReview: true },
    retry: { maxAttempts: 3, baseDelayMs: 1 },
    logger: silentLogger,
  };
}

const githubStatusError = (status: number, message: string) => Object.assign(new Error(message), { status });

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectDatabase();
});

describe("publication guards (§4.4, §7.4)", () => {
  test("a stale head rejects the whole publication and records nothing", async () => {
    const chain = await seedReviewChain({ prefix: "publish-stale" });
    const finding = await insertStoredFinding(chain);
    const state = makeFakeState("moved-on-after-review");

    await expect(publishReview(makeInput(chain, state, [finding], chain.headSha))).rejects.toBeInstanceOf(
      StaleHeadError,
    );

    expect(state.createReviewCalls).toHaveLength(0);
    expect(await prisma.reviewComment.count({ where: { reviewId: chain.reviewId } })).toBe(0);
  });

  test("an invalid inline position falls back to the summary body", async () => {
    const chain = await seedReviewChain({ prefix: "publish-position" });
    const unanchored = await insertStoredFinding(chain, {
      title: "Not in the diff",
      filePath: "src/missing.js",
      lineNumber: 1,
    });
    const state = makeFakeState(chain.headSha);

    const result = await publishReview(makeInput(chain, state, [unanchored]));

    expect(result.outcome).toBe("published");
    expect(result.inlineCreated).toBe(0);
    expect(result.summaryOnlyFindings).toBe(1);
    expect(state.createReviewCalls).toHaveLength(1);
    expect(state.createReviewCalls[0]!.event).toBe("COMMENT");
    expect(state.createReviewCalls[0]!.comments).toEqual([]);
    expect(state.createReviewCalls[0]!.body).toContain("Not in the diff");
    expect(state.createReviewCalls[0]!.body).toContain("ai-pr-reviewer:summary");

    const rows = await prisma.reviewComment.findMany({ where: { reviewId: chain.reviewId } });
    expect(rows.map((row) => row.commentType)).toEqual(["summary"]);
  });

  test("re-publishing never creates a second summary or duplicate inline comments", async () => {
    const chain = await seedReviewChain({ prefix: "publish-dedupe" });
    const anchored = await insertStoredFinding(chain, { title: "Anchored issue" });
    const state = makeFakeState(chain.headSha);

    const first = await publishReview(makeInput(chain, state, [anchored]));
    expect(first.outcome).toBe("published");
    expect(first.inlineCreated).toBe(1);
    expect(state.createReviewCalls).toHaveLength(1);
    const rowsAfterFirst = await prisma.reviewComment.count({ where: { reviewId: chain.reviewId } });
    expect(rowsAfterFirst).toBe(2);

    const second = await publishReview(makeInput(chain, state, [anchored]));
    expect(second.outcome).toBe("already_published");
    expect(second.inlineCreated).toBe(0);
    expect(second.inlineDeduped).toBe(1);
    expect(state.createReviewCalls).toHaveLength(1);
    expect(await prisma.reviewComment.count({ where: { reviewId: chain.reviewId } })).toBe(rowsAfterFirst);

    // Even without the durable rows, the marker echoed on GitHub prevents a
    // duplicate summary; the comment fingerprint prevents a duplicate inline.
    await prisma.reviewComment.deleteMany({ where: { reviewId: chain.reviewId } });
    const third = await publishReview(makeInput(chain, state, [anchored]));
    expect(third.outcome).toBe("already_published");
    expect(state.createReviewCalls).toHaveLength(1);
  });
});

describe("GitHub error handling", () => {
  test("5xx responses are retried and a later success publishes", async () => {
    const chain = await seedReviewChain({ prefix: "publish-5xx" });
    const finding = await insertStoredFinding(chain);
    const state = makeFakeState(chain.headSha);
    state.createReviewErrors.push(githubStatusError(502, "Bad Gateway"), githubStatusError(503, "Service Unavailable"));

    const result = await publishReview(makeInput(chain, state, [finding]));

    expect(result.outcome).toBe("published");
    expect(state.createReviewCalls).toHaveLength(3);
    expect(await prisma.reviewComment.count({ where: { reviewId: chain.reviewId, status: "published" } })).toBe(2);
  });

  test("4xx responses are not retried", async () => {
    const chain = await seedReviewChain({ prefix: "publish-4xx" });
    const finding = await insertStoredFinding(chain);
    const state = makeFakeState(chain.headSha);
    state.createReviewErrors.push(githubStatusError(400, "bad request"));

    await expect(publishReview(makeInput(chain, state, [finding]))).rejects.toThrow(/bad request/);

    expect(state.createReviewCalls).toHaveLength(1);
    expect(await prisma.reviewComment.count({ where: { reviewId: chain.reviewId } })).toBe(0);
  });
});
