import type { Probot } from "probot";
import { DEFAULT_CONFIG_PATH, loadReviewConfig } from "../config/review-loader.js";
import { ingestReviewRequest, REVIEW_TYPES, type ReviewTypeValue } from "../ingestion/index.js";
import { getPrisma } from "../lib/prisma.js";

/**
 * Manual review trigger (ARCHITECTURE.md §4.1 `issue_comment`).
 *
 * A `/review` comment on a pull request re-triggers a full review of the
 * current head commit — even when a review for that commit already exists
 * (completed, failed, or in flight). Forced re-reviews use trigger `manual`
 * and bypass the review-identity dedupe by incrementing the attempt counter.
 *
 * Review types (§4.1): the command accepts an optional type argument:
 *
 *   /review                → github.defaultReviewType (default: standard)
 *   /review type:skill     → skill
 *   /review type:handbook  → handbook
 *   /review skill          → shorthand for type:skill
 *   /review handbook       → shorthand for type:handbook
 *   /review standard       → shorthand for type:standard
 *
 * Unknown type arguments (or an unknown `type:` value) and DISABLED types
 * post a short best-effort help/acknowledgment comment listing the available
 * types and do NOT ingest. Every accepted acknowledgment mentions the review
 * type so the requester knows which methodology will run.
 *
 * Guards:
 * - only pull requests (the issues webhook fires for plain issues too);
 * - bot comments are ignored;
 * - the command must match `github.manualCommand` (default `/review`) and
 *   `github.events` must include `issue_comment`, with
 *   `review.triggers.manual` and `review.enabled` on;
 * - webhook deliveries are deduped by delivery id (§12.1).
 *
 * The head SHA is resolved from the durable PullRequest row (kept fresh by
 * the opened/synchronize handlers); unknown PRs fall back to the GitHub API,
 * and any API failure only skips the acknowledgment comment — never the
 * ingestion itself.
 */
export function registerIssueCommentHandlers(app: Probot): void {
  app.on("issue_comment.created", async (context) => {
    const { issue, comment, repository } = context.payload;

    // Only pull requests.
    if (!issue.pull_request) {
      return;
    }
    // Closed/merged pull requests are not re-reviewed via comments.
    if (issue.state === "closed") {
      return;
    }
    // Never react to bots (including our own app) to avoid loops.
    if (comment.user?.type === "Bot") {
      return;
    }
    const installation = context.payload.installation;
    if (!installation) {
      context.log.debug({ issue: issue.number }, "issue_comment without installation metadata; ignoring");
      return;
    }

    // Configuration gates: command name, event subscription, manual triggers.
    let config;
    try {
      config = loadReviewConfig(DEFAULT_CONFIG_PATH).config;
    } catch (error) {
      context.log.warn({ err: error }, "Review configuration unavailable; ignoring /review command");
      return;
    }
    const command = config.github.manualCommand;
    const body = (comment.body ?? "").trim();
    const firstLine = body.split("\n")[0]?.trim() ?? "";
    const matchesCommand = firstLine === command || firstLine.startsWith(`${command} `);
    if (
      !matchesCommand ||
      !config.review.enabled ||
      !config.review.triggers.manual ||
      !config.github.events.includes("issue_comment")
    ) {
      return;
    }

    // ---------------------------------------------------------------------
    // Review-type argument parsing (§4.1).
    // ---------------------------------------------------------------------
    const argText = firstLine.slice(command.length).trim();
    const args = argText.split(/\s+/).filter(Boolean);
    let requestedType: string | undefined;
    if (args.length > 0) {
      const first = args[0]!;
      if (first.toLowerCase().startsWith("type:")) {
        requestedType = first.slice("type:".length).trim().toLowerCase() || undefined;
      } else {
        requestedType = first.toLowerCase();
      }
    }

    const typeEnabled = (type: ReviewTypeValue): boolean => {
      const settings = config.review.types[type];
      return settings ? settings.enabled : type === "standard";
    };

    const availableTypes = REVIEW_TYPES.filter(typeEnabled);
    const helpBody = `🤖 I did not run a review: ${requestedType ? `\`${requestedType}\`` : "that"} is not an available review type. Available types: ${
      availableTypes.length > 0 ? availableTypes.map((t) => `\`${t}\``).join(", ") : "(none)"
    }. Usage: \`/review\` (default \`${config.github.defaultReviewType}\`), \`/review type:skill\`, \`/review type:handbook\`.`;

    if (requestedType !== undefined) {
      const valid = (REVIEW_TYPES as readonly string[]).includes(requestedType);
      if (!valid || !typeEnabled(requestedType as ReviewTypeValue)) {
        context.log.info(
          { pr: issue.number, repo: repository.full_name, requestedType },
          "/review with unknown or disabled review type; help posted, not ingested",
        );
        await context.octokit.rest.issues
          .createComment({
            owner: repository.owner.login,
            repo: repository.name,
            issue_number: issue.number,
            body: helpBody,
            request: { timeout: 5000 },
          })
          .catch((error) => {
            context.log.warn({ err: error }, "Failed to post /review help comment");
          });
        return;
      }
    }
    const reviewType: ReviewTypeValue =
      (requestedType as ReviewTypeValue | undefined) ?? config.github.defaultReviewType;

    // Resolve base/head SHAs: durable row first (fresh from open/synchronize),
    // then the GitHub API as a fallback for PRs this app has never seen. The
    // base SHA is required to compute the diff; a `/review` comment payload
    // does not carry it, so it must come from the row or the API.
    const prisma = getPrisma();
    let headSha: string | null = null;
    let baseSha: string | null = null;
    let draft = issue.draft ?? false;
    const storedRepository = await prisma.repository
      .findUnique({ where: { githubRepositoryId: BigInt(repository.id) }, select: { id: true } })
      .catch(() => null);
    const stored = storedRepository
      ? await prisma.pullRequest
          .findUnique({
            where: { repositoryId_githubPrNumber: { repositoryId: storedRepository.id, githubPrNumber: issue.number } },
            select: { headSha: true, baseSha: true, draft: true },
          })
          .catch(() => null)
      : null;
    if (stored?.headSha) {
      headSha = stored.headSha;
      baseSha = stored.baseSha ?? null;
      draft = stored.draft;
    }
    if (!headSha || !baseSha) {
      try {
        const prResponse = await context.octokit.rest.pulls.get({
          owner: repository.owner.login,
          repo: repository.name,
          pull_number: issue.number,
        });
        headSha = prResponse.data.head.sha;
        baseSha = prResponse.data.base.sha;
        draft = prResponse.data.draft ?? false;
      } catch (error) {
        if (!headSha) {
          context.log.error(
            { err: error, pr: issue.number },
            "Could not resolve pull request head SHA; /review ignored",
          );
          return;
        }
        // Head is known; continue without a base SHA rather than dropping the
        // command. The worker falls back to the repository default branch.
        context.log.warn(
          { err: error, pr: issue.number },
          "Could not resolve pull request base SHA; using default branch fallback",
        );
      }
    }
    if (!headSha) {
      return;
    }

    try {
      const result = await ingestReviewRequest({
        trigger: "manual",
        reviewType,
        // A /review comment always re-runs the review, even if this exact
        // commit was already reviewed (§12.3 forced re-review).
        force: true,
        installationId: installation.id,
        repositoryId: repository.id,
        repositoryName: repository.full_name,
        owner: repository.owner?.login ?? repository.full_name.split("/")[0] ?? "unknown",
        defaultBranch: repository.default_branch,
        pullRequestNumber: issue.number,
        headSha,
        baseSha,
        draft,
        deliveryId: context.id,
        deliveryEvent: "issue_comment.created",
      });
      context.log.info(
        {
          outcome: result.outcome,
          reviewId: result.reviewId,
          attempt: result.attempt,
          reviewType,
          pr: issue.number,
          repo: repository.full_name,
        },
        "Manual /review comment ingestion",
      );

      // Best-effort acknowledgment so the requester sees the re-review was
      // accepted. Never fails ingestion. Always names the review type.
      if (result.outcome === "created") {
        await context.octokit.rest.issues
          .createComment({
            owner: repository.owner.login,
            repo: repository.name,
            issue_number: issue.number,
            body: `🤖 Re-review queued for \`${headSha.slice(0, 7)}\` (review \`${result.reviewId}\`, type \`${reviewType}\`). I will report findings shortly.`,
            request: { timeout: 5000 },
          })
          .catch((error) => {
            context.log.warn({ err: error }, "Failed to post /review acknowledgment");
          });
      }
    } catch (error) {
      // Never fail the webhook: durable errors surface in metrics/alerts.
      context.log.error({ err: error }, "Manual /review ingestion failed");
    }
  });
}
