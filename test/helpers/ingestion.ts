import { createReviewConfigStore } from "../../src/config/review-config-store.js";
import {
  createIngestionServices,
  createReviewStateService,
  type IngestionRepositories,
  type IngestionServices,
  type IngestionUnitOfWork,
  type ReviewStateService,
} from "../../src/modules/ingestion/index.js";
import { createIngestionRepositories } from "../../src/modules/ingestion/prisma-ingestion.repository.js";
import { createIngestionUnitOfWork } from "../../src/modules/ingestion/prisma-ingestion.unit-of-work.js";
import { createReviewQueue, type BullMqReviewQueue } from "../../src/modules/ingestion/queue.js";
import { systemClock, type Clock } from "../../src/ports/clock.js";
import type { Logger } from "../../src/ports/logger.js";
import type { ReviewConfigStore } from "../../src/ports/review-config.js";
import type { ReviewQueue } from "../../src/ports/review-queue.js";
import { prisma } from "./db.js";
import { testEnv } from "./env.js";

/**
 * Build an ingestion module against test-owned clients.
 *
 * Production bootstrap uses the same `createIngestionServices` factory; tests
 * pass their own queue and close it explicitly. Passing a fake queue exercises
 * the Redis-unavailable path without a container.
 */

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child(): Logger {
    return this;
  },
};

export interface TestIngestionOptions {
  queue?: ReviewQueue;
  config?: ReviewConfigStore;
  logger?: Logger;
  clock?: Clock;
}

export interface TestIngestion {
  services: IngestionServices;
  repositories: IngestionRepositories;
  unitOfWork: IngestionUnitOfWork;
  reviewQueue?: BullMqReviewQueue;
  close(): Promise<void>;
}

export function createTestIngestion(options: TestIngestionOptions = {}): TestIngestion {
  const reviewQueue = options.queue ? undefined : createReviewQueue(testEnv.REDIS_URL);
  const queue = options.queue ?? reviewQueue;
  if (!queue) {
    throw new Error("test ingestion requires a queue");
  }
  const config = options.config ?? createReviewConfigStore();
  const repositories = createIngestionRepositories(prisma);
  const unitOfWork = createIngestionUnitOfWork(prisma);
  const services = createIngestionServices({
    repositories,
    unitOfWork,
    config,
    queue,
    logger: options.logger ?? silentLogger,
    clock: options.clock ?? systemClock,
  });

  return {
    services,
    repositories,
    unitOfWork,
    ...(reviewQueue ? { reviewQueue } : {}),
    async close(): Promise<void> {
      await reviewQueue?.close();
    },
  };
}

/** Review-state transitions bound to the test database. */
export function createTestReviewState(): ReviewStateService {
  return createReviewStateService({
    repositories: createIngestionRepositories(prisma),
    clock: systemClock,
  });
}
