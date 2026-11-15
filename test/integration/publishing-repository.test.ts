import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { createPublishingRepositories } from "../../src/modules/publishing/prisma-publishing.repository.js";
import {
  cleanDatabase,
  disconnectDatabase,
  prisma,
  seedReviewChain,
  type SeededReviewChain,
} from "../characterization/support.js";

/**
 * Integration: publishing repository against real PostgreSQL.
 *
 * These tests pin the persistence contract the publisher relies on:
 * publication rows commit atomically with their GitHub ids, failed attempts
 * are recorded without a GitHub id, reconciliation reads see only published
 * rows, and the review-row publication state (skip flag, token usage) is
 * updated through the repository.
 */

const publishing = createPublishingRepositories(prisma);

async function insertFinding(chain: SeededReviewChain, fingerprint: string): Promise<string> {
  const row = await prisma.finding.create({
    data: {
      reviewId: chain.reviewId,
      repositoryId: chain.repositoryId,
      fingerprint,
      category: "maintainability",
      severity: "medium",
      confidence: 0.9,
      title: "Repository fixture finding",
      filePath: "src/app.js",
      lineNumber: 4,
      description: "a real problem in the added code",
      evidence: [],
      verified: true,
      status: "new",
    },
  });
  return row.id;
}

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectDatabase();
});

describe("review comment repository", () => {
  test("records the summary and inline comments with their GitHub ids", async () => {
    const chain = await seedReviewChain({ prefix: "publishing-repo-commit" });
    const findingId = await insertFinding(chain, "fp1:repo-commit");
    const withoutId = await insertFinding(chain, "fp1:repo-commit-no-id");

    await publishing.comments.recordPublication({
      reviewId: chain.reviewId,
      summary: { githubCommentId: 7001 },
      inlineComments: [
        { findingId, fingerprint: "fp1:repo-commit", githubCommentId: 9001 },
        { findingId: withoutId, fingerprint: "fp1:repo-commit-no-id", githubCommentId: null },
      ],
    });

    const rows = await prisma.reviewComment.findMany({ where: { reviewId: chain.reviewId } });
    expect(rows).toHaveLength(3);

    const summary = rows.find((row) => row.commentType === "summary");
    expect(summary?.status).toBe("published");
    expect(summary?.githubCommentId).toBe(7001n);
    expect(summary?.findingId).toBeNull();

    const inline = rows.filter((row) => row.commentType === "inline");
    expect(inline.map((row) => row.fingerprint).sort()).toEqual(["fp1:repo-commit", "fp1:repo-commit-no-id"]);
    expect(inline.find((row) => row.fingerprint === "fp1:repo-commit")?.githubCommentId).toBe(9001n);
    expect(inline.find((row) => row.fingerprint === "fp1:repo-commit-no-id")?.githubCommentId).toBeNull();

    expect(await publishing.comments.findPublishedSummaryCommentId(chain.reviewId)).toBe(7001);
    expect(await publishing.comments.listPublishedFingerprints(chain.reviewId)).toEqual(
      expect.arrayContaining([
        { fingerprint: "fp1:repo-commit", githubCommentId: 9001 },
        { fingerprint: "fp1:repo-commit-no-id", githubCommentId: null },
      ]),
    );
  });

  test("rolls back the summary row when an inline row cannot be written", async () => {
    const chain = await seedReviewChain({ prefix: "publishing-repo-rollback" });

    await expect(
      publishing.comments.recordPublication({
        reviewId: chain.reviewId,
        summary: { githubCommentId: 7001 },
        inlineComments: [
          {
            findingId: "missing-finding-id",
            fingerprint: "fp1:missing",
            githubCommentId: 9001,
          },
        ],
      }),
    ).rejects.toThrow();

    expect(await prisma.reviewComment.count({ where: { reviewId: chain.reviewId } })).toBe(0);
  });

  test("records a best-effort failure row without a GitHub id", async () => {
    const chain = await seedReviewChain({ prefix: "publishing-repo-failure" });

    await publishing.comments.recordFailure(chain.reviewId);

    const failed = await prisma.reviewComment.findFirst({ where: { reviewId: chain.reviewId } });
    expect(failed?.commentType).toBe("summary");
    expect(failed?.status).toBe("failed");
    expect(failed?.githubCommentId).toBeNull();
    expect(await publishing.comments.findPublishedSummaryCommentId(chain.reviewId)).toBeNull();
    expect(await publishing.comments.listPublishedFingerprints(chain.reviewId)).toEqual([]);

    // Recording a failure for a row that no longer exists is swallowed.
    await expect(publishing.comments.recordFailure("missing-review-id")).resolves.toBeUndefined();
  });

  test("reconciliation reads only published rows that carry a fingerprint", async () => {
    const chain = await seedReviewChain({ prefix: "publishing-repo-read" });
    await prisma.reviewComment.createMany({
      data: [
        { reviewId: chain.reviewId, commentType: "summary", status: "published" },
        { reviewId: chain.reviewId, commentType: "inline", status: "failed", fingerprint: "fp1:failed" },
        { reviewId: chain.reviewId, commentType: "inline", status: "superseded", fingerprint: "fp1:superseded" },
        { reviewId: chain.reviewId, commentType: "inline", status: "published", fingerprint: "fp1:published" },
      ],
    });

    expect(await publishing.comments.listPublishedFingerprints(chain.reviewId)).toEqual([
      { fingerprint: "fp1:published", githubCommentId: null },
    ]);
    expect(await publishing.comments.findPublishedSummaryCommentId(chain.reviewId)).toBeNull();
  });
});

describe("review publication state repository", () => {
  test("reads the review context, records the skip flag and token usage", async () => {
    const chain = await seedReviewChain({ prefix: "publishing-repo-state", reviewType: "skill" });

    expect(await publishing.reviews.findReviewContext(chain.reviewId)).toEqual({
      reviewId: chain.reviewId,
      reviewType: "skill",
      repositoryId: chain.repositoryId,
    });
    expect(await publishing.reviews.findReviewContext("missing-review-id")).toBeNull();

    await publishing.reviews.markPublishSkipped(chain.reviewId);
    await publishing.reviews.recordUsage({
      reviewId: chain.reviewId,
      inputTokens: 1_300,
      outputTokens: 500,
    });

    const review = await prisma.review.findUniqueOrThrow({ where: { id: chain.reviewId } });
    expect(review.publishSkipped).toBe(true);
    expect(review.inputTokens).toBe(1_300);
    expect(review.outputTokens).toBe(500);
  });
});
