import { spawn, type ChildProcessByStdio } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import type { ReviewJobPayload } from "../../src/contracts/queue.js";
import { createReviewJobService } from "../../src/modules/ingestion/index.js";
import { createIngestionRepositories } from "../../src/modules/ingestion/prisma-ingestion.repository.js";
import { createReviewJobProcessor } from "../../src/modules/workspace/processor.js";
import {
  ReviewRetrievalError,
  ReviewWorkspaceService,
  type ReviewWorkspaceOperations,
  type WorkspaceResult,
} from "../../src/modules/workspace/workspace.js";
import { NullTokenProvider } from "../../src/platform/github/app-auth.js";
import { createObservability } from "../../src/platform/observability/index.js";
import { createReviewQueue, createWorkerConnection } from "../../src/platform/queue/review-queue.js";
import { startReviewWorker, stopReviewWorker } from "../../src/platform/queue/review-worker.js";
import { disconnectRedis } from "../../src/platform/redis.js";
import { orderShutdownSteps } from "../../src/platform/shutdown.js";
import { testEnv } from "../helpers/env.js";
import { createTestReviewState, silentLogger } from "../helpers/ingestion.js";
import { cleanDatabase, disconnectDatabase, jobIdentity, prisma, seedReviewChain } from "./support.js";

/**
 * Characterization: graceful worker shutdown (ARCHITECTURE.md §12.4 / §17.3).
 *
 * Two layers are covered:
 *  - the real `registerGracefulShutdown` helper runs in a child process so
 *    SIGTERM delivery, deadline enforcement and `process.exit` codes are real;
 *  - a real BullMQ worker with an active, blocking job proves `stopReviewWorker`
 *    waits for in-flight work before closing.
 *
 * No production seam is added.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "../fixtures/shutdown-child.mjs");
const REPO_ROOT = path.resolve(__dirname, "../..");

const reviewQueue = createReviewQueue(testEnv.REDIS_URL);
const queue = reviewQueue.queue;
const transitionReviewState = createTestReviewState().transitionReviewState;
const jobs = createReviewJobService({ repositories: createIngestionRepositories(prisma) });

function startTestWorker(connection: ReturnType<typeof createWorkerConnection>, service: ReviewWorkspaceOperations) {
  const processor = createReviewJobProcessor({
    jobs,
    service,
    logger: silentLogger,
    observability: createObservability(),
    transitionReviewState,
  });
  return startReviewWorker(connection, { processor, logger: silentLogger, concurrency: 1 });
}

interface ShutdownRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

type PipedChild = ChildProcessByStdio<null, Readable, Readable>;

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

/** A promise plus its resolver without a definite-assignment assertion. */
function deferred(): Deferred {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  if (!resolvePromise) {
    throw new Error("deferred promise executor did not run synchronously");
  }
  return { promise, resolve: resolvePromise };
}

function waitForMarker(child: PipedChild, marker: string, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`child did not emit '${marker}' within ${timeoutMs}ms; output: ${output}`));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes(marker)) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`child exited (${code}) before emitting '${marker}'; output: ${output}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onData);
    child.on("exit", onExit);
  });
}

async function runWithSigterm(mode: "complete" | "timeout"): Promise<ShutdownRun> {
  const child: PipedChild = spawn(process.execPath, [FIXTURE, mode], {
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  const exitPromise = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
  try {
    await waitForMarker(child, "READY");
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }

  // Give Node a tick to install the native signal watcher behind the
  // process.on("SIGTERM") listener; a signal sent in the same tick as READY can
  // still hit the default disposition.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const sentAt = Date.now();
  child.kill("SIGTERM");
  const [code, signal] = await exitPromise;
  return { code, signal, stdout, stderr, elapsedMs: Date.now() - sentAt };
}

async function clearQueuedJobs(): Promise<void> {
  await queue.waitUntilReady();
  const jobs = await queue.getJobs(["waiting", "paused", "delayed", "failed"]);
  await Promise.all(jobs.map((job) => job.remove().catch(() => {})));
}

beforeEach(async () => {
  await cleanDatabase();
  // The shared review-jobs queue can contain waiting fixtures from earlier
  // characterization files. A real worker below must only see its own job.
  await clearQueuedJobs();
});

afterAll(async () => {
  await clearQueuedJobs();
  await reviewQueue.close();
  await cleanDatabase();
  await disconnectDatabase();
});

describe("shutdown phase ordering", () => {
  test("the worker drains before queue/Redis/Postgres connections close", () => {
    const ordered = orderShutdownSteps([
      { name: "postgres", phase: "close-connections", run: async () => {} },
      { name: "redis", phase: "close-connections", run: async () => {} },
      { name: "review-queue", phase: "close-connections", run: async () => {} },
      { name: "review-worker", phase: "drain", run: async () => {} },
      { name: "metrics-server", phase: "stop-intake", run: async () => {} },
      { name: "logger-flush", phase: "flush", run: async () => {} },
    ]);

    expect(ordered.map((step) => step.name)).toEqual([
      "metrics-server",
      "review-worker",
      "postgres",
      "redis",
      "review-queue",
      "logger-flush",
    ]);
  });
});

describe("graceful shutdown helper (synthetic active step)", () => {
  test("SIGTERM during an active job waits for the job and cleanup to finish before exit 0", async () => {
    const run = await runWithSigterm("complete");

    expect(run.code).toBe(0);
    expect(run.stdout).toContain("READY");
    // The active-job step completed before cleanup ran...
    expect(run.stdout).toContain("JOB_COMPLETED");
    expect(run.stdout).toContain("WORKER_CLOSED");
    expect(run.stdout).toContain("SHUTDOWN_COMPLETE");
    expect(run.stdout.indexOf("JOB_COMPLETED")).toBeLessThan(run.stdout.indexOf("WORKER_CLOSED"));
    // ...and the process stayed alive for the duration of the job (250ms),
    // well inside the 2s deadline it was given.
    expect(run.elapsedMs).toBeGreaterThanOrEqual(200);
    expect(run.elapsedMs).toBeLessThan(2_000);
  });

  test("a deadline breach forces exit without acknowledging or closing unfinished work", async () => {
    const run = await runWithSigterm("timeout");

    expect(run.code).toBe(1);
    expect(run.stdout).toContain("READY");
    expect(run.stdout).toContain("timed out");
    // The unresolvable active job never reports completion, and no subsequent
    // cleanup step ran: unfinished work is not acknowledged as done.
    expect(run.stdout).not.toContain("JOB_COMPLETED");
    expect(run.stdout).not.toContain("WORKER_CLOSED");
    expect(run.stdout).not.toContain("SHUTDOWN_COMPLETE");
    expect(run.elapsedMs).toBeGreaterThanOrEqual(150);
    expect(run.elapsedMs).toBeLessThan(2_000);
  });
});

describe("real BullMQ worker drain", () => {
  test("stopReviewWorker waits for a real active job before closing", async () => {
    const chain = await seedReviewChain({
      prefix: "shutdown-active",
      state: "queued",
      job: { status: "enqueued" },
    });

    const prepareStarted = deferred();
    const releasePrepare = deferred();
    const { jobId, jobKey } = jobIdentity(chain);

    const service: ReviewWorkspaceOperations = {
      prepare: async (): Promise<WorkspaceResult> => {
        prepareStarted.resolve();
        await releasePrepare.promise;
        return {
          workspacePath: "/tmp/characterization-shutdown",
          headSha: chain.headSha,
          baseSha: null,
          mergeBaseSha: null,
          diff: "",
          changedFiles: [],
        };
      },
      cleanupAfterReview: async () => ({ removed: false }),
      cleanupAfterFailure: async () => {},
    };

    const workerConnection = createWorkerConnection(testEnv.REDIS_URL);
    const worker = startTestWorker(workerConnection, service);
    await Promise.all([worker.waitUntilReady(), queue.waitUntilReady()]);

    const active = once(worker, "active");
    const payload: ReviewJobPayload = {
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
    const queueJob = await queue.add("review", payload, { jobId });

    let stopped = false;
    let stopPromise: Promise<void> | undefined;
    try {
      await active;
      await prepareStarted.promise;
      const activeJob = await queue.getJob(jobId);
      if (!activeJob) {
        throw new Error("the active queue job was not found");
      }
      expect(await activeJob.getState()).toBe("active");

      stopPromise = stopReviewWorker(worker).then(() => {
        stopped = true;
      });

      // The worker must still be draining: closing does not abandon the
      // in-flight handle just because the processor is blocked.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(stopped).toBe(false);
      expect(await activeJob.getState()).toBe("active");

      releasePrepare.resolve();
      await stopPromise;
      expect(stopped).toBe(true);

      // The active job ran to completion instead of being acknowledged early.
      const jobRow = await prisma.reviewJob.findUniqueOrThrow({ where: { id: jobId } });
      expect(jobRow.status).toBe("completed");
      const reviewRow = await prisma.review.findUniqueOrThrow({ where: { id: chain.reviewId } });
      expect(reviewRow.state).toBe("analyzing");
    } finally {
      releasePrepare.resolve();
      await stopPromise?.catch(() => {});
      await stopReviewWorker(worker).catch(() => {});
      await disconnectRedis(workerConnection);
      await queueJob.remove().catch(() => {});
    }
  }, 30_000);
});

describe("real BullMQ worker retry during shutdown", () => {
  test("worker shutdown while an active attempt fails transiently schedules the retry instead of losing it", async () => {
    const chain = await seedReviewChain({
      prefix: "shutdown-retry",
      state: "queued",
      job: { status: "enqueued" },
    });
    const { jobId, jobKey } = jobIdentity(chain);

    let prepareCalls = 0;
    const prepareStarted = deferred();
    const releasePrepare = deferred();
    const service: ReviewWorkspaceOperations = {
      prepare: async (): Promise<WorkspaceResult> => {
        prepareCalls += 1;
        if (prepareCalls === 1) {
          prepareStarted.resolve();
          await releasePrepare.promise;
          throw new ReviewRetrievalError("git clone failed: transient network reset", "clone_failed");
        }
        return {
          workspacePath: "/tmp/characterization-shutdown-retry",
          headSha: chain.headSha,
          baseSha: null,
          mergeBaseSha: null,
          diff: "",
          changedFiles: [],
        };
      },
      cleanupAfterReview: async () => ({ removed: false }),
      cleanupAfterFailure: async () => {},
    };

    const workerConnection = createWorkerConnection(testEnv.REDIS_URL);
    const worker = startTestWorker(workerConnection, service);
    await Promise.all([worker.waitUntilReady(), queue.waitUntilReady()]);

    const payload: ReviewJobPayload = {
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
    const queueJob = await queue.add("review", payload, {
      jobId,
      attempts: 3,
      backoff: { type: "fixed", delay: 60_000 },
    });

    let stopPromise: Promise<void> | undefined;
    let retryWorker: ReturnType<typeof startTestWorker> | undefined;
    let retryConnection: ReturnType<typeof createWorkerConnection> | undefined;
    try {
      const active = once(worker, "active");
      await active;
      await prepareStarted.promise;

      stopPromise = stopReviewWorker(worker);
      // The worker is draining the blocked attempt; the job is not acknowledged
      // early and not abandoned.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await queueJob.getState()).toBe("active");

      releasePrepare.resolve();
      await stopPromise;

      // The transient failure was scheduled for retry, not recorded as success
      // or as a terminal failure.
      expect(await queueJob.getState()).toBe("delayed");
      const failedJob = await prisma.reviewJob.findUniqueOrThrow({ where: { id: jobId } });
      expect(failedJob.status).toBe("processing");
      expect(failedJob.attempts).toBe(1);
      expect(failedJob.lastError).toContain("clone failed");
      const failedReview = await prisma.review.findUniqueOrThrow({ where: { id: chain.reviewId } });
      expect(failedReview.state).toBe("queued");
      expect(failedReview.errorCode).toBeNull();

      // A restarted worker picks the same queue job up: the retry completes.
      await queueJob.promote();
      retryConnection = createWorkerConnection(testEnv.REDIS_URL);
      retryWorker = startTestWorker(retryConnection, service);
      const completed = once(retryWorker, "completed");
      await retryWorker.waitUntilReady();
      await completed;

      expect(prepareCalls).toBe(2);
      expect(await queueJob.getState()).toBe("completed");
      const completedJob = await prisma.reviewJob.findUniqueOrThrow({ where: { id: jobId } });
      expect(completedJob.status).toBe("completed");
      expect(completedJob.attempts).toBe(2);
    } finally {
      releasePrepare.resolve();
      await stopPromise?.catch(() => {});
      if (retryWorker) {
        await stopReviewWorker(retryWorker).catch(() => {});
      }
      if (retryConnection) {
        await disconnectRedis(retryConnection);
      }
      await stopReviewWorker(worker).catch(() => {});
      await disconnectRedis(workerConnection);
      await queueJob.remove().catch(() => {});
    }
  }, 30_000);
});

describe("real BullMQ worker permanent payload failure", () => {
  test("a malformed queue payload fails once with a stable code and does not retry", async () => {
    const chain = await seedReviewChain({
      prefix: "malformed-payload",
      state: "queued",
      job: { status: "enqueued" },
    });
    const { jobId, jobKey } = jobIdentity(chain);
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-malformed-"));
    const service = new ReviewWorkspaceService({
      policy: {
        cloneDepth: 1,
        retentionHours: 1,
        cleanupAfterReview: true,
        maxFilesPerReview: 10,
        gitTimeoutMs: 1_000,
      },
      rootDir,
      appEnv: process.env,
      tokenProvider: new NullTokenProvider(),
    });
    const workerConnection = createWorkerConnection(testEnv.REDIS_URL);
    const worker = startTestWorker(workerConnection, service);
    await Promise.all([worker.waitUntilReady(), queue.waitUntilReady()]);

    const failed = new Promise<{ attemptsMade: number | undefined; message: string }>((resolve) => {
      worker.once("failed", (job, error) => {
        resolve({ attemptsMade: job?.attemptsMade, message: error.message });
      });
    });
    // A valid payload with one invalid enum value: mutate after construction
    // so the deliberately malformed fixture needs no boundary cast.
    const invalidPayload: ReviewJobPayload = {
      reviewId: chain.reviewId,
      jobKey,
      githubInstallationId: chain.githubInstallationId.toString(),
      githubRepositoryId: chain.githubRepositoryId.toString(),
      repositoryFullName: chain.repositoryFullName,
      pullRequestNumber: 101,
      headSha: chain.headSha,
      reviewMode: "adaptive",
      reviewType: "standard",
      trigger: "opened",
    };
    Object.assign(invalidPayload, { reviewMode: "not-a-mode" });
    const queueJob = await queue.add("review", invalidPayload, {
      jobId,
      attempts: 3,
      backoff: { type: "exponential", delay: 10 },
    });

    try {
      const failure = await failed;
      expect(failure.message).toContain("REVIEW_JOB_PAYLOAD_INVALID");
      // One attempt only: a malformed payload must not consume the retry budget.
      expect(failure.attemptsMade).toBe(1);
      expect(await queueJob.getState()).toBe("failed");

      const jobRow = await prisma.reviewJob.findUniqueOrThrow({ where: { id: jobId } });
      expect(jobRow.status).toBe("failed");
      expect(jobRow.lastError).toContain("REVIEW_JOB_PAYLOAD_INVALID");

      const review = await prisma.review.findUniqueOrThrow({ where: { id: chain.reviewId } });
      expect(review.state).toBe("failed");
      expect(review.errorCode).toBe("REVIEW_JOB_PAYLOAD_INVALID");

      const transition = await prisma.reviewStateTransition.findFirst({
        where: { reviewId: chain.reviewId },
        orderBy: { createdAt: "desc" },
      });
      expect(transition?.toState).toBe("failed");
    } finally {
      await queueJob.remove().catch(() => {});
      await stopReviewWorker(worker).catch(() => {});
      await disconnectRedis(workerConnection);
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  }, 30_000);
});
