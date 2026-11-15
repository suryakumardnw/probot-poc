import { getPrisma } from "../lib/prisma.js";
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
 * The default-dependency helpers below are the temporary module-edge wiring for
 * PR 2.3. They are the only place in this module that reads the Prisma
 * singleton; PR 2.6 replaces them with the bootstrap composition root.
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
export function createFindingsDependencies(prisma: PrismaRootClient = getPrisma()): FindingsServiceDependencies {
  return {
    repositories: createFindingsRepositories(prisma),
    unitOfWork: createFindingsUnitOfWork(prisma),
  };
}

let defaultDependencies: FindingsServiceDependencies | undefined;

/** Temporary lazy singleton wiring used by the exported module-edge functions. */
export function getDefaultFindingsDependencies(): FindingsServiceDependencies {
  defaultDependencies ??= createFindingsDependencies(getPrisma());
  return defaultDependencies;
}
