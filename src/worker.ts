import "dotenv/config";
import path from "node:path";
import type { Worker } from "bullmq";
import { createAgentRuntime } from "./agent/index.js";
import { loadEnv } from "./config/env.js";
import { loadIngestionConfig } from "./ingestion/orchestrator.js";
import { recoverOutbox } from "./ingestion/outbox.js";
import { closeReviewQueue } from "./ingestion/queue.js";
import { getReviewQueue } from "./ingestion/queue.js";
import { ensureKnowledgeSources, setKnowledgeSnapshot } from "./knowledge/index.js";
import { createLogger } from "./lib/logger.js";
import { checkPrisma, disconnectPrisma, getPrisma } from "./lib/prisma.js";
import { checkRedis, disconnectRedis, getRedis, waitRedisReady } from "./lib/redis.js";
import { registerGracefulShutdown } from "./lib/shutdown.js";
import { AlertManager } from "./observability/alerts.js";
import { startMetricsServer, metricsServerPort } from "./observability/metrics-endpoint.js";
import { getMetricsRegistry } from "./observability/metrics.js";
import { retryPolicyConfigFromReviewConfig } from "./observability/retry.js";
import { createReviewPipelineHook } from "./publishing/index.js";
import { reconcileIncompleteReviews } from "./recovery/reconciliation.js";
import { workspaceDirectorySizeBytes } from "./workspace/disk.js";
import { createDefaultTokenProvider, startReviewWorker, stopReviewWorker } from "./workspace/processor.js";
import { ReviewWorkspaceService } from "./workspace/workspace.js";

/**
 * Review worker entry point.
 *
 * The worker is independent of Probot's webhook lifecycle. It runs as its
 * own process/container, connects to PostgreSQL and Redis, and executes
 * review jobs.
 *
 * Ticket 03 (Durable Review Ingestion) adds the BullMQ review queue and the
 * transactional-outbox recovery loop (§12.2): pending outbox events (e.g.
 * created while Redis was down) are re-published every 30 seconds.
 */

const env = loadEnv();
const logger = createLogger(env);

const OUTBOX_RECOVERY_INTERVAL_MS = 30_000;

async function main(): Promise<void> {
  logger.info("Review worker starting");

  // Initiate connections. Failures here must not crash the process:
  // the worker starts, and dependency checks report what is unavailable.
  getPrisma(env);
  getRedis(env);
  // Give Redis a bounded moment to complete its initial connection so the
  // "worker ready" status is meaningful. Never hangs: bounded by timeout.
  await waitRedisReady(5000);

  const [postgres, redis] = await Promise.all([checkPrisma(), checkRedis()]);
  logger.info(
    {
      postgres: postgres.status,
      redis: redis.status,
    },
    "Review worker ready",
  );

  const { config } = loadIngestionConfig();

  // -------------------------------------------------------------------------
  // Boot-time knowledge source initialization (§5.3): the code-review skill
  // playbook and the engineering handbook are fetched ONCE per worker boot
  // into the persistent knowledge cache — never per review. Bounded by a
  // per-source fetch deadline; a failure never crashes the worker. There is
  // no fallback content: the missing source is marked unavailable and reviews
  // of the type that needs it fail fast; standard reviews are unaffected.
  // -------------------------------------------------------------------------
  try {
    const knowledgeCacheDir =
      config.knowledge.cacheDir.trim() ||
      process.env.KNOWLEDGE_CACHE_DIR?.trim() ||
      path.join(process.env.WORKSPACE_ROOT_DIR ?? path.join(process.cwd(), "workspaces"), "knowledge");
    const knowledgeSnapshot = await ensureKnowledgeSources(config, logger, { cacheDir: knowledgeCacheDir });
    setKnowledgeSnapshot(knowledgeSnapshot);
    logger.info(
      {
        skill: { status: knowledgeSnapshot.skill.status, ref: knowledgeSnapshot.skill.ref },
        handbook: { status: knowledgeSnapshot.handbook.status, ref: knowledgeSnapshot.handbook.ref },
        handbookVariants: (knowledgeSnapshot.handbookVariants ?? []).map((variant) => ({
          technologies: variant.technologies,
          status: variant.source.status,
          ref: variant.source.ref,
        })),
        cacheDir: knowledgeSnapshot.cacheDir,
      },
      "Knowledge sources initialized",
    );
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      "Knowledge source initialization failed; the worker starts anyway (skill/handbook reviews will fail fast)",
    );
  }

  // Ticket 04: review workspace retrieval. The worker consumes the
  // "review-jobs" queue with the configured concurrency and runs the
  // repository retrieval pipeline (shallow clone, exact SHA checkout, diff,
  // changed-file enumeration, workspace cleanup) per review job.
  const workspaceService = new ReviewWorkspaceService({
    policy: {
      cloneDepth: config.repository.clone.depth,
      retentionHours: config.repository.workspace.retentionHours,
      cleanupAfterReview: config.repository.workspace.cleanupAfterReview,
      maxFilesPerReview: config.repository.files.maxFilesPerReview,
      gitTimeoutMs: 300_000,
    },
    rootDir: process.env.WORKSPACE_ROOT_DIR ?? path.join(process.cwd(), "workspaces"),
    tokenProvider: createDefaultTokenProvider(),
    prisma: getPrisma(env),
    logger,
  });
  const reviewWorker: Worker = startReviewWorker(env.REDIS_URL, {
    prisma: getPrisma(env),
    service: workspaceService,
    logger,
    concurrency: config.queue.concurrency,
    // Ticket 12 §12.4: retry policy from review.json (queue.retry.*).
    retryPolicy: retryPolicyConfigFromReviewConfig(config),
    // Ticket 07+09: run the adaptive review engine on the prepared workspace,
    // then persist the findings (ticket 08) and publish the review to GitHub
    // (ticket 09), driving the review to a terminal state.
    // Runtime/config errors fail the review immediately (§8.4).
    onWorkspacePrepared: createReviewPipelineHook({
      runtime: createAgentRuntime(config, {
        logger: {
          debug: (msg, obj) => logger.debug(obj ?? {}, msg),
          info: (msg, obj) => logger.info(obj ?? {}, msg),
          warn: (msg, obj) => logger.warn(obj ?? {}, msg),
          error: (msg, obj) => logger.error(obj ?? {}, msg),
        },
      }),
      config,
      logger,
      prisma: getPrisma(env),
      tokenProvider: createDefaultTokenProvider(),
    }),
  });
  // Periodic stale-workspace sweep per repository.workspace.retentionHours.
  const sweepTimer = setInterval(() => {
    void workspaceService.sweepExpired(config.repository.workspace.retentionHours).then((n) => {
      if (n > 0) {
        logger.info({ swept: n }, "Expired workspaces swept");
      }
    });
  }, 10 * 60_000);
  sweepTimer.unref();

  // Transactional outbox recovery loop (§12.2). Never throws.
  const outboxTimer = setInterval(() => {
    void recoverOutbox().then((summary) => {
      if (summary.scanned > 0) {
        logger.info({ ...summary }, "Outbox recovery pass");
      }
    });
  }, OUTBOX_RECOVERY_INTERVAL_MS);
  outboxTimer.unref();

  // One recovery pass right after startup to drain anything pending.
  void recoverOutbox().then((summary) => {
    if (summary.scanned > 0) {
      logger.info({ ...summary }, "Startup outbox recovery");
    }
  });

  // -------------------------------------------------------------------------
  // Ticket 12 §12.4: startup reconciliation of incomplete reviews.
  //
  // Reuses the existing BullMQ job identity (jobId = ReviewJob.id, ticket 03
  // contract) so recovery can never create duplicate queue jobs. Runs once at
  // startup (after a bounded wait so Redis is reachable) and periodically.
  // -------------------------------------------------------------------------
  const recoveryQueue = getReviewQueue(env.REDIS_URL);
  const runReconciliation = async (phase: "startup" | "periodic"): Promise<void> => {
    try {
      const summary = await reconcileIncompleteReviews({
        prisma: getPrisma(env),
        logger,
        queue: recoveryQueue,
        staleThresholdMs: Number(process.env.RECOVERY_STALE_THRESHOLD_MS) || undefined,
        sweepExpiredWorkspaces: () => workspaceService.sweepExpired(config.repository.workspace.retentionHours),
      });
      if (summary.scanned > 0) {
        logger.info({ phase, ...summary }, "Incomplete review reconciliation pass");
      }
    } catch (error) {
      logger.warn(
        { err: error instanceof Error ? error.message : String(error), phase },
        "Reconciliation pass failed; will retry",
      );
    }
  };
  void runReconciliation("startup");
  const reconciliationTimer = setInterval(() => {
    void runReconciliation("periodic");
  }, 60_000);
  reconciliationTimer.unref();

  // -------------------------------------------------------------------------
  // Ticket 12 §16.2/§16.4: gauges + alert evaluation loop.
  // -------------------------------------------------------------------------
  const metrics = getMetricsRegistry();
  const alertManager = new AlertManager(logger);
  let lastFailedTotal = 0;
  let lastProviderErrorTotal = 0;
  let consecutiveReviewFailures = 0;

  const counterTotal = (values: Map<string, number>): number => [...values.values()].reduce((a, b) => a + b, 0);

  const diskUsageBytes = async (): Promise<number> => {
    try {
      const root = process.env.WORKSPACE_ROOT_DIR ?? path.join(process.cwd(), "workspaces");
      // Directory usage, not whole-filesystem usage: the alert compares this
      // against the configured workspace limit.
      return await workspaceDirectorySizeBytes(root);
    } catch {
      return 0;
    }
  };

  const evaluateAlerts = async (): Promise<void> => {
    try {
      const counts = await recoveryQueue.getJobCounts("waiting", "active", "delayed");
      const depth = (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0);
      metrics.queueDepth.set(depth);

      const failedTotal = counterTotal(metrics.reviewsFailed.values);
      const failedDelta = failedTotal - lastFailedTotal;
      lastFailedTotal = failedTotal;
      consecutiveReviewFailures = failedDelta > 0 ? consecutiveReviewFailures + failedDelta : 0;

      const providerErrorTotal = counterTotal(metrics.providerErrors.values);
      const recentProviderErrors = providerErrorTotal - lastProviderErrorTotal;
      lastProviderErrorTotal = providerErrorTotal;

      const memoryUsageBytes = process.memoryUsage().rss;
      metrics.workerMemoryUsage.set(memoryUsageBytes);

      const workspaceDiskUsageBytes = await diskUsageBytes();
      metrics.workspaceDiskUsage.set(workspaceDiskUsageBytes);

      const [postgres, redis] = await Promise.all([checkPrisma(), checkRedis()]);

      alertManager.evaluate({
        queueDepth: depth,
        consecutiveReviewFailures,
        recentProviderErrors,
        recentGithubAuthErrors: 0,
        postgresOk: postgres.status === "ok",
        redisOk: redis.status === "ok",
        memoryUsageBytes,
        workspaceDiskUsageBytes,
      });
    } catch {
      // Alert evaluation is best-effort; the next tick retries.
    }
  };
  const alertTimer = setInterval(() => {
    void evaluateAlerts();
  }, 15_000);
  alertTimer.unref();
  void evaluateAlerts();

  // Ticket 12 §16.2: worker-side metrics endpoint (METRICS_PORT). The Probot
  // server already exposes /metrics; the worker is a separate container.
  let metricsServer: Awaited<ReturnType<typeof startMetricsServer>> | undefined;
  const metricsPort = Number(process.env.METRICS_PORT);
  if (Number.isFinite(metricsPort) && metricsPort > 0) {
    try {
      metricsServer = await startMetricsServer(metricsPort, process.env.METRICS_HOST ?? "0.0.0.0");
      logger.info({ port: metricsServerPort(metricsServer) }, "Worker metrics server started");
    } catch (error) {
      logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "Could not start worker metrics server",
      );
    }
  }

  registerGracefulShutdown(logger, [
    { name: "outbox-recovery-timer", run: async () => clearInterval(outboxTimer) },
    { name: "workspace-sweep-timer", run: async () => clearInterval(sweepTimer) },
    { name: "reconciliation-timer", run: async () => clearInterval(reconciliationTimer) },
    { name: "alert-timer", run: async () => clearInterval(alertTimer) },
    {
      name: "metrics-server",
      run: async () => {
        if (metricsServer) {
          await new Promise<void>((resolve) => metricsServer!.close(() => resolve()));
        }
      },
    },
    {
      name: "recovery-queue",
      run: async () => {
        try {
          await recoveryQueue.close();
        } catch {
          /* already closed */
        }
      },
    },
    { name: "review-worker", run: async () => stopReviewWorker(reviewWorker) },
    { name: "review-queue", run: closeReviewQueue },
    { name: "redis", run: disconnectRedis },
    { name: "postgres", run: disconnectPrisma },
    { name: "logger-flush", run: async () => void logger.flush?.() },
  ]);
}

void main().catch((error) => {
  // Only configuration errors (e.g. invalid env) abort startup.
  if (error?.name === "EnvValidationError") {
    logger.fatal({ err: error }, "Review worker failed to start");
    process.exit(1);
  }
  logger.fatal({ err: error }, "Review worker failed");
  process.exit(1);
});
