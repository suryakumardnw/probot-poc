import type { Queue } from "bullmq";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import { publishOutboxEvent, recoverOutbox } from "../../src/ingestion/outbox.js";
import { closeReviewQueue, getReviewQueue, type ReviewJobPayload } from "../../src/ingestion/queue.js";
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

const queue = getReviewQueue();

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
  await closeReviewQueue();
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

    await expect(publishOutboxEvent(chain.outboxEventId!, queue)).resolves.toBe("published");

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
    } as unknown as Queue<ReviewJobPayload>;

    await expect(publishOutboxEvent(chain.outboxEventId!, unavailableQueue)).resolves.toBe("failed");

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

    await expect(publishOutboxEvent(chain.outboxEventId!, queue)).resolves.toBe("published");
    expect(await jobsWithId(chain.jobId!)).toHaveLength(1);

    // Simulate a recovery re-publication of the same durable event.
    await prisma.outboxEvent.update({
      where: { id: chain.outboxEventId! },
      data: { status: "pending", publishedAt: null },
    });
    await expect(publishOutboxEvent(chain.outboxEventId!, queue)).resolves.toBe("published");

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

    await expect(publishOutboxEvent(chain.outboxEventId!, queue)).resolves.toBe("discarded");

    const event = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: chain.outboxEventId! } });
    expect(event.status).toBe("discarded");
    expect(event.lastError).toContain("superseded");
    expect(await queue.getJob(chain.jobId!)).toBeUndefined();
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

    const summary = await recoverOutbox(100, queue);
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
