import type { Queue } from "bullmq";
import pino from "pino";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { reviewJobPayloadSchema } from "../src/contracts/queue.js";
import { createIngestionRepositories } from "../src/ingestion/prisma-ingestion.repository.js";
import { createIngestionUnitOfWork } from "../src/ingestion/prisma-ingestion.unit-of-work.js";
import type { ReviewJobPayload } from "../src/ingestion/queue.js";
import { getPrisma, disconnectPrisma } from "../src/lib/prisma.js";
import { getMetricsRegistry } from "../src/observability/metrics.js";
import { reconcileIncompleteReviews, resetReviewForRecovery } from "../src/recovery/reconciliation.js";
import { REDIS_PERSISTENCE_COMMANDLINE } from "../src/recovery/redis-persistence.js";

/**
 * Ticket 12 integration tests: startup reconciliation and recovery.
 *
 * Simulates a worker crash mid-review: a Review in a non-terminal state whose
 * ReviewJob is processing and whose row went stale. After "restart",
 * reconciliation must re-enqueue exactly ONE job with the SAME identity
 * (jobId = ReviewJob.id) — never a duplicate — and must be idempotent on
 * repeated passes. Also covers recovery exhaustion, policy=fail, fresh
 * reviews, DB outages and the documented Redis persistence configuration.
 */

process.env.DATABASE_URL ??= "postgres://postgres:postgres@localhost:5432/reviewer";

const prisma = getPrisma();
const repositories = createIngestionRepositories(prisma);
const unitOfWork = createIngestionUnitOfWork(prisma);
const logger = pino({ level: "silent" });

// Fixture rows ---------------------------------------------------------------

let installationId = "";
let repositoryId = "";
let pullRequestId = "";
let githubRepositoryId: bigint;

beforeAll(async () => {
  const installation = await prisma.installation.create({
    data: {
      githubInstallationId: BigInt(9_912_001),
      organization: "recovery-fixture-org",
    },
  });
  installationId = installation.id;
  githubRepositoryId = BigInt(7_712_001);
  const repository = await prisma.repository.create({
    data: {
      githubRepositoryId,
      installationId,
      fullName: "recovery-fixture-org/widget",
      defaultBranch: "main",
    },
  });
  repositoryId = repository.id;
  const pullRequest = await prisma.pullRequest.create({
    data: {
      repositoryId,
      githubPrNumber: 7712,
      headSha: "cccc7712cccc7712cccc7712cccc7712cccc7712",
      baseSha: "dddd7712dddd7712dddd7712dddd7712dddd7712",
    },
  });
  pullRequestId = pullRequest.id;
});

afterAll(async () => {
  // Delete in FK-safe order for anything this spec created.
  await prisma.outboxEvent.deleteMany({ where: { ReviewJob: { review: { pullRequestId } } } }).catch(() => {});
  await prisma.reviewJob.deleteMany({ where: { review: { pullRequestId } } }).catch(() => {});
  await prisma.reviewStateTransition.deleteMany({ where: { review: { pullRequestId } } }).catch(() => {});
  await prisma.review.deleteMany({ where: { pullRequestId } }).catch(() => {});
  await prisma.pullRequest.deleteMany({ where: { id: pullRequestId } }).catch(() => {});
  await prisma.repository.deleteMany({ where: { id: repositoryId } }).catch(() => {});
  await prisma.installation.deleteMany({ where: { id: installationId } }).catch(() => {});
  await disconnectPrisma();
});

/** Create a review + durable job, then simulate a crashed in-flight worker. */
async function createStuckReview(
  overrides: { state?: "queued" | "analyzing" | "publishing"; attempts?: number } = {},
): Promise<{ reviewId: string; jobId: string }> {
  // Unique per call: (pull_request_id, head_sha, review_mode) is unique.
  const headSha = `cccc7712cccc7712cccc7712${Date.now().toString(36).padStart(12, "0")}${Math.floor(Math.random() * 1e6)
    .toString(36)
    .padStart(4, "0")}`;
  const review = await prisma.review.create({
    data: {
      pullRequestId,
      githubInstallationId: BigInt(9_912_001),
      githubRepositoryId,
      pullRequestNumber: 7712,
      headSha,
      baseSha: "dddd7712dddd7712dddd7712dddd7712dddd7712",
      state: overrides.state ?? "analyzing",
      trigger: "manual",
      reviewMode: "adaptive",
    },
  });
  const job = await prisma.reviewJob.create({
    data: {
      reviewId: review.id,
      status: "processing",
      attempts: overrides.attempts ?? 0,
      jobKey: `recovery-fixture-${review.id}`,
    },
  });
  // Simulate the crash: the row has made no progress for 30 minutes.
  await prisma.$executeRaw`UPDATE review_jobs SET updated_at = now() - interval '30 minutes' WHERE id = ${job.id}`;
  return { reviewId: review.id, jobId: job.id };
}

function fakeQueue(existingState?: "completed" | "failed" | "waiting" | "active" | "prioritized" | "delayed") {
  const added: Array<{ name: string; payload: ReviewJobPayload; opts: { jobId?: string; attempts?: number } }> = [];
  const events: string[] = [];
  const queue = {
    add: async (name: string, payload: ReviewJobPayload, opts: { jobId?: string; attempts?: number } = {}) => {
      events.push("add");
      added.push({ name, payload, opts });
      return { id: opts.jobId ?? "x" };
    },
    getJob: async () => {
      if (!existingState) {
        return undefined;
      }
      return {
        getState: async () => existingState,
        remove: async () => {
          events.push("remove");
        },
      };
    },
  } as unknown as Queue<ReviewJobPayload>;
  return { queue, added, events };
}

// Tests ----------------------------------------------------------------------

describe("reconciliation", () => {
  const registry = getMetricsRegistry();
  afterEach(() => registry.reset());

  test("re-enqueues a crashed in-flight review with the SAME job id (no duplicates)", async () => {
    const { reviewId, jobId } = await createStuckReview({ state: "analyzing" });
    const { queue, added } = fakeQueue();

    const summary = await reconcileIncompleteReviews({
      repositories,
      unitOfWork,
      logger,
      queue,
      staleThresholdMs: 15 * 60_000,
      maxJobAttempts: 3,
    });

    expect(summary.scanned).toBeGreaterThanOrEqual(1);
    expect(summary.requeued).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.staleSessions).toBe(1);
    expect(added).toHaveLength(1);
    // Ticket 03 identity contract: the BullMQ job id IS the ReviewJob id.
    expect(added[0].opts.jobId).toBe(jobId);
    expect(added[0].payload.reviewId).toBe(reviewId);
    expect(added[0].payload.repositoryFullName).toBe("recovery-fixture-org/widget");

    const review = await prisma.review.findUnique({ where: { id: reviewId } });
    expect(review?.state).toBe("queued");
    const job = await prisma.reviewJob.findUnique({ where: { id: jobId } });
    expect(job?.status).toBe("enqueued");

    // Restart simulation: a second reconciliation pass must NOT create a
    // duplicate queue job. The review is queued again but its job row is
    // fresh (updatedAt just advanced) → skipped.
    const second = await reconcileIncompleteReviews({
      repositories,
      unitOfWork,
      logger,
      queue,
      staleThresholdMs: 15 * 60_000,
    });
    expect(second.requeued).toBe(0);
    expect(added).toHaveLength(1);
  });

  test("rebuilds a valid queue payload from durable rows when the stored outbox payload is invalid", async () => {
    const { reviewId, jobId } = await createStuckReview();
    await prisma.outboxEvent.create({
      data: {
        reviewJobId: jobId,
        type: "review.requested",
        payload: {
          reviewId,
          reviewMode: "legacy-mode",
          pullRequestNumber: "not-a-number",
        },
      },
    });
    const { queue, added } = fakeQueue();

    const summary = await reconcileIncompleteReviews({
      repositories,
      unitOfWork,
      logger,
      queue,
      staleThresholdMs: 15 * 60_000,
    });

    expect(summary.requeued).toBe(1);
    expect(added).toHaveLength(1);
    const payload = added[0]?.payload;
    if (!payload) {
      throw new Error("reconciliation did not enqueue a payload");
    }
    // The stored payload is rejected, so every field comes from the durable
    // rows: no invalid value and no invented default survives the fallback.
    expect(payload).toMatchObject({
      reviewId,
      reviewMode: "adaptive",
      trigger: "manual",
      repositoryFullName: "recovery-fixture-org/widget",
      pullRequestNumber: 7712,
    });
    expect(reviewJobPayloadSchema.safeParse(payload).success).toBe(true);
  });

  test("fails permanently when durable rows violate the queue contract", async () => {
    const { reviewId, jobId } = await createStuckReview();
    // Legacy rows may predate the tightened reviewMode enum
    // (the column default was "standard"); they cannot produce a valid job.
    await prisma.review.update({ where: { id: reviewId }, data: { reviewMode: "standard" } });
    const { queue, added } = fakeQueue();

    const summary = await reconcileIncompleteReviews({
      repositories,
      unitOfWork,
      logger,
      queue,
      staleThresholdMs: 15 * 60_000,
    });

    expect(summary.requeued).toBe(0);
    expect(summary.failed).toBe(1);
    expect(added).toHaveLength(0);

    const review = await prisma.review.findUniqueOrThrow({ where: { id: reviewId } });
    expect(review.state).toBe("failed");
    expect(review.errorCode).toBe("REVIEW_JOB_PAYLOAD_INVALID");

    const job = await prisma.reviewJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("failed");
    expect(job.lastError).toContain("REVIEW_JOB_PAYLOAD_INVALID");
  });

  test("removes a retained completed job before re-enqueueing (no silent jobId dedupe)", async () => {
    // Reproduces the race aftermath: the worker skipped the job and BullMQ
    // retained it as `completed`. `queue.add` with the same jobId would be a
    // no-op, so recovery must remove the finished job first or the review is
    // stuck in a 15-minute stale→requeue loop that never runs anything.
    const { jobId } = await createStuckReview({ state: "queued" });
    const { queue, added, events } = fakeQueue("completed");

    const summary = await reconcileIncompleteReviews({
      repositories,
      unitOfWork,
      logger,
      queue,
      staleThresholdMs: 15 * 60_000,
      maxJobAttempts: 3,
    });

    expect(summary.requeued).toBe(1);
    expect(events).toEqual(["remove", "add"]);
    expect(added).toHaveLength(1);
    expect(added[0].opts.jobId).toBe(jobId);
  });

  test("does not remove an active job still owned by a worker", async () => {
    await createStuckReview();
    const { queue, added, events } = fakeQueue("active");

    const summary = await reconcileIncompleteReviews({
      repositories,
      unitOfWork,
      logger,
      queue,
      staleThresholdMs: 15 * 60_000,
      maxJobAttempts: 3,
    });

    expect(summary.requeued).toBe(1);
    expect(events).toEqual(["add"]);
    expect(added).toHaveLength(1);
  });

  test("fails the review when attempts are exhausted (recovery_exhausted)", async () => {
    const { reviewId, jobId } = await createStuckReview({ attempts: 3 });
    const { queue, added } = fakeQueue();

    const summary = await reconcileIncompleteReviews({
      repositories,
      unitOfWork,
      logger,
      queue,
      staleThresholdMs: 15 * 60_000,
      maxJobAttempts: 3,
    });

    expect(summary.requeued).toBe(0);
    expect(summary.failed).toBe(1);
    expect(added).toHaveLength(0);

    const review = await prisma.review.findUnique({ where: { id: reviewId } });
    expect(review?.state).toBe("failed");
    expect(review?.errorCode).toBe("recovery_exhausted");
    const job = await prisma.reviewJob.findUnique({ where: { id: jobId } });
    expect(job?.status).toBe("failed");
  });

  test("policy=fail fails stale reviews even with attempts remaining", async () => {
    const { reviewId } = await createStuckReview({ attempts: 0 });
    const { queue, added } = fakeQueue();

    const summary = await reconcileIncompleteReviews({
      repositories,
      unitOfWork,
      logger,
      queue,
      policy: "fail",
      staleThresholdMs: 15 * 60_000,
    });

    expect(summary.failed).toBe(1);
    expect(summary.requeued).toBe(0);
    expect(added).toHaveLength(0);
    const review = await prisma.review.findUnique({ where: { id: reviewId } });
    expect(review?.state).toBe("failed");
  });

  test("skips fresh (still-progressing) reviews", async () => {
    const { reviewId } = await createStuckReview({ state: "queued" });
    // Undo the artificial staleness.
    await prisma.reviewJob.updateMany({ where: { reviewId }, data: { lastError: null } });

    const { queue, added } = fakeQueue();
    const summary = await reconcileIncompleteReviews({
      repositories,
      unitOfWork,
      logger,
      queue,
      staleThresholdMs: 15 * 60_000,
    });

    expect(summary.fresh).toBeGreaterThanOrEqual(1);
    expect(summary.requeued).toBe(0);
    expect(added).toHaveLength(0);
    const review = await prisma.review.findUnique({ where: { id: reviewId } });
    expect(review?.state).toBe("queued");
  });

  test("sweeps expired workspaces via the cleanup hook", async () => {
    await createStuckReview({ attempts: 3 });
    let swept = 0;
    const summary = await reconcileIncompleteReviews({
      repositories,
      unitOfWork,
      logger,
      policy: "fail",
      staleThresholdMs: 15 * 60_000,
      sweepExpiredWorkspaces: async () => {
        swept += 1;
        return swept;
      },
    });
    expect(summary.workspacesSwept).toBe(1);
  });

  test("survives a PostgreSQL outage (returns an empty summary, never throws)", async () => {
    const brokenPrisma = {
      reviewJob: {
        findMany: () => Promise.reject(new Error("P1001: database unreachable")),
      },
    } as unknown as typeof prisma;

    const summary = await reconcileIncompleteReviews({
      repositories: createIngestionRepositories(brokenPrisma),
      unitOfWork: createIngestionUnitOfWork(brokenPrisma),
      logger,
      staleThresholdMs: 15 * 60_000,
    });
    expect(summary).toEqual({
      scanned: 0,
      requeued: 0,
      failed: 0,
      fresh: 0,
      staleSessions: 0,
      workspacesSwept: 0,
    });
  });
});

describe("resetReviewForRecovery", () => {
  test("resets a review to queued and records an auditable transition", async () => {
    const { reviewId } = await createStuckReview({ state: "publishing" });
    await resetReviewForRecovery(unitOfWork, reviewId);

    const review = await prisma.review.findUnique({ where: { id: reviewId } });
    expect(review?.state).toBe("queued");
    expect(review?.errorCode).toBeNull();

    const transitions = await prisma.reviewStateTransition.findMany({
      where: { reviewId },
      orderBy: { createdAt: "asc" },
    });
    const last = transitions[transitions.length - 1];
    expect(last?.fromState).toBe("publishing");
    expect(last?.toState).toBe("queued");
  });
});

describe("redis persistence guidance", () => {
  test("documents an AOF-enabling redis-server command line", () => {
    expect(REDIS_PERSISTENCE_COMMANDLINE).toEqual(["redis-server", "--appendonly", "yes", "--appendfsync", "everysec"]);
  });
});
