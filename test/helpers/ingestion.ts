import { createReviewConfigStore } from "../../src/config/review-config-store.js";
import {
  createIngestionServices,
  type IngestionRepositories,
  type IngestionServices,
  type IngestionUnitOfWork,
} from "../../src/ingestion/index.js";
import { createIngestionRepositories } from "../../src/ingestion/prisma-ingestion.repository.js";
import { createIngestionUnitOfWork } from "../../src/ingestion/prisma-ingestion.unit-of-work.js";
import { createReviewQueue, type ReviewQueue, type ReviewQueueWriter } from "../../src/ingestion/queue.js";
import { createReviewStateService, type ReviewStateService } from "../../src/ingestion/review-state.service.js";
import { systemClock, type Clock } from "../../src/ports/clock.js";
import type { Logger } from "../../src/ports/logger.js";
import type { ReviewConfigStore } from "../../src/ports/review-config.js";
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
  queue?: ReviewQueueWriter;
  config?: ReviewConfigStore;
  logger?: Logger;
  clock?: Clock;
}

export interface TestIngestion {
  services: IngestionServices;
  repositories: IngestionRepositories;
  unitOfWork: IngestionUnitOfWork;
  reviewQueue?: ReviewQueue;
  close(): Promise<void>;
}

export function createTestIngestion(options: TestIngestionOptions = {}): TestIngestion {
  const reviewQueue = options.queue ? undefined : createReviewQueue(testEnv.REDIS_URL);
  const queue = options.queue ?? reviewQueue?.queue;
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
    unitOfWork: createIngestionUnitOfWork(prisma),
    clock: systemClock,
  });
}
