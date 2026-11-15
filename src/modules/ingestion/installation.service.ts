import type { IngestionUnitOfWork } from "./ingestion.unit-of-work.js";

/**
 * GitHub App installation lifecycle service (ARCHITECTURE.md §13.1).
 *
 * `installation.created` registers the installation and its repositories;
 * `installation.deleted` marks the installation deleted and disables its
 * repositories. Webhooks call this service instead of driving the ingestion
 * unit of work (and therefore another module's repositories) directly.
 */

export type InstallationRepositoryInput = {
  githubRepositoryId: bigint;
  fullName: string;
  defaultBranch: string | null;
};

export type RegisterInstallationInput = {
  githubInstallationId: bigint;
  organization: string;
  repositories: readonly InstallationRepositoryInput[];
};

export interface InstallationService {
  /** Register/refresh one installation and every repository in its payload. */
  registerInstallation(input: RegisterInstallationInput): Promise<void>;
  /**
   * Mark a registered installation deleted and disable its repositories.
   * Throws when the installation was never registered (callers decide whether
   * that is an error).
   */
  markInstallationDeleted(githubInstallationId: bigint): Promise<void>;
}

export type InstallationServiceDependencies = {
  unitOfWork: IngestionUnitOfWork;
};

export function createInstallationService(deps: InstallationServiceDependencies): InstallationService {
  return {
    async registerInstallation(input: RegisterInstallationInput): Promise<void> {
      await deps.unitOfWork.execute(async (repos) => {
        const installation = await repos.installations.upsertActive({
          githubInstallationId: input.githubInstallationId,
          organization: input.organization,
        });
        for (const repository of input.repositories) {
          await repos.repositories.upsertFromInstallation({
            githubRepositoryId: repository.githubRepositoryId,
            installationId: installation.id,
            fullName: repository.fullName,
            defaultBranch: repository.defaultBranch,
          });
        }
      });
    },

    async markInstallationDeleted(githubInstallationId: bigint): Promise<void> {
      await deps.unitOfWork.execute(async (repos) => {
        const installation = await repos.installations.markDeleted(githubInstallationId);
        await repos.repositories.disableByInstallation(installation.id);
      });
    },
  };
}
