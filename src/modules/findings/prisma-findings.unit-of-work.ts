import type { FindingsRepositories, FindingsUnitOfWork } from "./findings.unit-of-work.js";
import { createFindingsRepositories, type PrismaRootClient } from "./prisma-findings.repository.js";

/**
 * Prisma-backed findings unit of work (ARCHITECTURE.md §6.6, §7.2).
 *
 * The default isolation level, transaction timeout, and commit/rollback
 * semantics are Prisma's defaults: this adapter only builds a repository bundle
 * bound to the transaction client, so persist and supersede each commit or roll
 * back as a unit.
 *
 * Factories take every dependency explicitly; bootstrap constructs the client
 * once and injects it.
 */

export function createFindingsUnitOfWork(prisma: PrismaRootClient): FindingsUnitOfWork {
  return {
    execute<T>(work: (repos: FindingsRepositories) => Promise<T>): Promise<T> {
      return prisma.$transaction((tx) => work(createFindingsRepositories(tx)));
    },
  };
}

export type FindingsServiceDependencies = {
  repositories: FindingsRepositories;
  unitOfWork: FindingsUnitOfWork;
};

/** Build the service dependencies for one Prisma client. */
export function createFindingsDependencies(prisma: PrismaRootClient): FindingsServiceDependencies {
  return {
    repositories: createFindingsRepositories(prisma),
    unitOfWork: createFindingsUnitOfWork(prisma),
  };
}
