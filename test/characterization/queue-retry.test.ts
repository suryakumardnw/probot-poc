import type { Queue } from "bullmq";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { DEFAULT_CONFIG_PATH, loadReviewConfig } from "../../src/config/review-loader.js";
import { createIngestionRepositories } from "../../src/ingestion/prisma-ingestion.repository.js";
import { createIngestionUnitOfWork } from "../../src/ingestion/prisma-ingestion.unit-of-work.js";
import type { ReviewJobPayload } from "../../src/ingestion/queue.js";
import { classifyFailure, retryPolicyConfigFromReviewConfig, retryPolicyFor } from "../../src/observability/retry.js";
import { reconcileIncompleteReviews } from "../../src/recovery/reconciliation.js";
import { processReviewJob } from "../../src/workspace/processor.js";
import type { ReviewWorkspaceService } from "../../src/workspace/workspace.js";
import { createTestIngestion, createTestReviewState, silentLogger } from "../helpers/ingestion.js";
import { cleanDatabase, disconnectDatabase, prisma, seedReviewChain } from "./support.js";

/**
 * Characterization: queue retry policy (ARCHITECTURE.md §12.4).
 *
 * Three boundaries are pinned:
 *  1. the exported policy marks failure classes retryable or terminal;
 *  2. the outbox passes the configured attempts/backoff to BullMQ;
 *  3. an exhausted durable job ends `failed`.
 *
 * POLICY ONLY: the two policy tests below call the exported classifier/policy
 * functions directly. They do not enqueue or observe a retried BullMQ job.
 * Worker retry execution is a known production gap deferred to PR 2.8; see
 * test/characterization/README.md.
 */

async function ageJobRow(jobId: string): Promise<void> {
  await prisma.$executeRaw`UPDATE review_jobs SET updated_at = now() - interval '30 minutes' WHERE id = ${jobId}`;
}

const repositories = createIngestionRepositories(prisma);
const unitOfWork = createIngestionUnitOfWork(prisma);

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
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
      add: async (_name: string, _payload: ReviewJobPayload, opts: { attempts?: number; backoff?: unknown } = {}) => {
        added.push({ opts: opts as { attempts?: number; backoff?: { type: string; delay: number } } });
        return { id: chain.jobId };
      },
    };

    await expect(
      createTestIngestion({ queue: capturingQueue }).services.publishOutboxEvent(chain.outboxEventId!),
    ).resolves.toBe("published");

    expect(added).toHaveLength(1);
    expect(added[0]!.opts.attempts).toBe(3);
    expect(added[0]!.opts.backoff).toEqual({ type: "exponential", delay: 5000 });
  });
});

describe("job exhaustion (§12.4, §17.3)", () => {
  test("reconciliation re-enqueues a stale transient failure when attempts remain", async () => {
    const chain = await seedReviewChain({
      prefix: "retry-transient",
      state: "analyzing",
      job: { status: "processing", attempts: 1 },
    });
    await ageJobRow(chain.jobId!);
    const added: Array<{ jobId?: string; attempts?: number; backoff?: { type: string; delay: number } }> = [];
    const queue = {
      getJob: async () => undefined,
      add: async (
        _name: string,
        _payload: ReviewJobPayload,
        opts: { jobId?: string; attempts?: number; backoff?: { type: string; delay: number } } = {},
      ) => {
        added.push(opts);
        return { id: opts.jobId };
      },
    } as unknown as Queue<ReviewJobPayload>;

    const summary = await reconcileIncompleteReviews({
      repositories,
      unitOfWork,
      logger: silentLogger,
      queue,
      staleThresholdMs: 15 * 60_000,
      maxJobAttempts: 3,
    });

    expect(summary).toMatchObject({ requeued: 1, failed: 0 });
    expect(added).toHaveLength(1);
    // Same durable identity — recovery can never create a duplicate queue job.
    expect(added[0]).toMatchObject({ jobId: chain.jobId, attempts: 2, backoff: { type: "exponential", delay: 5000 } });
    const review = await prisma.review.findUniqueOrThrow({ where: { id: chain.reviewId } });
    expect(review.state).toBe("queued");
    const job = await prisma.reviewJob.findUniqueOrThrow({ where: { id: chain.jobId! } });
    expect(job.status).toBe("enqueued");
  });

  test("reconciliation fails a stale review once the durable attempt budget is exhausted", async () => {
    const chain = await seedReviewChain({
      prefix: "retry-exhausted",
      state: "analyzing",
      job: { status: "processing", attempts: 3 },
    });
    await ageJobRow(chain.jobId!);

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
    const job = await prisma.reviewJob.findUniqueOrThrow({ where: { id: chain.jobId! } });
    expect(job.status).toBe("failed");
  });

  test("a failing processing attempt leaves the durable job failed with the error", async () => {
    const chain = await seedReviewChain({
      prefix: "retry-process-failure",
      state: "queued",
      job: { status: "enqueued" },
    });
    const service = {
      prepare: async () => {
        throw new Error("git clone failed: repository not found");
      },
      cleanupAfterFailure: async () => {},
      cleanupAfterReview: async () => {},
    } as unknown as ReviewWorkspaceService;

    const outcome = await processReviewJob(
      chain.jobId!,
      {
        reviewId: chain.reviewId,
        jobKey: chain.jobKey!,
        githubInstallationId: String(chain.githubInstallationId),
        githubRepositoryId: String(chain.githubRepositoryId),
        repositoryFullName: "retry-process-failure-org/retry-process-failure-repo",
        pullRequestNumber: 101,
        headSha: chain.headSha,
        reviewMode: "adaptive",
        reviewType: "standard",
        trigger: "opened",
      },
      {
        repositories: createIngestionRepositories(prisma),
        service,
        logger: silentLogger,
        concurrency: 1,
        transitionReviewState: createTestReviewState().transitionReviewState,
        retryPolicy: {
          infrastructure: { enabled: true, maxAttempts: 3, backoff: "exponential" },
          providerUnavailable: { enabled: false },
        },
      },
    );

    expect(outcome).toBe("failed");
    const job = await prisma.reviewJob.findUniqueOrThrow({ where: { id: chain.jobId! } });
    expect(job.status).toBe("failed");
    expect(job.attempts).toBe(1);
    expect(job.lastError).toContain("clone failed");
    const review = await prisma.review.findUniqueOrThrow({ where: { id: chain.reviewId } });
    expect(review.state).toBe("failed");
    expect(review.errorCode).toBe("retrieval_failed");
  });
});
