import type { IngestionRepositories, IngestionUnitOfWork } from "./ingestion.unit-of-work.js";
import { createIngestionRepositories, type PrismaRootClient } from "./prisma-ingestion.repository.js";

/**
 * Prisma-backed ingestion unit of work (ARCHITECTURE.md §6.6).
 *
 * The default isolation level, transaction timeout, and commit/rollback
 * semantics are Prisma's defaults: this adapter only builds a repository
 * bundle bound to the transaction client.
 *
 * Factories take every dependency explicitly. Bootstrap constructs the client
 * once and passes it here; there is no module-edge singleton.
 */

export function createIngestionUnitOfWork(prisma: PrismaRootClient): IngestionUnitOfWork {
  return {
    execute<T>(work: (repos: IngestionRepositories) => Promise<T>): Promise<T> {
      return prisma.$transaction((tx) => work(createIngestionRepositories(tx)));
    },
  };
}
