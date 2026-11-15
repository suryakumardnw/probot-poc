import type { Redis } from "ioredis";
import { createFindingsDependencies, type FindingsServiceDependencies } from "../modules/findings/index.js";
import {
  createIngestionServices,
  type IngestionRepositories,
  type IngestionServices,
  type IngestionUnitOfWork,
} from "../modules/ingestion/index.js";
import { createIngestionRepositories } from "../modules/ingestion/prisma-ingestion.repository.js";
import { createIngestionUnitOfWork } from "../modules/ingestion/prisma-ingestion.unit-of-work.js";
import { createPublishingRepositories, type PublishingRepositories } from "../modules/publishing/index.js";
import type { TriageServiceDependencies } from "../modules/triage/index.js";
import { readProcessEnv, type Env } from "../platform/config/env.js";
import { createReviewConfigStore } from "../platform/config/review-config-store.js";
import { createPrisma } from "../platform/db/prisma.js";
import { createLogger } from "../platform/logger.js";
import { createGroqTriageProvider } from "../platform/models/groq-triage.js";
import { createReviewQueue, type BullMqReviewQueue } from "../platform/queue/review-queue.js";
import { createRedis } from "../platform/redis.js";
import { systemClock, type Clock } from "../ports/clock.js";
import type { Logger } from "../ports/logger.js";
import type { ReviewConfigStore } from "../ports/review-config.js";
import type { ReviewQueue } from "../ports/review-queue.js";

/**
 * Process-wide client construction.
 *
 * The composition roots call these factories exactly once per process and
 * inject the results into modules. Nothing here is a module-level singleton:
 * tests build their own graphs from the same factories.
 */

/**
 * Database client type inferred from the platform factory. Bootstrap never
 * imports the vendor type directly; `platform/db` owns the Prisma client.
 */
type DatabaseClient = ReturnType<typeof createPrisma>;

export interface PlatformClients {
  prisma: DatabaseClient;
  redis: Redis;
  reviewQueue: BullMqReviewQueue;
}

export function createPlatformClients(env: Env): PlatformClients {
  return {
    prisma: createPrisma(env),
    redis: createRedis(env),
    reviewQueue: createReviewQueue(env.REDIS_URL),
  };
}

/**
 * Review configuration resolves `${VAR}` references against the real process
 * environment merged with the validated env.
 */
export function createConfigStore(env: Env): ReviewConfigStore {
  return createReviewConfigStore({
    env: {
      ...readProcessEnv(),
      ...Object.fromEntries(Object.entries(env).map(([key, value]) => [key, String(value)])),
    },
  });
}

export interface IngestionModule {
  services: IngestionServices;
  repositories: IngestionRepositories;
  unitOfWork: IngestionUnitOfWork;
}

export function createIngestionModule(input: {
  prisma: DatabaseClient;
  queue: ReviewQueue;
  config: ReviewConfigStore;
  logger: Logger;
  clock?: Clock;
}): IngestionModule {
  const repositories = createIngestionRepositories(input.prisma);
  const unitOfWork = createIngestionUnitOfWork(input.prisma);
  const services = createIngestionServices({
    repositories,
    unitOfWork,
    config: input.config,
    queue: input.queue,
    logger: input.logger,
    clock: input.clock ?? systemClock,
  });
  return { services, repositories, unitOfWork };
}

export interface ReviewModule {
  findings: FindingsServiceDependencies;
  publishing: PublishingRepositories;
}

/** Data-side dependencies of the review pipeline (findings + publication). */
export function createReviewModule(prisma: DatabaseClient): ReviewModule {
  return {
    findings: createFindingsDependencies(prisma),
    publishing: createPublishingRepositories(prisma),
  };
}

/**
 * Services needed by the Probot CLI entry point (`lib/index.js`).
 *
 * The CLI owns its process, so it composes the webhook-side graph lazily when
 * Probot loads the app. `server.ts` uses the explicit bootstrap composition
 * and shares the same factory pieces.
 */
export interface AppServices {
  ingestion: IngestionServices;
  ingestionRepositories: IngestionRepositories;
  ingestionUnitOfWork: IngestionUnitOfWork;
  triage: TriageServiceDependencies;
  config: ReviewConfigStore;
}

/**
 * Triage provider wiring.
 *
 * The provider reads the existing `GROQ_API_KEY` / `GROQ_MODEL` environment
 * variables and resolves them lazily on the first triage call, so composition
 * never fails when triage is not configured.
 */
export function createTriageDependencies(env: NodeJS.ProcessEnv = readProcessEnv()): TriageServiceDependencies {
  return { provider: createGroqTriageProvider({ env }) };
}

export interface WebhookServices extends AppServices {
  close(): Promise<void>;
}

export function createWebhookServices(env: Env): WebhookServices {
  const logger = createLogger(env);
  const prisma = createPrisma(env);
  const reviewQueue = createReviewQueue(env.REDIS_URL);
  const config = createConfigStore(env);
  const module = createIngestionModule({ prisma, queue: reviewQueue, config, logger });
  return {
    ingestion: module.services,
    ingestionRepositories: module.repositories,
    ingestionUnitOfWork: module.unitOfWork,
    triage: createTriageDependencies(),
    config,
    async close(): Promise<void> {
      await reviewQueue.close();
      await prisma.$disconnect().catch(() => {
        /* already closed */
      });
    },
  };
}
