import path from "node:path";
import type { Worker } from "bullmq";
import { loadEnv, type Env } from "../config/env.js";
import { createLogger, type PlatformLogger } from "../lib/logger.js";
import { checkPrisma, disconnectPrisma } from "../lib/prisma.js";
import { checkRedis, disconnectRedis, waitRedisReady } from "../lib/redis.js";
import { registerGracefulShutdown, runShutdownSteps, type ShutdownStep } from "../lib/shutdown.js";
import { reconcileIncompleteReviews } from "../modules/ingestion/index.js";
import { createWorkerConnection } from "../modules/ingestion/queue.js";
import {
  ensureKnowledgeSources,
  getKnowledgeSnapshot,
  materializeReviewKnowledge,
  persistKnowledgeMetrics,
  setKnowledgeSnapshot,
} from "../modules/knowledge/index.js";
import { createReviewPipelineHook } from "../modules/publishing/index.js";
import {
  ReviewWorkspaceService,
  createDefaultTokenProvider,
  createPrismaWorkspaceRepository,
  startReviewWorker,
  stopReviewWorker,
  workspaceDirectorySizeBytes,
} from "../modules/workspace/index.js";
import { AlertManager } from "../observability/alerts.js";
import { startMetricsServer, metricsServerPort } from "../observability/metrics-endpoint.js";
import { getMetricsRegistry } from "../observability/metrics.js";
import { retryPolicyConfigFromReviewConfig } from "../observability/retry.js";
import { createAgentRuntime } from "../platform/agents/index.js";
import { createGitHubOctokit } from "../platform/github/octokit.js";
import { createConfigStore, createIngestionModule, createPlatformClients, createReviewModule } from "./clients.js";

/**
 * Worker composition root.
 *
 * Builds the review worker graph exactly once: env → logger → Postgres/Redis/
 * queue clients → repositories → services → workspace pipeline → BullMQ
 * worker. `bootstrapWorker` starts the worker and registers graceful shutdown;
 * `createWorkerRuntime` is the same graph without consuming jobs, used by the
 * bootstrap smoke test.
 */

const OUTBOX_RECOVERY_INTERVAL_MS = 30_000;

export interface WorkerRuntime {
  logger: PlatformLogger;
  start(): Promise<void>;
  close(): Promise<void>;
}

export async function createWorkerRuntime(env: Env = loadEnv()): Promise<WorkerRuntime> {
  const logger = createLogger(env);
  logger.info("Review worker starting");

  const clients = createPlatformClients(env);
  const workerConnection = createWorkerConnection(env.REDIS_URL);
  const config = createConfigStore(env);
  const ingestion = createIngestionModule({
    prisma: clients.prisma,
    queue: clients.reviewQueue,
    config,
    logger,
  });
  const review = createReviewModule(clients.prisma);

  // Give Redis a bounded moment to complete its initial connection so the
  // "worker ready" status is meaningful. Never hangs: bounded by timeout.
  await waitRedisReady(clients.redis, 5000);

  const [postgres, redis] = await Promise.all([checkPrisma(clients.prisma), checkRedis(clients.redis)]);
  logger.info(
    {
      postgres: postgres.status,
      redis: redis.status,
    },
    "Review worker ready",
  );

  const { config: reviewConfig } = config.load();

  const workspaceRoot = process.env.WORKSPACE_ROOT_DIR ?? path.join(process.cwd(), "workspaces");
  const workspaceService = new ReviewWorkspaceService({
    policy: {
      cloneDepth: reviewConfig.repository.clone.depth,
      retentionHours: reviewConfig.repository.workspace.retentionHours,
      cleanupAfterReview: reviewConfig.repository.workspace.cleanupAfterReview,
      maxFilesPerReview: reviewConfig.repository.files.maxFilesPerReview,
      gitTimeoutMs: 300_000,
    },
    rootDir: workspaceRoot,
    tokenProvider: createDefaultTokenProvider(),
    workspaceRepository: createPrismaWorkspaceRepository(clients.prisma),
    logger,
  });

  const reviewPipelineHook = createReviewPipelineHook({
    runtime: createAgentRuntime(reviewConfig, {
      logger: {
        debug: (msg, obj) => logger.debug(typeof obj === "object" && obj !== null ? obj : {}, msg),
        info: (msg, obj) => logger.info(typeof obj === "object" && obj !== null ? obj : {}, msg),
        warn: (msg, obj) => logger.warn(typeof obj === "object" && obj !== null ? obj : {}, msg),
        error: (msg, obj) => logger.error(typeof obj === "object" && obj !== null ? obj : {}, msg),
      },
    }),
    config: reviewConfig,
    logger,
    transitionReviewState: ingestion.services.transitionReviewState,
    publishing: review.publishing,
    findings: review.findings,
    knowledge: {
      materialize: (input) =>
        materializeReviewKnowledge({
          ...input,
          snapshot: getKnowledgeSnapshot(),
          prisma: clients.prisma,
          logger,
        }),
      persistMetrics: (input) => persistKnowledgeMetrics(clients.prisma, input.reviewId, input.profile, input.metrics),
    },
    tokenProvider: createDefaultTokenProvider(),
    octokitFactory: (token) => createGitHubOctokit(token, process.env.GITHUB_BASE_URL),
  });

  let reviewWorker: Worker | undefined;
  let sweepTimer: NodeJS.Timeout | undefined;
  let outboxTimer: NodeJS.Timeout | undefined;
  let reconciliationTimer: NodeJS.Timeout | undefined;
  let alertTimer: NodeJS.Timeout | undefined;
  let metricsServer: Awaited<ReturnType<typeof startMetricsServer>> | undefined;
  let started = false;
  let closed = false;

  /**
   * Boot-time knowledge source initialization (§5.3): the code-review skill
   * playbook and the engineering handbook are fetched ONCE per worker boot
   * into the persistent knowledge cache — never per review. Bounded by a
   * per-source fetch deadline; a failure never crashes the worker. There is
   * no fallback content: the missing source is marked unavailable and reviews
   * of the type that needs it fail fast; standard reviews are unaffected.
   */
  async function initializeKnowledge(): Promise<void> {
    try {
      const knowledgeCacheDir =
        reviewConfig.knowledge.cacheDir.trim() ||
        process.env.KNOWLEDGE_CACHE_DIR?.trim() ||
        path.join(workspaceRoot, "knowledge");
      const knowledgeSnapshot = await ensureKnowledgeSources(reviewConfig, logger, {
        cacheDir: knowledgeCacheDir,
      });
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
  }

  /** Transactional outbox recovery loop (§12.2). Never throws. */
  function startOutboxRecovery(): void {
    outboxTimer = setInterval(() => {
      void ingestion.services.recoverOutbox().then((summary) => {
        if (summary.scanned > 0) {
          logger.info({ ...summary }, "Outbox recovery pass");
        }
      });
    }, OUTBOX_RECOVERY_INTERVAL_MS);
    outboxTimer.unref();

    // One recovery pass right after startup to drain anything pending.
    void ingestion.services.recoverOutbox().then((summary) => {
      if (summary.scanned > 0) {
        logger.info({ ...summary }, "Startup outbox recovery");
      }
    });
  }

  /**
   * Ticket 12 §12.4: startup reconciliation of incomplete reviews.
   *
   * Reuses the existing BullMQ job identity (jobId = ReviewJob.id, ticket 03
   * contract) so recovery can never create duplicate queue jobs. Runs once at
   * startup (after a bounded wait so Redis is reachable) and periodically.
   */
  function startReconciliation(): void {
    const runReconciliation = async (phase: "startup" | "periodic"): Promise<void> => {
      try {
        const summary = await reconcileIncompleteReviews({
          repositories: ingestion.repositories,
          unitOfWork: ingestion.unitOfWork,
          logger,
          queue: clients.reviewQueue.queue,
          staleThresholdMs: Number(process.env.RECOVERY_STALE_THRESHOLD_MS) || undefined,
          // Keep the durable recovery budget aligned with the BullMQ attempt
          // budget configured in review.json.
          maxJobAttempts: reviewConfig.queue.retry.infrastructure.maxAttempts,
          sweepExpiredWorkspaces: () => workspaceService.sweepExpired(reviewConfig.repository.workspace.retentionHours),
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
    reconciliationTimer = setInterval(() => {
      void runReconciliation("periodic");
    }, 60_000);
    reconciliationTimer.unref();
  }

  /** Ticket 12 §16.2/§16.4: gauges + alert evaluation loop. */
  function startAlerts(): void {
    const metrics = getMetricsRegistry();
    const alertManager = new AlertManager(logger);
    let lastFailedTotal = 0;
    let lastProviderErrorTotal = 0;
    let consecutiveReviewFailures = 0;

    const counterTotal = (values: Map<string, number>): number => [...values.values()].reduce((a, b) => a + b, 0);

    const diskUsageBytes = async (): Promise<number> => {
      try {
        // Directory usage, not whole-filesystem usage: the alert compares this
        // against the configured workspace limit.
        return await workspaceDirectorySizeBytes(workspaceRoot);
      } catch {
        return 0;
      }
    };

    const evaluateAlerts = async (): Promise<void> => {
      try {
        const counts = await clients.reviewQueue.queue.getJobCounts("waiting", "active", "delayed");
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

        const [postgresStatus, redisStatus] = await Promise.all([
          checkPrisma(clients.prisma),
          checkRedis(clients.redis),
        ]);

        alertManager.evaluate({
          queueDepth: depth,
          consecutiveReviewFailures,
          recentProviderErrors,
          recentGithubAuthErrors: 0,
          postgresOk: postgresStatus.status === "ok",
          redisOk: redisStatus.status === "ok",
          memoryUsageBytes,
          workspaceDiskUsageBytes,
        });
      } catch {
        // Alert evaluation is best-effort; the next tick retries.
      }
    };
    alertTimer = setInterval(() => {
      void evaluateAlerts();
    }, 15_000);
    alertTimer.unref();
    void evaluateAlerts();
  }

  /** Ticket 12 §16.2: worker-side metrics endpoint (METRICS_PORT). */
  async function startWorkerMetrics(): Promise<void> {
    const metricsPort = Number(process.env.METRICS_PORT);
    if (!Number.isFinite(metricsPort) || metricsPort <= 0) {
      return;
    }
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

  /**
   * Ordered teardown shared by signal handling and `close()`.
   *
   * Phases enforce the contract: stop timers, drain the BullMQ worker (active
   * jobs finish), then close the queue/Redis/Postgres clients. Postgres stays
   * open while the worker drains because the processor still writes state.
   */
  function shutdownSteps(): ShutdownStep[] {
    return [
      { name: "outbox-recovery-timer", phase: "stop-intake", run: async () => clearInterval(outboxTimer) },
      { name: "workspace-sweep-timer", phase: "stop-intake", run: async () => clearInterval(sweepTimer) },
      { name: "reconciliation-timer", phase: "stop-intake", run: async () => clearInterval(reconciliationTimer) },
      { name: "alert-timer", phase: "stop-intake", run: async () => clearInterval(alertTimer) },
      {
        name: "metrics-server",
        phase: "stop-intake",
        run: async () => {
          if (metricsServer) {
            await new Promise<void>((resolve) => metricsServer?.close(() => resolve()));
          }
        },
      },
      {
        name: "review-worker",
        phase: "drain",
        run: async () => (reviewWorker ? stopReviewWorker(reviewWorker) : undefined),
      },
      { name: "review-queue", phase: "close-connections", run: async () => clients.reviewQueue.close() },
      { name: "redis-worker", phase: "close-connections", run: async () => disconnectRedis(workerConnection) },
      { name: "redis", phase: "close-connections", run: async () => disconnectRedis(clients.redis) },
      { name: "postgres", phase: "close-connections", run: async () => disconnectPrisma(clients.prisma) },
      { name: "logger-flush", phase: "flush", run: async () => void logger.flush?.() },
    ];
  }

  function registerShutdown(): void {
    const configuredTimeoutMs = Number(process.env.SHUTDOWN_TIMEOUT_MS);
    registerGracefulShutdown(logger, shutdownSteps(), {
      ...(Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0 ? { timeoutMs: configuredTimeoutMs } : {}),
    });
  }

  return {
    logger,
    async start(): Promise<void> {
      if (started) {
        return;
      }
      started = true;

      await initializeKnowledge();

      // Ticket 04: review workspace retrieval. The worker consumes the
      // "review-jobs" queue with the configured concurrency and runs the
      // repository retrieval pipeline (shallow clone, exact SHA checkout, diff,
      // changed-file enumeration, workspace cleanup) per review job.
      reviewWorker = startReviewWorker(workerConnection, {
        repositories: ingestion.repositories,
        service: workspaceService,
        logger,
        transitionReviewState: ingestion.services.transitionReviewState,
        concurrency: reviewConfig.queue.concurrency,
        // Ticket 12 §12.4: retry policy from review.json (queue.retry.*).
        retryPolicy: retryPolicyConfigFromReviewConfig(reviewConfig),
        // Ticket 07+09: run the adaptive review engine on the prepared
        // workspace, then persist the findings (ticket 08) and publish the
        // review to GitHub (ticket 09), driving the review to a terminal state.
        // Runtime/config errors fail the review immediately (§8.4).
        onWorkspacePrepared: reviewPipelineHook,
      });

      // Periodic stale-workspace sweep per repository.workspace.retentionHours.
      sweepTimer = setInterval(() => {
        void workspaceService.sweepExpired(reviewConfig.repository.workspace.retentionHours).then((n) => {
          if (n > 0) {
            logger.info({ swept: n }, "Expired workspaces swept");
          }
        });
      }, 10 * 60_000);
      sweepTimer.unref();

      startOutboxRecovery();
      startReconciliation();
      startAlerts();
      await startWorkerMetrics();
      registerShutdown();
    },
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      // Same phase-ordered teardown as SIGTERM/SIGINT: the worker drains before
      // its queue/Redis/Postgres connections close.
      await runShutdownSteps(logger, shutdownSteps());
    },
  };
}

export async function bootstrapWorker(): Promise<void> {
  let logger: PlatformLogger | undefined;
  try {
    const runtime = await createWorkerRuntime();
    logger = runtime.logger;
    await runtime.start();
  } catch (error) {
    if (logger) {
      logger.fatal({ err: error }, "Review worker failed");
    } else {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
    process.exit(1);
  }
}
