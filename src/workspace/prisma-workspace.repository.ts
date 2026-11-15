import type { PrismaClient, ReviewWorkspace } from "@prisma/client";
import type {
  CreateWorkspaceInput,
  MarkWorkspaceCleanedInput,
  WorkspaceRecord,
  WorkspaceRepository,
} from "./workspace.repository.js";

/**
 * Prisma workspace repository — the only workspace file that touches Prisma.
 *
 * Shortcut names mirror the former service queries: latest active row for
 * cleanup-after-review, all active rows for failure cleanup, and active rows
 * older than the retention cutoff for the sweep.
 */

function mapWorkspace(row: ReviewWorkspace): WorkspaceRecord {
  return {
    id: row.id,
    reviewId: row.reviewId,
    path: row.path,
    headSha: row.headSha,
    baseSha: row.baseSha,
    mergeBaseSha: row.mergeBaseSha,
    status: row.status,
    lastError: row.lastError,
    createdAt: row.createdAt,
    cleanedAt: row.cleanedAt,
  };
}

export function createPrismaWorkspaceRepository(prisma: PrismaClient): WorkspaceRepository {
  return {
    async create(input: CreateWorkspaceInput): Promise<WorkspaceRecord> {
      const row = await prisma.reviewWorkspace.create({
        data: {
          reviewId: input.reviewId,
          path: input.path,
          headSha: input.headSha,
          baseSha: input.baseSha,
          mergeBaseSha: input.mergeBaseSha,
          status: "active",
        },
      });
      return mapWorkspace(row);
    },

    async findLatestActive(reviewId: string): Promise<WorkspaceRecord | null> {
      const row = await prisma.reviewWorkspace.findFirst({
        where: { reviewId, status: "active" },
        orderBy: { createdAt: "desc" },
      });
      return row ? mapWorkspace(row) : null;
    },

    async findActive(reviewId: string): Promise<WorkspaceRecord[]> {
      const rows = await prisma.reviewWorkspace.findMany({ where: { reviewId, status: "active" } });
      return rows.map(mapWorkspace);
    },

    async findActiveCreatedBefore(cutoff: Date): Promise<WorkspaceRecord[]> {
      const rows = await prisma.reviewWorkspace.findMany({
        where: { status: "active", createdAt: { lt: cutoff } },
      });
      return rows.map(mapWorkspace);
    },

    async markCleaned(workspaceId: string, input: MarkWorkspaceCleanedInput = {}): Promise<void> {
      await prisma.reviewWorkspace.update({
        where: { id: workspaceId },
        data: {
          status: "cleaned",
          cleanedAt: new Date(),
          ...(input.lastError === undefined ? {} : { lastError: input.lastError }),
        },
      });
    },

    async markFailed(workspaceId: string, lastError: string | null): Promise<void> {
      await prisma.reviewWorkspace.update({
        where: { id: workspaceId },
        data: { status: "failed", cleanedAt: new Date(), lastError },
      });
    },
  };
}
