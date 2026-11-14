import type { Probot } from "probot";
import { getPrisma } from "../lib/prisma.js";

/**
 * GitHub App installation lifecycle handlers (ARCHITECTURE.md §13.1).
 *
 * installation.created: register the installation and its repositories.
 * installation.deleted: mark the installation deleted and disable its
 * repositories (no further reviews are ingested for them).
 */

export function registerInstallationHandlers(app: Probot): void {
  app.on("installation.created", async (context) => {
    const installationPayload = context.payload;
    const { installation, repositories } = installationPayload;
    const account = installation.account;
    const organization =
      account && "login" in account ? account.login : ((account as { name?: string | null } | null)?.name ?? "unknown");
    try {
      await getPrisma().$transaction(async (tx) => {
        const record = await tx.installation.upsert({
          where: { githubInstallationId: BigInt(installation.id) },
          create: {
            githubInstallationId: BigInt(installation.id),
            organization,
            status: "active",
          },
          update: {
            organization,
            status: "active",
          },
        });

        for (const repo of repositories ?? []) {
          await tx.repository.upsert({
            where: { githubRepositoryId: BigInt(repo.id) },
            create: {
              githubRepositoryId: BigInt(repo.id),
              installationId: record.id,
              fullName: repo.full_name,
              defaultBranch: (repo as { default_branch?: string }).default_branch ?? null,
              status: "active",
            },
            update: {
              fullName: repo.full_name,
              defaultBranch: (repo as { default_branch?: string }).default_branch ?? null,
              installationId: record.id,
              status: "active",
            },
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
      await getPrisma().$transaction(async (tx) => {
        const record = await tx.installation.update({
          where: { githubInstallationId: BigInt(installation.id) },
          data: { status: "deleted" },
        });
        await tx.repository.updateMany({
          where: { installationId: record.id },
          data: { status: "disabled" },
        });
      });
      context.log.info({ installation: installation.id }, "Installation marked deleted");
    } catch (error) {
      // Unknown installations are ignored (not registered here).
      context.log.warn({ err: error }, "Failed to mark installation deleted");
    }
  });
}
