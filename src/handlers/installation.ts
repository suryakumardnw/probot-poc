import type { Probot } from "probot";
import type { IngestionUnitOfWork } from "../ingestion/index.js";

/**
 * GitHub App installation lifecycle handlers (ARCHITECTURE.md §13.1).
 *
 * installation.created: register the installation and its repositories.
 * installation.deleted: mark the installation deleted and disable its
 * repositories (no further reviews are ingested for them).
 *
 * Durable writes go through the injected ingestion unit of work, so the
 * handler never names a database client.
 */

export interface InstallationHandlerDeps {
  unitOfWork: IngestionUnitOfWork;
}

export function registerInstallationHandlers(app: Probot, deps: InstallationHandlerDeps): void {
  app.on("installation.created", async (context) => {
    const installationPayload = context.payload;
    const { installation, repositories } = installationPayload;
    const account = installation.account;
    const organization =
      account && "login" in account ? account.login : ((account as { name?: string | null } | null)?.name ?? "unknown");
    try {
      await deps.unitOfWork.execute(async (repos) => {
        const record = await repos.installations.upsertActive({
          githubInstallationId: BigInt(installation.id),
          organization,
        });

        for (const repo of repositories ?? []) {
          await repos.repositories.upsertFromInstallation({
            githubRepositoryId: BigInt(repo.id),
            installationId: record.id,
            fullName: repo.full_name,
            defaultBranch: (repo as { default_branch?: string }).default_branch ?? null,
          });
        }
      });
      context.log.info(
        { installation: installation.id, repositories: repositories?.length ?? 0 },
        "Installation registered",
      );
    } catch (error) {
      context.log.error({ err: error }, "Failed to register installation");
    }
  });

  app.on("installation.deleted", async (context) => {
    const { installation } = context.payload;
    try {
      await deps.unitOfWork.execute(async (repos) => {
        const record = await repos.installations.markDeleted(BigInt(installation.id));
        await repos.repositories.disableByInstallation(record.id);
      });
      context.log.info({ installation: installation.id }, "Installation marked deleted");
    } catch (error) {
      // Unknown installations are ignored (not registered here).
      context.log.warn({ err: error }, "Failed to mark installation deleted");
    }
  });
}
