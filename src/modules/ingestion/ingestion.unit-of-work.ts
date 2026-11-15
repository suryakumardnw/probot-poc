import type {
  InstallationRepository,
  PullRequestRepository,
  RepositoryRepository,
  ReviewJobRepository,
  ReviewRepository,
  ReviewStateTransitionRepository,
  WebhookDeliveryRepository,
} from "./ingestion.repository.js";
import type { OutboxRepository } from "./outbox.repository.js";

/**
 * Transaction-scoped repository bundle and unit-of-work port
 * (ARCHITECTURE.md §6.6).
 *
 * The callback receives repositories bound to one database transaction. The
 * Prisma transaction client lives only in the adapter; services never name it.
 */

export interface IngestionRepositories {
  installations: InstallationRepository;
  repositories: RepositoryRepository;
  pullRequests: PullRequestRepository;
  reviews: ReviewRepository;
  reviewJobs: ReviewJobRepository;
  stateTransitions: ReviewStateTransitionRepository;
  webhookDeliveries: WebhookDeliveryRepository;
  outboxEvents: OutboxRepository;
}

export interface IngestionUnitOfWork {
  execute<T>(work: (repos: IngestionRepositories) => Promise<T>): Promise<T>;
}
