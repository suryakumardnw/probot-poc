import type { OutboxEvent, Prisma, PrismaClient, ReviewJob } from "@prisma/client";
import type { OutboxEventRecord, OutboxEventWithJob, ReviewJobRecord } from "./ingestion.repository.js";
import type { CreateOutboxEventInput, OutboxRepository } from "./outbox.repository.js";

/**
 * Prisma implementation of the transactional outbox repository.
 *
 * The payload is stored as JSON exactly as validated at the service boundary;
 * this adapter only maps row/enum shapes.
 */

export type PrismaOutboxDatabaseClient = PrismaClient | Prisma.TransactionClient;

type OutboxEventWithJobRow = Prisma.OutboxEventGetPayload<{ include: { reviewJob: true } }>;

function mapReviewJob(row: ReviewJob): ReviewJobRecord {
  return {
    id: row.id,
    reviewId: row.reviewId,
    status: row.status,
    attempts: row.attempts,
    lastError: row.lastError,
    queueJobId: row.queueJobId,
    jobKey: row.jobKey,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapOutboxEvent(row: OutboxEvent): OutboxEventRecord {
  return {
    id: row.id,
    reviewJobId: row.reviewJobId,
    type: row.type,
    payload: row.payload,
    status: row.status,
    attempts: row.attempts,
    lastError: row.lastError,
    publishedAt: row.publishedAt,
    createdAt: row.createdAt,
  };
}

function mapOutboxEventWithJob(row: OutboxEventWithJobRow): OutboxEventWithJob {
  return {
    ...mapOutboxEvent(row),
    reviewJob: mapReviewJob(row.reviewJob),
  };
}

export function createOutboxRepository(client: PrismaOutboxDatabaseClient): OutboxRepository {
  return {
    async create(input: CreateOutboxEventInput): Promise<OutboxEventRecord> {
      const row = await client.outboxEvent.create({
        data: { reviewJobId: input.reviewJobId, type: input.type, payload: input.payload },
      });
      return mapOutboxEvent(row);
    },

    async findByIdWithJob(eventId: string): Promise<OutboxEventWithJob | null> {
      const row = await client.outboxEvent.findUnique({
        where: { id: eventId },
        include: { reviewJob: true },
      });
      return row ? mapOutboxEventWithJob(row) : null;
    },

    async findLatestForJob(reviewJobId: string): Promise<OutboxEventRecord | null> {
      const row = await client.outboxEvent.findFirst({
        where: { reviewJobId },
        orderBy: { createdAt: "desc" },
      });
      return row ? mapOutboxEvent(row) : null;
    },

    async findPendingIds(limit: number): Promise<string[]> {
      const rows = await client.outboxEvent.findMany({
        where: { status: "pending" },
        orderBy: { createdAt: "asc" },
        take: limit,
        select: { id: true },
      });
      return rows.map((row) => row.id);
    },

    async markPublished(eventId: string, publishedAt: Date): Promise<void> {
      await client.outboxEvent.update({
        where: { id: eventId },
        data: { status: "published", publishedAt, lastError: null },
      });
    },

    async discard(eventId: string, lastError: string): Promise<void> {
      await client.outboxEvent.update({
        where: { id: eventId },
        data: { status: "discarded", lastError },
      });
    },

    async discardIfPending(eventId: string, lastError: string): Promise<boolean> {
      const result = await client.outboxEvent.updateMany({
        where: { id: eventId, status: "pending" },
        data: { status: "discarded", lastError },
      });
      return result.count > 0;
    },

    async discardPendingForJob(reviewJobId: string, lastError: string): Promise<void> {
      await client.outboxEvent.updateMany({
        where: { reviewJobId, status: "pending" },
        data: { status: "discarded", lastError },
      });
    },

    async incrementAttemptsIfPending(eventId: string, lastError: string): Promise<void> {
      await client.outboxEvent.updateMany({
        where: { id: eventId, status: "pending" },
        data: { attempts: { increment: 1 }, lastError },
      });
    },
  };
}
