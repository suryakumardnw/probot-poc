/**
 * Child process used by test/characterization/worker-shutdown.test.ts.
 *
 * It exercises the real `registerGracefulShutdown` helper (Node's native type
 * stripping imports the TypeScript source directly) and prints a small,
 * line-oriented protocol on stdout:
 *
 *   READY             → safe to send SIGTERM
 *   JOB_COMPLETED     → the active job finished before exit
 *   WORKER_CLOSED     → the worker-close step ran
 *   SHUTDOWN_COMPLETE → the helper reached the end of its cleanup steps
 *
 * The timeout mode never resolves the active job, so only the helper's
 * deadline can end the process.
 */
import { registerGracefulShutdown } from "../../src/lib/shutdown.ts";

const mode = process.argv[2] ?? "complete";

const write = (message) => {
  process.stdout.write(`${message}\n`);
};

const logger = {
  info: () => {},
  debug: () => {},
  error: (obj, msg) => {
    write(`LOG_ERROR ${msg} ${JSON.stringify(obj ?? {})}`);
  },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const steps = [
  {
    name: "active-job",
    run: async () => {
      await sleep(mode === "timeout" ? 60_000 : 250);
      write("JOB_COMPLETED");
    },
  },
  {
    name: "worker-close",
    run: async () => {
      write("WORKER_CLOSED");
    },
  },
];

registerGracefulShutdown(logger, steps, {
  timeoutMs: mode === "timeout" ? 200 : 2_000,
  onExit: () => write("SHUTDOWN_COMPLETE"),
});

// Signal listeners do not keep the event loop alive on their own. The real
// worker has BullMQ/timers doing this; the fixture needs an explicit handle so
// it waits for SIGTERM instead of exiting immediately after READY.
setInterval(() => {}, 1_000);

write("READY");
