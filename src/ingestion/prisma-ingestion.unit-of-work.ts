import { createReviewConfigStore } from "../config/review-config-store.js";
import { getPrisma } from "../lib/prisma.js";
import type { ReviewConfigStore } from "../ports/review-config.js";
import type { IngestionRepositories, IngestionUnitOfWork } from "./ingestion.unit-of-work.js";
import { createIngestionRepositories, type PrismaRootClient } from "./prisma-ingestion.repository.js";

/**
 * Prisma-backed ingestion unit of work (ARCHITECTURE.md §6.6).
 *
 * The default isolation level, transaction timeout, and commit/rollback
 * semantics are Prisma's defaults: this adapter only builds a repository
 * bundle bound to the transaction client.
 *
 * The default-dependency helpers below are the temporary module-edge wiring for
 * PR 2.1. They are the only place in this module that reads the Prisma
 * singleton; PR 2.6 replaces them with the bootstrap composition root.
 */

export function createIngestionUnitOfWork(prisma: PrismaRootClient): IngestionUnitOfWork {
  return {
    execute<T>(work: (repos: IngestionRepositories) => Promise<T>): Promise<T> {
      return prisma.$transaction((tx) => work(createIngestionRepositories(tx)));
    },
  };
}

export type IngestionServiceDependencies = {
  repositories: IngestionRepositories;
  unitOfWork: IngestionUnitOfWork;
  config: ReviewConfigStore;
};

/** Build the service dependencies for one Prisma client. */
export function createIngestionDependencies(
  prisma: PrismaRootClient = getPrisma(),
  config: ReviewConfigStore = createReviewConfigStore(),
): IngestionServiceDependencies {
  return {
    repositories: createIngestionRepositories(prisma),
    unitOfWork: createIngestionUnitOfWork(prisma),
    config,
  };
}

let defaultDependencies: IngestionServiceDependencies | undefined;

/** Temporary lazy singleton wiring used by the exported module-edge functions. */
export function getDefaultIngestionDependencies(): IngestionServiceDependencies {
  defaultDependencies ??= createIngestionDependencies(getPrisma());
  return defaultDependencies;
}
