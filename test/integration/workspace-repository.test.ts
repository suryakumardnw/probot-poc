import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { createPrismaWorkspaceRepository } from "../../src/workspace/prisma-workspace.repository.js";
import { cleanDatabase, disconnectDatabase, prisma, seedReviewChain } from "../characterization/support.js";

/**
 * Integration: ReviewWorkspace repository against real PostgreSQL.
 *
 * The workspace service relies on these queries for metadata persistence,
 * cleanup-after-review, failure cleanup, and the retention sweep. A workspace
 * row is active until exactly one of those paths claims it.
 */

const workspaces = createPrismaWorkspaceRepository(prisma);

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectDatabase();
});

describe("workspace repository", () => {
  test("creates an active row with its SHA metadata", async () => {
    const chain = await seedReviewChain({ prefix: "workspace-repo-create" });

    const created = await workspaces.create({
      reviewId: chain.reviewId,
      path: `/tmp/workspaces/ws-${chain.reviewId}`,
      headSha: chain.headSha,
      baseSha: "base-sha",
      mergeBaseSha: "merge-base-sha",
    });

    expect(created).toMatchObject({
      reviewId: chain.reviewId,
      headSha: chain.headSha,
      baseSha: "base-sha",
      mergeBaseSha: "merge-base-sha",
      status: "active",
      cleanedAt: null,
      lastError: null,
    });
  });

  test("finds the latest active row and excludes cleaned or failed rows", async () => {
    const chain = await seedReviewChain({ prefix: "workspace-repo-find" });
    const older = await workspaces.create({
      reviewId: chain.reviewId,
      path: `/tmp/workspaces/older-${chain.reviewId}`,
      headSha: chain.headSha,
      baseSha: null,
      mergeBaseSha: null,
    });
    await workspaces.markCleaned(older.id);

    const latest = await workspaces.create({
      reviewId: chain.reviewId,
      path: `/tmp/workspaces/latest-${chain.reviewId}`,
      headSha: chain.headSha,
      baseSha: null,
      mergeBaseSha: null,
    });

    expect((await workspaces.findLatestActive(chain.reviewId))?.id).toBe(latest.id);
    expect((await workspaces.findActive(chain.reviewId)).map((row) => row.id)).toEqual([latest.id]);
    expect(await workspaces.findLatestActive("missing-review")).toBeNull();
  });

  test("returns every active row for failure cleanup", async () => {
    const chain = await seedReviewChain({ prefix: "workspace-repo-failure" });
    const first = await workspaces.create({
      reviewId: chain.reviewId,
      path: `/tmp/workspaces/failure-a-${chain.reviewId}`,
      headSha: chain.headSha,
      baseSha: null,
      mergeBaseSha: null,
    });
    const second = await workspaces.create({
      reviewId: chain.reviewId,
      path: `/tmp/workspaces/failure-b-${chain.reviewId}`,
      headSha: chain.headSha,
      baseSha: null,
      mergeBaseSha: null,
    });

    await workspaces.markFailed(first.id, "clone failed");
    await workspaces.markFailed(second.id, null);

    const rows = await prisma.reviewWorkspace.findMany({
      where: { reviewId: chain.reviewId },
      orderBy: { id: "asc" },
    });
    expect(rows.map((row) => row.status)).toEqual(["failed", "failed"]);
    expect(rows.every((row) => row.cleanedAt !== null)).toBe(true);
    expect(await workspaces.findActive(chain.reviewId)).toEqual([]);
  });

  test("sweeps only active rows older than the retention cutoff and records the cleanup", async () => {
    const chain = await seedReviewChain({ prefix: "workspace-repo-sweep" });
    const old = await workspaces.create({
      reviewId: chain.reviewId,
      path: `/tmp/workspaces/old-${chain.reviewId}`,
      headSha: chain.headSha,
      baseSha: null,
      mergeBaseSha: null,
    });
    const fresh = await workspaces.create({
      reviewId: chain.reviewId,
      path: `/tmp/workspaces/fresh-${chain.reviewId}`,
      headSha: chain.headSha,
      baseSha: null,
      mergeBaseSha: null,
    });
    await prisma.reviewWorkspace.update({
      where: { id: old.id },
      data: { createdAt: new Date(Date.now() - 48 * 3_600_000), lastError: "stale" },
    });

    const stale = await workspaces.findActiveCreatedBefore(new Date(Date.now() - 24 * 3_600_000));
    expect(stale.map((row) => row.id)).toEqual([old.id]);

    await workspaces.markCleaned(old.id, { lastError: null });

    const cleaned = await prisma.reviewWorkspace.findUniqueOrThrow({ where: { id: old.id } });
    expect(cleaned.status).toBe("cleaned");
    expect(cleaned.cleanedAt).not.toBeNull();
    expect(cleaned.lastError).toBeNull();
    const remaining = await prisma.reviewWorkspace.findUniqueOrThrow({ where: { id: fresh.id } });
    expect(remaining.status).toBe("active");
  });
});
