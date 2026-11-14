import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  computeFindingFingerprint,
  getFindingsForReview,
  persistReviewFindings,
  supersedeFindingsForReview,
} from "../../src/findings/index.js";
import type { Finding } from "../../src/review-engine/index.js";
import {
  cleanDatabase,
  disconnectDatabase,
  makeFinding,
  makeReviewConfig,
  prisma,
  seedReviewChain,
  writeWorkspace,
  type SeededReviewChain,
  type WorkspaceFixture,
} from "./support.js";

/**
 * Characterization: finding persistence and lifecycle (ARCHITECTURE.md §7.1–
 * §7.3, §13.1).
 *
 * Assertions read the durable Finding / FindingStatusTransition rows produced
 * by the exported persistence boundary. The verification pipeline itself is
 * covered by test/findings.test.ts; this suite pins the observable row contract
 * the refactor must preserve.
 */

const config = makeReviewConfig();
let workspace: WorkspaceFixture;

function persist(
  chain: SeededReviewChain,
  findings: Finding[],
  uncertainFindings: Finding[] = [],
): ReturnType<typeof persistReviewFindings> {
  return persistReviewFindings({
    repositoryId: chain.repositoryId,
    repositoryFullName: chain.repositoryFullName,
    reviewId: chain.reviewId,
    workspacePath: workspace.path,
    findings,
    uncertainFindings,
    config,
    prisma,
  });
}

const brokenFunctionFinding = (overrides: Partial<Finding> = {}) =>
  makeFinding({
    title: "Broken function",
    description: "the broken function has a real problem",
    ...overrides,
  });

/** Add another review (new head SHA) to an existing repository/PR chain. */
async function newReviewOn(chain: SeededReviewChain, label: string): Promise<SeededReviewChain> {
  const review = await prisma.review.create({
    data: {
      pullRequestId: chain.pullRequestId,
      githubInstallationId: chain.githubInstallationId,
      githubRepositoryId: chain.githubRepositoryId,
      pullRequestNumber: 100,
      headSha: `${chain.headSha}-${label}`,
      state: "queued",
      trigger: "synchronized",
    },
  });
  return { ...chain, reviewId: review.id };
}

beforeAll(async () => {
  workspace = await writeWorkspace("characterization-findings-");
});

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await workspace.remove();
  await cleanDatabase();
  await disconnectDatabase();
});

describe("finding persistence (§7.1, §13.1)", () => {
  test("a valid finding is persisted, verified and accompanied by its first transition", async () => {
    const chain = await seedReviewChain({ prefix: "findings-persist" });
    const finding = brokenFunctionFinding();

    const result = await persist(chain, [finding]);

    expect(result.rejected).toEqual([]);
    expect(result.stored).toHaveLength(1);
    expect(result.stored[0]).toMatchObject({
      title: finding.title,
      status: "new",
      verified: true,
      filePath: "src/app.js",
      lineNumber: 2,
    });
    expect(result.transitions).toBe(1);

    const rows = await getFindingsForReview(prisma, chain.reviewId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fingerprint).toMatch(/^fp1:[0-9a-f]{64}$/);
    expect(rows[0]!.evidence).toEqual(finding.evidence);

    const transitions = await prisma.findingStatusTransition.findMany({ where: { findingId: rows[0]!.id } });
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ fromStatus: null, toStatus: "new", reviewId: chain.reviewId });
  });

  test("fingerprint duplicates inside one review collapse to the highest-confidence occurrence", async () => {
    const chain = await seedReviewChain({ prefix: "findings-dedupe" });
    const lower = brokenFunctionFinding({ title: "Lower confidence", line: 2, confidence: 0.86 });
    const higher = brokenFunctionFinding({ title: "Higher confidence", line: 3, confidence: 0.95 });

    const result = await persist(chain, [lower, higher]);

    expect(result.stored).toHaveLength(1);
    expect(result.stored[0]!.title).toBe("Higher confidence");
    expect(result.transitions).toBe(1);
    const rows = await getFindingsForReview(prisma, chain.reviewId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe("Higher confidence");
  });

  test("the same issue across commits keeps one fingerprint and moves new → updated → resolved → reopened", async () => {
    const first = await seedReviewChain({ prefix: "findings-lifecycle" });
    const atLine2 = brokenFunctionFinding({ line: 2 });
    const firstResult = await persist(first, [atLine2]);
    expect(firstResult.stored[0]!.status).toBe("new");

    // Same issue, moved down one line: the fingerprint is line-independent.
    const second = await newReviewOn(first, "second");
    const moved = brokenFunctionFinding({ line: 3 });
    expect(computeFindingFingerprint(moved, second.repositoryFullName)).toBe(
      computeFindingFingerprint(atLine2, first.repositoryFullName),
    );
    const secondResult = await persist(second, [moved]);
    expect(secondResult.stored[0]!.status).toBe("updated");

    // Issue absent from the latest commit → the latest occurrence is resolved.
    const third = await newReviewOn(first, "third");
    const emptyResult = await persist(third, []);
    expect(emptyResult.resolved).toHaveLength(1);
    const secondRow = await prisma.finding.findFirstOrThrow({ where: { reviewId: second.reviewId } });
    expect(secondRow.status).toBe("resolved");
    expect(secondRow.resolvedAt).not.toBeNull();
    const resolveTransition = await prisma.findingStatusTransition.findFirstOrThrow({
      where: { findingId: secondRow.id, toStatus: "resolved" },
    });
    expect(resolveTransition.fromStatus).toBe("updated");

    // Reintroduced later → a fresh occurrence linked to the resolved one.
    const fourth = await newReviewOn(first, "fourth");
    const reintroduced = brokenFunctionFinding({ line: 3 });
    const fourthResult = await persist(fourth, [reintroduced]);
    expect(fourthResult.stored[0]!.status).toBe("new");
    expect(fourthResult.stored[0]!.reopened).toBe(true);
    const reopenedRow = await prisma.finding.findFirstOrThrow({ where: { reviewId: fourth.reviewId } });
    expect(reopenedRow.reopenedFromFindingId).toBe(secondRow.id);
    const reopenTransition = await prisma.findingStatusTransition.findFirstOrThrow({
      where: { findingId: reopenedRow.id, toStatus: "new" },
    });
    expect(reopenTransition.reason).toContain("reopened");
  });

  test("superseding a review moves its active findings to superseded and records the link", async () => {
    const first = await seedReviewChain({ prefix: "findings-supersede" });
    const second = await seedReviewChain({ prefix: "findings-supersede-target" });
    await persist(first, [brokenFunctionFinding()]);

    const count = await supersedeFindingsForReview(prisma, first.reviewId, second.reviewId);
    expect(count).toBe(1);

    const row = await prisma.finding.findFirstOrThrow({ where: { reviewId: first.reviewId } });
    expect(row.status).toBe("superseded");
    expect(row.supersededByReviewId).toBe(second.reviewId);
    const transition = await prisma.findingStatusTransition.findFirstOrThrow({
      where: { findingId: row.id, toStatus: "superseded" },
    });
    expect(transition.fromStatus).toBe("new");
    expect(transition.reason).toContain(second.reviewId);

    // Superseding again is a no-op: only active findings are touched.
    expect(await supersedeFindingsForReview(prisma, first.reviewId, second.reviewId)).toBe(0);
  });

  test("a failed persistence transaction leaves no partial finding or transition rows", async () => {
    const chain = await seedReviewChain({ prefix: "findings-rollback" });
    const conflict = brokenFunctionFinding({ title: "Existing row", line: 2 });
    const conflictFingerprint = computeFindingFingerprint(conflict, chain.repositoryFullName);

    // Simulate a row already occupying the unique (repository, review,
    // fingerprint) key. Persisting the same fingerprint again must roll back
    // the whole batch, including findings that would have succeeded first.
    await prisma.finding.create({
      data: {
        reviewId: chain.reviewId,
        repositoryId: chain.repositoryId,
        fingerprint: conflictFingerprint,
        category: conflict.category,
        severity: conflict.severity,
        confidence: conflict.confidence,
        title: conflict.title,
        filePath: conflict.file,
        lineNumber: conflict.line,
        description: conflict.description,
        evidence: conflict.evidence as never,
        verified: true,
        status: "new",
      },
    });

    const wouldSucceed = makeFinding({
      title: "Would have been persisted",
      line: 6,
      description: "the unused helper should be removed",
      evidence: [{ file: "src/app.js", line: 6, excerpt: "function unused() {", reason: "unused helper" }],
    });

    await expect(persist(chain, [wouldSucceed, conflict])).rejects.toThrow();

    const rows = await getFindingsForReview(prisma, chain.reviewId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe("Existing row");
    expect(rows.some((row) => row.title === wouldSucceed.title)).toBe(false);
    expect(await prisma.findingStatusTransition.count()).toBe(0);
  });
});
