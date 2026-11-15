import type { Logger } from "../ports/logger.js";

/**
 * Graceful shutdown helper.
 *
 * Registers SIGTERM/SIGINT handlers that run cleanup steps (stop accepting
 * new work, close connections, flush logs) and exit. Logs errors but never
 * crashes mid-cleanup.
 *
 * Steps are grouped into phases so teardown order is explicit and cannot be
 * broken by array reshuffling:
 *
 *  1. `stop-intake` — timers, metrics endpoint, other producers.
 *  2. `drain` — BullMQ workers; active jobs finish before their Redis
 *     connection is closed.
 *  3. `close-connections` — queue/Redis/Postgres clients.
 *  4. `flush` — logger buffers.
 *
 * When the deadline expires the process exits without acknowledging unfinished
 * work; BullMQ stalled-job recovery owns the forced-exit case.
 */

export type ShutdownPhase = "stop-intake" | "drain" | "close-connections" | "flush";

const PHASE_ORDER: Readonly<Record<ShutdownPhase, number>> = {
  "stop-intake": 0,
  drain: 1,
  "close-connections": 2,
  flush: 3,
};

export type ShutdownStep = {
  name: string;
  /** Defaults to `stop-intake`; steps keep declaration order within a phase. */
  phase?: ShutdownPhase;
  run: () => Promise<void>;
};

/** Stable, phase-ordered copy of the steps. */
export function orderShutdownSteps(steps: readonly ShutdownStep[]): ShutdownStep[] {
  return steps
    .map((step, index) => ({ step, index }))
    .sort((left, right) => {
      const phaseDelta = PHASE_ORDER[left.step.phase ?? "stop-intake"] - PHASE_ORDER[right.step.phase ?? "stop-intake"];
      return phaseDelta !== 0 ? phaseDelta : left.index - right.index;
    })
    .map(({ step }) => step);
}

/** Run shutdown steps sequentially, logging and swallowing per-step failures. */
export async function runShutdownSteps(logger: Logger, steps: readonly ShutdownStep[]): Promise<void> {
  for (const step of orderShutdownSteps(steps)) {
    try {
      await step.run();
      logger.debug({ step: step.name }, "Shutdown step completed");
    } catch (error) {
      logger.error({ step: step.name, err: error }, "Shutdown step failed");
    }
  }
}

export function registerGracefulShutdown(
  logger: Logger,
  steps: ShutdownStep[],
  options: { timeoutMs?: number; onExit?: () => void } = {},
): void {
  const timeoutMs = options.timeoutMs ?? 10_000;
  let shuttingDown = false;

  const shutdown = (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal, timeoutMs }, "Graceful shutdown initiated");

    const timer = setTimeout(() => {
      logger.error({ timeoutMs }, "Graceful shutdown timed out; forcing exit");
      process.exit(1);
    }, timeoutMs);
    timer.unref();

    void (async () => {
      await runShutdownSteps(logger, steps);
      clearTimeout(timer);
      logger.info("Graceful shutdown complete");
      options.onExit?.();
      process.exit(0);
    })();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
