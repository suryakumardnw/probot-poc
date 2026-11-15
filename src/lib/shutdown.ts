import type { Logger } from "../ports/logger.js";

/**
 * Graceful shutdown helper.
 *
 * Registers SIGTERM/SIGINT handlers that run cleanup steps (stop accepting
 * new work, close connections, flush logs) and exit. Logs errors but never
 * crashes mid-cleanup.
 */

export type ShutdownStep = {
  name: string;
  run: () => Promise<void>;
};

export function registerGracefulShutdown(
  logger: Logger,
  steps: ShutdownStep[],
  options: { timeoutMs?: number; onExit?: () => void } = {},
): void {
  const timeoutMs = options.timeoutMs ?? 10_000;
  let shuttingDown = false;

  const shutdown = (signal: string) => {
    if (shuttingDown) {return;}
    shuttingDown = true;
    logger.info({ signal }, "Graceful shutdown initiated");

    const timer = setTimeout(() => {
      logger.error({ timeoutMs }, "Graceful shutdown timed out; forcing exit");
      process.exit(1);
    }, timeoutMs);
    timer.unref();

    void (async () => {
      for (const step of steps) {
        try {
          await step.run();
          logger.debug({ step: step.name }, "Shutdown step completed");
        } catch (error) {
          logger.error({ step: step.name, err: error }, "Shutdown step failed");
        }
      }
      clearTimeout(timer);
      logger.info("Graceful shutdown complete");
      options.onExit?.();
      process.exit(0);
    })();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
