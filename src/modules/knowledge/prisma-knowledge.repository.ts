/**
 * Prisma adapter for the review knowledge snapshot.
 *
 * `materialize.ts` depends on the `ReviewKnowledgeStore` port; this adapter is
 * the only file in the knowledge module that touches the vendor client and the
 * JSON column shape.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type { ReviewKnowledgeStore } from "./materialize.js";
import type { PersistedKnowledgeSnapshot } from "./types.js";

export function createPrismaReviewKnowledgeStore(prisma: PrismaClient): ReviewKnowledgeStore {
  return {
    async findSnapshot(reviewId) {
      const review = await prisma.review.findUnique({
        where: { id: reviewId },
        select: { knowledgeSnapshot: true },
      });
      if (!review) {
        return null;
      }
      return { knowledgeSnapshot: toPersistedSnapshot(review.knowledgeSnapshot) };
    },

    async saveSnapshot(reviewId, snapshot) {
      await prisma.review.update({
        where: { id: reviewId },
        data: { knowledgeSnapshot: snapshot as Prisma.InputJsonObject },
      });
    },
  };
}

/**
 * The column is a JSON document written by this module. Treat a non-object
 * value as absent rather than trusting arbitrary database content.
 */
function toPersistedSnapshot(value: Prisma.JsonValue | null): PersistedKnowledgeSnapshot | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as PersistedKnowledgeSnapshot;
}
