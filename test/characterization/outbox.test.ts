import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import { createReviewQueue } from "../../src/ingestion/queue.js";
import { testEnv } from "../helpers/env.js";
import { createTestIngestion } from "../helpers/ingestion.js";
import { cleanDatabase, disconnectDatabase, prisma, seedReviewChain } from "./support.js";

/**
 * Characterization: transactional outbox publication and recovery
 * (ARCHITECTURE.md §4.4, §12.2).
 *
 * Redis is required. The "Redis unavailable" case is simulated by injecting a
 * failing Queue through the exported publish boundary (the existing recovery
 * suite stops the real container); every other assertion uses the real BullMQ
 * queue so the observable state is the Redis-visible one.
 */

const reviewQueue = createReviewQueue(testEnv.REDIS_URL);
const queue = reviewQueue.queue;
const ingestion = createTestIngestion({ queue });

async function jobsWithId(jobId: string) {
  const jobs = await queue.getJobs(["waiting", "paused", "delayed", "active", "completed", "failed"]);
  return jobs.filter((job) => job.id === jobId);
}

beforeEach(async () => {
  await cleanDatabase();
  await queue.waitUntilReady();
});

afterEach(async () => {
  // Jobs are unique per fixture, but removal keeps Redis tidy for repeat runs.
  const jobs = await queue.getJobs(["waiting", "paused", "delayed", "failed"]);
  await Promise.all(jobs.map((job) => job.remove().catch(() => {})));
});

afterAll(async () => {
  await reviewQueue.close();
  await cleanDatabase();
  await disconnectDatabase();
});

describe("outbox publication (§12.2)", () => {
  test("with Redis available the event is published and the job is enqueued", async () => {
    const chain = await seedReviewChain({
      prefix: "outbox-publish",
      job: { status: "pending_outbox" },
      outbox: { status: "pending" },
    });

    await expect(ingestion.services.publishOutboxEvent(chain.outboxEventId!)).resolves.toBe("published");

    const job = await prisma.reviewJob.findUniqueOrThrow({ where: { id: chain.jobId! } });
    expect(job.status).toBe("enqueued");
    expect(job.queueJobId).toBe(chain.jobId);

    const event = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: chain.outboxEventId! } });
    expect(event.status).toBe("published");
    expect(event.publishedAt).not.toBeNull();
    expect(event.lastError).toBeNull();

    const queueJob = await queue.getJob(chain.jobId!);
    expect(queueJob).toBeDefined();
    expect(queueJob!.data).toMatchObject({
      reviewId: chain.reviewId,
      jobKey: chain.jobKey,
      repositoryFullName: "outbox-publish-org/outbox-publish-repo",
    });
    // ReviewJob.id is the BullMQ job id, so publishing is idempotent.
    expect(queueJob!.id).toBe(chain.jobId);
  });

  test("with Redis unavailable the event stays pending and the job returns to pending_outbox", async () => {
    const chain = await seedReviewChain({
      prefix: "outbox-offline",
      job: { status: "pending_outbox" },
      outbox: { status: "pending" },
    });
    const unavailableQueue = {
      add: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:6379");
      },
    };
    const offlineIngestion = createTestIngestion({ queue: unavailableQueue });

    await expect(offlineIngestion.services.publishOutboxEvent(chain.outboxEventId!)).resolves.toBe("failed");

    const job = await prisma.reviewJob.findUniqueOrThrow({ where: { id: chain.jobId! } });
    expect(job.status).toBe("pending_outbox");
    expect(job.queueJobId).toBeNull();

    const event = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: chain.outboxEventId! } });
    expect(event.status).toBe("pending");
    expect(event.publishedAt).toBeNull();
    expect(event.attempts).toBe(1);
    expect(event.lastError).toContain("ECONNREFUSED");
  });

  test("publishing the same event twice never creates a second queue job", async () => {
    const chain = await seedReviewChain({
      prefix: "outbox-idempotent",
      job: { status: "pending_outbox" },
      outbox: { status: "pending" },
    });

    await expect(ingestion.services.publishOutboxEvent(chain.outboxEventId!)).resolves.toBe("published");
    expect(await jobsWithId(chain.jobId!)).toHaveLength(1);

    // Simulate a recovery re-publication of the same durable event.
    await prisma.outboxEvent.update({
      where: { id: chain.outboxEventId! },
      data: { status: "pending", publishedAt: null },
    });
    await expect(ingestion.services.publishOutboxEvent(chain.outboxEventId!)).resolves.toBe("published");

    const event = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: chain.outboxEventId! } });
    expect(event.status).toBe("published");
    expect(event.attempts).toBe(0);
    expect(await jobsWithId(chain.jobId!)).toHaveLength(1);
  });

  test("a superseded job is discarded instead of enqueued", async () => {
    const chain = await seedReviewChain({
      prefix: "outbox-superseded",
      job: { status: "superseded" },
      outbox: { status: "pending" },
    });

    await expect(ingestion.services.publishOutboxEvent(chain.outboxEventId!)).resolves.toBe("discarded");

    const event = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: chain.outboxEventId! } });
    expect(event.status).toBe("discarded");
    expect(event.lastError).toContain("superseded");
    expect(await queue.getJob(chain.jobId!)).toBeUndefined();
  });

  test("a malformed payload is discarded with a stable code and never enqueued", async () => {
    const chain = await seedReviewChain({
      prefix: "outbox-malformed",
      job: { status: "pending_outbox" },
      outbox: { status: "pending" },
    });
    if (!chain.outboxEventId || !chain.jobId) {
      throw new Error("seeded review chain is missing its outbox event or job id");
    }
    await prisma.outboxEvent.update({
      where: { id: chain.outboxEventId },
      data: {
        payload: {
          reviewId: chain.reviewId,
          reviewMode: "uncontracted-mode",
          pullRequestNumber: "not-a-number",
        },
      },
    });

    await expect(ingestion.services.publishOutboxEvent(chain.outboxEventId)).resolves.toBe("discarded");

    // Permanent data error: the event is terminal (no retry loop) and records
    // the stable code. Reconciliation can still rebuild the review payload
    // from the durable rows.
    const event = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: chain.outboxEventId } });
    expect(event.status).toBe("discarded");
    expect(event.attempts).toBe(0);
    expect(event.lastError).toContain("OUTBOX_PAYLOAD_INVALID");

    // The publish happens before the enqueued state flip, so neither Redis nor
    // the durable job row moved.
    const job = await prisma.reviewJob.findUniqueOrThrow({ where: { id: chain.jobId } });
    expect(job.status).toBe("pending_outbox");
    await expect(queue.getJob(chain.jobId)).resolves.toBeUndefined();
  });

  test("recovery drains pending events, discarding superseded work", async () => {
    const publishable = await seedReviewChain({
      prefix: "outbox-drain-a",
      job: { status: "pending_outbox" },
      outbox: { status: "pending" },
    });
    const superseded = await seedReviewChain({
      prefix: "outbox-drain-b",
      job: { status: "superseded" },
      outbox: { status: "pending" },
    });

    const summary = await ingestion.services.recoverOutbox(100);
    expect(summary).toEqual({ scanned: 2, published: 1, discarded: 1, failed: 0 });

    const publishedEvent = await prisma.outboxEvent.findUniqueOrThrow({
      where: { id: publishable.outboxEventId! },
    });
    expect(publishedEvent.status).toBe("published");
    expect((await prisma.reviewJob.findUniqueOrThrow({ where: { id: publishable.jobId! } })).status).toBe("enqueued");
    expect(await queue.getJob(publishable.jobId!)).toBeDefined();

    const discardedEvent = await prisma.outboxEvent.findUniqueOrThrow({
      where: { id: superseded.outboxEventId! },
    });
    expect(discardedEvent.status).toBe("discarded");
    expect(await queue.getJob(superseded.jobId!)).toBeUndefined();
  });
});
