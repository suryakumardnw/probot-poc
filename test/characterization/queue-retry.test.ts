import { once } from "node:events";
import { UnrecoverableError, type Queue } from "bullmq";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { AgentRuntimeError } from "../../src/agent/types.js";
import { DEFAULT_CONFIG_PATH, loadReviewConfig } from "../../src/config/review-loader.js";
import { createIngestionRepositories } from "../../src/ingestion/prisma-ingestion.repository.js";
import { createIngestionUnitOfWork } from "../../src/ingestion/prisma-ingestion.unit-of-work.js";
import { createReviewQueue, createWorkerConnection, type ReviewJobPayload } from "../../src/ingestion/queue.js";
import { disconnectRedis } from "../../src/lib/redis.js";
import { classifyFailure, retryPolicyConfigFromReviewConfig, retryPolicyFor } from "../../src/observability/retry.js";
import { reconcileIncompleteReviews } from "../../src/recovery/reconciliation.js";
import {
  ReviewJobRetryError,
  processReviewJob,
  startReviewWorker,
  stopReviewWorker,
} from "../../src/workspace/processor.js";
import {
  ReviewRetrievalError,
  type ReviewWorkspaceOperations,
  type WorkspaceResult,
} from "../../src/workspace/workspace.js";
import { testEnv } from "../helpers/env.js";
import { createTestIngestion, createTestReviewState, silentLogger } from "../helpers/ingestion.js";
import {
  cleanDatabase,
  disconnectDatabase,
  jobIdentity,
  outboxEventId,
  prisma,
  seedReviewChain,
  type SeededReviewChain,
} from "./support.js";

/**
 * Characterization: queue retry policy and execution (ARCHITECTURE.md §12.4,
 * §17.3).
 *
 * Four boundaries are pinned:
 *  1. the exported policy marks failure classes retryable or terminal;
 *  2. the outbox passes the configured attempts/backoff to the queue port;
 *  3. the real BullMQ worker applies the retry budget: transient failures are
 *     re-attempted, permanent failures are not;
 *  4. exhausted/stuck durable jobs are either recovered by reconciliation
 *     (non-terminal review, attempts remain) or failed with a stable code.
 */

const repositories = createIngestionRepositories(prisma);
const unitOfWork = createIngestionUnitOfWork(prisma);
const reviewQueue = createReviewQueue(testEnv.REDIS_URL);
const queue = reviewQueue.queue;

const retryPolicy = {
  infrastructure: { enabled: true, maxAttempts: 3, backoff: "exponential" as const },
  providerUnavailable: { enabled: false },
};

async function ageJobRow(jobId: string): Promise<void> {
  await prisma.$executeRaw`UPDATE review_jobs SET updated_at = now() - interval '30 minutes' WHERE id = ${jobId}`;
}

async function clearQueuedJobs(): Promise<void> {
  await queue.waitUntilReady();
  const jobs = await queue.getJobs(["waiting", "paused", "delayed", "failed", "completed"]);
  await Promise.all(jobs.map((job) => job.remove().catch(() => {})));
}

function payloadFor(chain: SeededReviewChain): ReviewJobPayload {
  const { jobKey } = jobIdentity(chain);
  return {
    reviewId: chain.reviewId,
    jobKey,
    githubInstallationId: String(chain.githubInstallationId),
    githubRepositoryId: String(chain.githubRepositoryId),
    repositoryFullName: chain.repositoryFullName,
    pullRequestNumber: 101,
    headSha: chain.headSha,
    baseSha: null,
    reviewMode: "adaptive",
    reviewType: "standard",
    trigger: "opened",
  };
}

function workspaceResult(headSha: string): WorkspaceResult {
  return {
    workspacePath: "/tmp/characterization-queue-retry",
    headSha,
    baseSha: null,
    mergeBaseSha: null,
    diff: "",
    changedFiles: [],
  };
}

const reviewState = createTestReviewState();

beforeEach(async () => {
  await cleanDatabase();
  await clearQueuedJobs();
});

afterAll(async () => {
  await clearQueuedJobs();
  await reviewQueue.close();
  await cleanDatabase();
  await disconnectDatabase();
});

describe("retry policy from configuration (§12.4)", () => {
  test("the configured policy marks transient failures as retryable", () => {
    const { config } = loadReviewConfig(DEFAULT_CONFIG_PATH);
    const policy = retryPolicyConfigFromReviewConfig(config);
    expect(policy).toMatchObject({
      infrastructure: { enabled: true, maxAttempts: 3, backoff: "exponential" },
      providerUnavailable: { enabled: false },
    });

    for (const input of [
      { errorCode: null, message: "GitHub API returned 503 Service Unavailable" },
      { errorCode: null, message: "Redis connection lost: ECONNREFUSED 127.0.0.1:6379" },
      { errorCode: null, message: "Prisma P1001: database unreachable" },
      { errorCode: "clone_failed", message: "git clone failed" },
    ]) {
      const failureClass = classifyFailure(input);
      const decision = retryPolicyFor(failureClass, policy);
      expect(decision, `${input.message} should retry`).toMatchObject({
        retry: true,
        maxAttempts: config.queue.retry.infrastructure.maxAttempts,
        backoff: config.queue.retry.infrastructure.backoff,
      });
    }
  });

  test("the configured policy marks permanent failures as non-retryable", () => {
    const { config } = loadReviewConfig(DEFAULT_CONFIG_PATH);
    const policy = retryPolicyConfigFromReviewConfig(config);

    const permanent = [
      { errorCode: "invalid_output", message: "model returned invalid JSON" },
      { errorCode: "stale_commit", message: "PR head moved before publication" },
      { errorCode: "timeout", message: "resource limit exceeded" },
      { errorCode: null, message: "unclassified explosion" },
    ];
    for (const input of permanent) {
      const decision = retryPolicyFor(classifyFailure(input), policy);
      expect(decision, `${input.message} must not retry`).toMatchObject({
        retry: false,
        maxAttempts: 1,
        backoff: "fixed",
      });
    }

    // Provider unavailability is opt-in and disabled in the checked-in config.
    expect(retryPolicyFor("model_unavailable", policy).retry).toBe(false);
  });

  test("the outbox enqueues with the configured attempts and backoff", async () => {
    const chain = await seedReviewChain({
      prefix: "retry-opts",
      job: { status: "pending_outbox" },
      outbox: { status: "pending" },
    });
    const added: Array<{ opts: { attempts?: number; backoff?: { type: string; delay: number } } }> = [];
    const capturingQueue = {
      enqueue: async (_payload: ReviewJobPayload, opts: { attempts?: number; backoff?: unknown } = {}) => {
        added.push({ opts: opts as { attempts?: number; backoff?: { type: string; delay: number } } });
        return { id: chain.jobId };
      },
      close: async () => {},
    };

    await expect(
      createTestIngestion({ queue: capturingQueue }).services.publishOutboxEvent(outboxEventId(chain)),
    ).resolves.toBe("published");

    expect(added).toHaveLength(1);
    const [captured] = added;
    if (!captured) {
      throw new Error("the outbox did not enqueue a job");
    }
    expect(captured.opts.attempts).toBe(3);
    expect(captured.opts.backoff).toEqual({ type: "exponential", delay: 5000 });
  });
});

describe("worker retry execution (§12.4)", () => {
  test("a transient failure is retried by BullMQ and the review completes", async () => {
    const chain = await seedReviewChain({
      prefix: "retry-transient-worker",
      state: "queued",
      job: { status: "enqueued" },
    });
    const { jobId } = jobIdentity(chain);

    let prepareCalls = 0;
    const service: ReviewWorkspaceOperations = {
      prepare: async (): Promise<WorkspaceResult> => {
        prepareCalls += 1;
        if (prepareCalls === 1) {
          throw new ReviewRetrievalError("git clone failed: transient network reset", "clone_failed");
        }
        return workspaceResult(chain.headSha);
      },
      cleanupAfterReview: async () => ({ removed: false }),
      cleanupAfterFailure: async () => {},
    };

    const connection = createWorkerConnection(testEnv.REDIS_URL);
    const worker = startReviewWorker(connection, {
      repositories,
      service,
      logger: silentLogger,
      transitionReviewState: reviewState.transitionReviewState,
      concurrency: 1,
      retryPolicy,
    });
    const failedAttempts: number[] = [];
    worker.on("failed", (job) => {
      failedAttempts.push(job?.attemptsMade ?? -1);
    });
    await Promise.all([worker.waitUntilReady(), queue.waitUntilReady()]);

    const completed = once(worker, "completed");
    const queueJob = await queue.add("review", payloadFor(chain), {
      jobId,
      attempts: 3,
      backoff: { type: "exponential", delay: 25 },
    });

    try {
      await completed;
      // BullMQ re-attempted exactly once and the second attempt succeeded.
      expect(failedAttempts).toEqual([1]);
      expect(prepareCalls).toBe(2);
      expect(await queueJob.getState()).toBe("completed");

      const job = await prisma.reviewJob.findUniqueOrThrow({ where: { id: jobId } });
      expect(job.status).toBe("completed");
      // One increment per processing attempt, including the failed one.
      expect(job.attempts).toBe(2);
      // Success clears the transient failure text recorded by the first attempt.
      expect(job.lastError).toBeNull();
      const review = await prisma.review.findUniqueOrThrow({ where: { id: chain.reviewId } });
      expect(review.state).toBe("analyzing");
      expect(review.errorCode).toBeNull();
    } finally {
      await queueJob.remove().catch(() => {});
      await stopReviewWorker(worker).catch(() => {});
      await disconnectRedis(connection);
    }
  }, 30_000);

  test("a permanent failure fails once without consuming the retry budget", async () => {
    const chain = await seedReviewChain({
      prefix: "retry-permanent-worker",
      state: "queued",
      job: { status: "enqueued" },
    });
    const { jobId } = jobIdentity(chain);

    let prepareCalls = 0;
    const service: ReviewWorkspaceOperations = {
      prepare: async (): Promise<WorkspaceResult> => {
        prepareCalls += 1;
        throw new AgentRuntimeError("invalid_output", "model returned invalid JSON");
      },
      cleanupAfterReview: async () => ({ removed: false }),
      cleanupAfterFailure: async () => {},
    };

    const connection = createWorkerConnection(testEnv.REDIS_URL);
    const worker = startReviewWorker(connection, {
      repositories,
      service,
      logger: silentLogger,
      transitionReviewState: reviewState.transitionReviewState,
      concurrency: 1,
      retryPolicy,
    });
    await Promise.all([worker.waitUntilReady(), queue.waitUntilReady()]);

    const failed = new Promise<number | undefined>((resolve) => {
      worker.once("failed", (job) => resolve(job?.attemptsMade));
    });
    const queueJob = await queue.add("review", payloadFor(chain), {
      jobId,
      attempts: 3,
      backoff: { type: "exponential", delay: 25 },
    });

    try {
      // One attempt only: invalid model output cannot become valid by retrying.
      expect(await failed).toBe(1);
      expect(prepareCalls).toBe(1);
      expect(await queueJob.getState()).toBe("failed");

      const job = await prisma.reviewJob.findUniqueOrThrow({ where: { id: jobId } });
      expect(job.status).toBe("failed");
      expect(job.attempts).toBe(1);
      const review = await prisma.review.findUniqueOrThrow({ where: { id: chain.reviewId } });
      expect(review.state).toBe("failed");
      expect(review.errorCode).toBe("invalid_output");
    } finally {
      await queueJob.remove().catch(() => {});
      await stopReviewWorker(worker).catch(() => {});
      await disconnectRedis(connection);
    }
  }, 30_000);
});

describe("durable retry decisions (§12.4)", () => {
  test("a transient attempt with budget remaining rethrows and stays claimable", async () => {
    const chain = await seedReviewChain({
      prefix: "retry-durable-transient",
      state: "queued",
      job: { status: "enqueued" },
    });
    const { jobId } = jobIdentity(chain);
    const service: ReviewWorkspaceOperations = {
      prepare: async () => {
        throw new ReviewRetrievalError("git clone failed: transient network reset", "clone_failed");
      },
      cleanupAfterFailure: async () => {},
      cleanupAfterReview: async () => ({ removed: false }),
    };

    await expect(
      processReviewJob(
        jobId,
        payloadFor(chain),
        {
          repositories,
          service,
          logger: silentLogger,
          concurrency: 1,
          transitionReviewState: reviewState.transitionReviewState,
          retryPolicy,
        },
        { attempt: 1, maxAttempts: 3 },
      ),
    ).rejects.toBeInstanceOf(ReviewJobRetryError);

    const job = await prisma.reviewJob.findUniqueOrThrow({ where: { id: jobId } });
    // Not failed: the durable row must remain claimable for the retry.
    expect(job.status).toBe("processing");
    expect(job.attempts).toBe(1);
    expect(job.lastError).toContain("clone failed");
    const review = await prisma.review.findUniqueOrThrow({ where: { id: chain.reviewId } });
    expect(review.state).toBe("queued");
    expect(review.errorCode).toBeNull();
  });

  test("the final transient attempt fails the job and review with retry_exhausted", async () => {
    const chain = await seedReviewChain({
      prefix: "retry-durable-exhausted",
      state: "queued",
      job: { status: "enqueued", attempts: 2 },
    });
    const { jobId } = jobIdentity(chain);
    const service: ReviewWorkspaceOperations = {
      prepare: async () => {
        throw new ReviewRetrievalError("git clone failed: transient network reset", "clone_failed");
      },
      cleanupAfterFailure: async () => {},
      cleanupAfterReview: async () => ({ removed: false }),
    };

    await expect(
      processReviewJob(
        jobId,
        payloadFor(chain),
        {
          repositories,
          service,
          logger: silentLogger,
          concurrency: 1,
          transitionReviewState: reviewState.transitionReviewState,
          retryPolicy,
        },
        { attempt: 3, maxAttempts: 3 },
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);

    const job = await prisma.reviewJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("failed");
    expect(job.attempts).toBe(3);
    const review = await prisma.review.findUniqueOrThrow({ where: { id: chain.reviewId } });
    expect(review.state).toBe("failed");
    expect(review.errorCode).toBe("retry_exhausted");
  });

  test("a permanent failure fails the job and review on the first attempt", async () => {
    const chain = await seedReviewChain({
      prefix: "retry-durable-permanent",
      state: "queued",
      job: { status: "enqueued" },
    });
    const { jobId } = jobIdentity(chain);
    const service: ReviewWorkspaceOperations = {
      prepare: async () => {
        throw new AgentRuntimeError("invalid_output", "model returned invalid JSON");
      },
      cleanupAfterFailure: async () => {},
      cleanupAfterReview: async () => ({ removed: false }),
    };

    await expect(
      processReviewJob(
        jobId,
        payloadFor(chain),
        {
          repositories,
          service,
          logger: silentLogger,
          concurrency: 1,
          transitionReviewState: reviewState.transitionReviewState,
          retryPolicy,
        },
        { attempt: 1, maxAttempts: 3 },
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);

    const job = await prisma.reviewJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("failed");
    expect(job.attempts).toBe(1);
    const review = await prisma.review.findUniqueOrThrow({ where: { id: chain.reviewId } });
    expect(review.state).toBe("failed");
    expect(review.errorCode).toBe("invalid_output");
  });
});

describe("failed-job recovery (§12.4, §17.3)", () => {
  test("reconciliation requeues a failed durable job whose review is not terminal", async () => {
    const chain = await seedReviewChain({
      prefix: "retry-failed-recover",
      state: "analyzing",
      job: { status: "failed", attempts: 1 },
    });
    const { jobId } = jobIdentity(chain);
    await ageJobRow(jobId);
    const added: Array<{ jobId?: string; attempts?: number }> = [];
    const fakeQueue = {
      getJob: async () => undefined,
      add: async (_name: string, _payload: ReviewJobPayload, opts: { jobId?: string; attempts?: number } = {}) => {
        added.push(opts);
        return { id: opts.jobId };
      },
    } as unknown as Queue<ReviewJobPayload>;

    const summary = await reconcileIncompleteReviews({
      repositories,
      unitOfWork,
      logger: silentLogger,
      queue: fakeQueue,
      staleThresholdMs: 15 * 60_000,
      maxJobAttempts: 3,
    });

    expect(summary).toMatchObject({ requeued: 1, failed: 0 });
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ jobId, attempts: 2 });
    const job = await prisma.reviewJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("enqueued");
    const review = await prisma.review.findUniqueOrThrow({ where: { id: chain.reviewId } });
    expect(review.state).toBe("queued");
  });

  test("reconciliation fails a failed job once its attempt budget is exhausted", async () => {
    const chain = await seedReviewChain({
      prefix: "retry-failed-exhausted",
      state: "analyzing",
      job: { status: "failed", attempts: 3 },
    });
    const { jobId } = jobIdentity(chain);
    await ageJobRow(jobId);

    const summary = await reconcileIncompleteReviews({
      repositories,
      unitOfWork,
      logger: silentLogger,
      staleThresholdMs: 15 * 60_000,
      maxJobAttempts: 3,
    });

    expect(summary).toMatchObject({ failed: 1, requeued: 0 });
    const review = await prisma.review.findUniqueOrThrow({ where: { id: chain.reviewId } });
    expect(review.state).toBe("failed");
    expect(review.errorCode).toBe("recovery_exhausted");
    const job = await prisma.reviewJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("failed");
  });

  test("a terminal failed review is never requeued by reconciliation", async () => {
    const chain = await seedReviewChain({
      prefix: "retry-failed-terminal",
      state: "failed",
      job: { status: "failed", attempts: 3 },
    });
    const { jobId } = jobIdentity(chain);
    await ageJobRow(jobId);

    const summary = await reconcileIncompleteReviews({
      repositories,
      unitOfWork,
      logger: silentLogger,
      staleThresholdMs: 15 * 60_000,
      maxJobAttempts: 3,
    });

    expect(summary).toMatchObject({ scanned: 0, requeued: 0, failed: 0 });
    const job = await prisma.reviewJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("failed");
  });
});
