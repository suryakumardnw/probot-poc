/**
 * Pull request controller — handles `pull_request.opened` / `.synchronize`.
 * Extracts data and the diff, delegates to the review service, and posts
 * the rendered review from the view.
 */

import type { Context } from "probot";
import type { PullRequestData } from "../models/review.js";
import { reviewPullRequest } from "../services/review.service.js";
import { renderReviewComment } from "../views/review.view.js";

export async function handlePullRequest(
  context: Context<"pull_request.opened" | "pull_request.synchronize">,
): Promise<void> {
  const { pull_request: pr, repository } = context.payload;

  // Skip bots (including our own app) and drafts to avoid loops/noise.
  if (pr.draft || pr.user?.type === "Bot") {
    return;
  }

  context.log.info(`Reviewing PR #${pr.number} in ${repository.full_name}`);

  const diffResponse = await context.octokit.rest.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: pr.number,
    mediaType: { format: "diff" },
  });

  const prData: PullRequestData = {
    number: pr.number,
    title: pr.title,
    body: pr.body ?? "(none)",
    repoFullName: repository.full_name,
  };

  const review = await reviewPullRequest(prData, String(diffResponse.data));

  await context.octokit.rest.pulls.createReview({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: pr.number,
    event: "COMMENT",
    body: renderReviewComment(review),
  });

  context.log.info(`Posted AI review on PR #${pr.number}`);
}
