import type { PrismaClient } from "@prisma/client";
import type {
  PublishedFingerprintRecord,
  PublishingRepositories,
  RecordPublicationInput,
  RecordReviewUsageInput,
  ReviewCommentRepository,
  ReviewPublicationContext,
  ReviewPublicationRepository,
} from "./publishing.repository.js";

/**
 * Prisma implementation of the publishing repository ports.
 *
 * This file owns every Prisma call in the publishing module. The mappers below
 * convert BigInt GitHub ids and Prisma enums into the module's plain records;
 * no Prisma type crosses the port.
 */

export type PrismaRootClient = PrismaClient;

function toGithubCommentId(value: bigint | null): number | null {
  return value === null ? null : Number(value);
}

export function createReviewCommentRepository(client: PrismaRootClient): ReviewCommentRepository {
  return {
    async listPublishedFingerprints(reviewId: string): Promise<PublishedFingerprintRecord[]> {
      const rows = await client.reviewComment.findMany({
        where: { reviewId, status: "published", fingerprint: { not: null } },
        select: { fingerprint: true, githubCommentId: true },
      });
      const records: PublishedFingerprintRecord[] = [];
      for (const row of rows) {
        if (row.fingerprint === null) {
          continue;
        }
        records.push({
          fingerprint: row.fingerprint,
          githubCommentId: toGithubCommentId(row.githubCommentId),
        });
      }
      return records;
    },

    async findPublishedSummaryCommentId(reviewId: string): Promise<number | null> {
      const row = await client.reviewComment.findFirst({
        where: { reviewId, commentType: "summary", status: "published", githubCommentId: { not: null } },
        select: { githubCommentId: true },
      });
      return row ? toGithubCommentId(row.githubCommentId) : null;
    },

    async recordPublication(input: RecordPublicationInput): Promise<void> {
      await client.$transaction(async (tx) => {
        if (input.summary) {
          await tx.reviewComment.create({
            data: {
              reviewId: input.reviewId,
              commentType: "summary",
              status: "published",
              githubCommentId: BigInt(input.summary.githubCommentId),
            },
          });
        }
        for (const comment of input.inlineComments) {
          await tx.reviewComment.create({
            data: {
              reviewId: input.reviewId,
              findingId: comment.findingId,
              fingerprint: comment.fingerprint,
              commentType: "inline",
              status: "published",
              ...(comment.githubCommentId === null ? {} : { githubCommentId: BigInt(comment.githubCommentId) }),
            },
          });
        }
      });
    },

    async recordFailure(reviewId: string): Promise<void> {
      await client.reviewComment
        .create({
          data: {
            reviewId,
            commentType: "summary",
            status: "failed",
            // No githubCommentId: nothing was published.
          },
        })
        .catch(() => {
          /* best-effort */
        });
    },
  };
}

export function createReviewPublicationRepository(client: PrismaRootClient): ReviewPublicationRepository {
  return {
    async findReviewContext(reviewId: string): Promise<ReviewPublicationContext | null> {
      const row = await client.review.findUnique({
        where: { id: reviewId },
        select: { id: true, reviewType: true, pullRequest: { select: { repositoryId: true } } },
      });
      return row
        ? {
            reviewId: row.id,
            reviewType: row.reviewType,
            repositoryId: row.pullRequest.repositoryId,
          }
        : null;
    },

    async markPublishSkipped(reviewId: string): Promise<void> {
      await client.review.update({ where: { id: reviewId }, data: { publishSkipped: true } });
    },

    async recordUsage(input: RecordReviewUsageInput): Promise<void> {
      await client.review.update({
        where: { id: input.reviewId },
        data: { inputTokens: input.inputTokens, outputTokens: input.outputTokens },
      });
    },
  };
}

/** Build the publishing repository bundle for one root Prisma client. */
export function createPublishingRepositories(prisma: PrismaRootClient): PublishingRepositories {
  return {
    comments: createReviewCommentRepository(prisma),
    reviews: createReviewPublicationRepository(prisma),
  };
}
