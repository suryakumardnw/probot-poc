import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import type { Env } from "../config/env.js";
import { createReviewConfigStore } from "../config/review-config-store.js";
import { createLogger } from "../lib/logger.js";
import { createPrisma } from "../lib/prisma.js";
import { createRedis } from "../lib/redis.js";
import { createFindingsDependencies, type FindingsServiceDependencies } from "../modules/findings/index.js";
import {
  createIngestionServices,
  type IngestionRepositories,
  type IngestionServices,
  type IngestionUnitOfWork,
} from "../modules/ingestion/index.js";
import { createIngestionRepositories } from "../modules/ingestion/prisma-ingestion.repository.js";
import { createIngestionUnitOfWork } from "../modules/ingestion/prisma-ingestion.unit-of-work.js";
import { createReviewQueue, type BullMqReviewQueue } from "../modules/ingestion/queue.js";
import { systemClock, type Clock } from "../ports/clock.js";
import type { Logger } from "../ports/logger.js";
import type { ReviewConfigStore } from "../ports/review-config.js";
import type { ReviewQueue } from "../ports/review-queue.js";
import { createPublishingRepositories } from "../publishing/index.js";
import type { PublishingRepositories } from "../publishing/publishing.repository.js";

/**
 * Process-wide client construction.
 *
 * The composition roots call these factories exactly once per process and
 * inject the results into modules. Nothing here is a module-level singleton:
 * tests build their own graphs from the same factories.
 */

export interface PlatformClients {
  prisma: PrismaClient;
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
      ...process.env,
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
  prisma: PrismaClient;
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
export function createReviewModule(prisma: PrismaClient): ReviewModule {
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
    async close(): Promise<void> {
      await reviewQueue.close();
      await prisma.$disconnect().catch(() => {
        /* already closed */
      });
    },
  };
}
