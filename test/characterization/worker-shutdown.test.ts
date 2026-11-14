import { spawn, type ChildProcessByStdio } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import type pino from "pino";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { closeReviewQueue, getReviewQueue, type ReviewJobPayload } from "../../src/ingestion/queue.js";
import { startReviewWorker, stopReviewWorker } from "../../src/workspace/processor.js";
import type { ReviewWorkspaceService, WorkspaceResult } from "../../src/workspace/workspace.js";
import { cleanDatabase, disconnectDatabase, prisma, seedReviewChain, silentLogger } from "./support.js";

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

interface ShutdownRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

type PipedChild = ChildProcessByStdio<null, Readable, Readable>;

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
  const queue = getReviewQueue();
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
  await closeReviewQueue();
  await cleanDatabase();
  await disconnectDatabase();
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

    let prepareStarted!: () => void;
    const prepareStartedPromise = new Promise<void>((resolve) => {
      prepareStarted = resolve;
    });
    let releasePrepare!: () => void;
    const releasePreparePromise = new Promise<void>((resolve) => {
      releasePrepare = resolve;
    });

    const service = {
      prepare: async (): Promise<WorkspaceResult> => {
        prepareStarted();
        await releasePreparePromise;
        return {
          workspacePath: "/tmp/characterization-shutdown",
          headSha: chain.headSha,
          baseSha: null,
          mergeBaseSha: null,
          diff: "",
          changedFiles: [],
        };
      },
      cleanupAfterReview: async () => {},
      cleanupAfterFailure: async () => {},
    } as unknown as ReviewWorkspaceService;

    const worker = startReviewWorker(process.env.REDIS_URL ?? "redis://localhost:6379", {
      prisma,
      service,
      logger: silentLogger as unknown as pino.Logger,
      concurrency: 1,
    });
    const queue = getReviewQueue();
    await Promise.all([worker.waitUntilReady(), queue.waitUntilReady()]);

    const active = once(worker, "active");
    const payload: ReviewJobPayload = {
      reviewId: chain.reviewId,
      jobKey: chain.jobKey!,
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
    const queueJob = await queue.add("review", payload, { jobId: chain.jobId! });

    let stopped = false;
    let stopPromise: Promise<void> | undefined;
    try {
      await active;
      await prepareStartedPromise;
      const activeJob = await queue.getJob(chain.jobId!);
      expect(await activeJob!.getState()).toBe("active");

      stopPromise = stopReviewWorker(worker).then(() => {
        stopped = true;
      });

      // The worker must still be draining: closing does not abandon the
      // in-flight handle just because the processor is blocked.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(stopped).toBe(false);
      expect(await activeJob!.getState()).toBe("active");

      releasePrepare();
      await stopPromise;
      expect(stopped).toBe(true);

      // The active job ran to completion instead of being acknowledged early.
      const jobRow = await prisma.reviewJob.findUniqueOrThrow({ where: { id: chain.jobId! } });
      expect(jobRow.status).toBe("completed");
      const reviewRow = await prisma.review.findUniqueOrThrow({ where: { id: chain.reviewId } });
      expect(reviewRow.state).toBe("analyzing");
    } finally {
      releasePrepare();
      await stopPromise?.catch(() => {});
      await stopReviewWorker(worker).catch(() => {});
      await queueJob.remove().catch(() => {});
    }
  }, 30_000);
});
