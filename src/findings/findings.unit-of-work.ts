import type { FindingRepository, FindingStatusTransitionRepository } from "./findings.repository.js";

/**
 * Transaction-scoped findings repository bundle and unit-of-work port
 * (ARCHITECTURE.md §6.6, §7.2).
 *
 * The callback receives repositories bound to one database transaction. The
 * Prisma transaction client lives only in the adapter; the service never names
 * it, and every finding/transition write of one operation shares the boundary.
 */

export interface FindingsRepositories {
  findings: FindingRepository;
  statusTransitions: FindingStatusTransitionRepository;
}

export interface FindingsUnitOfWork {
  execute<T>(work: (repos: FindingsRepositories) => Promise<T>): Promise<T>;
}
