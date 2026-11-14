import { spawn, type ChildProcessByStdio } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * Characterization: graceful worker shutdown (ARCHITECTURE.md §12.4 / §17.3).
 *
 * The real `registerGracefulShutdown` helper runs in a child process so SIGTERM
 * delivery, deadline enforcement and `process.exit` codes are observed exactly
 * as production code sees them. The child fixture represents the worker's
 * active-job step; no production seam is added.
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

describe("graceful shutdown", () => {
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
