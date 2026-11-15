import type { Probot } from "probot";
import { ingestReviewRequest, type IngestTrigger } from "../ingestion/index.js";

/**
 * Pull request webhook handlers (ARCHITECTURE.md §4, §13.1).
 *
 * Registered events: opened, synchronize, ready_for_review. All other
 * pull_request actions are ignored. Handlers return fast: durable state is
 * committed in one transaction, then a best-effort BullMQ enqueue happens;
 * Redis outages are absorbed by the transactional outbox (§12.2).
 */

const TRIGGERS: Record<string, IngestTrigger> = {
  opened: "opened",
  synchronize: "synchronized",
  ready_for_review: "ready_for_review",
};

export function registerPullRequestHandlers(app: Probot): void {
  app.on(["pull_request.opened", "pull_request.synchronize", "pull_request.ready_for_review"], async (context) => {
    const action = context.payload.action;
    const trigger = action ? TRIGGERS[action] : undefined;
    if (!trigger) {
      // Unsupported action: explicitly ignored (§4.1).
      return;
    }

    const pr = context.payload.pull_request;
    const repository = context.payload.repository;
    const installation = context.payload.installation;

    if (!installation) {
      context.log.warn("pull_request event without installation metadata; ignoring");
      return;
    }
    // Bot authors are never reviewed.
    if (pr.user?.type === "Bot") {
      context.log.debug({ pr: pr.number }, "Skipping bot-authored pull request");
      return;
    }

    try {
      const result = await ingestReviewRequest({
        trigger,
        installationId: installation.id,
        repositoryId: repository.id,
        repositoryName: repository.full_name,
        owner: repository.owner?.login ?? repository.full_name.split("/")[0] ?? "unknown",
        defaultBranch: repository.default_branch,
        pullRequestNumber: pr.number,
        headSha: pr.head.sha,
        baseSha: pr.base?.sha ?? null,
        draft: pr.draft ?? false,
        // Probot's context.id is the GitHub delivery id (X-GitHub-Delivery).
        deliveryId: context.id,
      });
      context.log.info(
        { outcome: result.outcome, reviewId: result.reviewId, pr: pr.number, repo: repository.full_name },
        "Pull request review ingestion",
      );
    } catch (error) {
      // Never fail the webhook: the delivery was processed (or will be
      // retried by GitHub); durable errors surface in metrics/alerts.
      context.log.error({ err: error }, "Pull request review ingestion failed");
    }
  });
}
