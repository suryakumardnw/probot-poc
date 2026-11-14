/**
 * Issue controller — handles the `issues.opened` webhook.
 * Extracts data, delegates to the triage service, and posts the
 * rendered comment from the view.
 */

import type { Context } from "probot";
import type { IssueData } from "../models/triage.js";
import { triageIssue } from "../services/triage.service.js";
import { renderTriageComment } from "../views/triage.view.js";

export async function handleIssuesOpened(context: Context<"issues.opened">): Promise<void> {
  const { issue, repository } = context.payload;

  // Skip PRs (issues webhook fires for PRs too) and bots.
  if (issue.pull_request || issue.user?.type === "Bot") {
    return;
  }

  context.log.info(`Triaging issue #${issue.number} in ${repository.full_name}`);

  const issueData: IssueData = {
    number: issue.number,
    title: issue.title,
    body: issue.body ?? "(no body)",
  };

  const analysis = await triageIssue(issueData);

  await context.octokit.rest.issues.createComment({
    owner: repository.owner.login,
    repo: repository.name,
    issue_number: issue.number,
    body: renderTriageComment(analysis),
  });

  context.log.info(`Posted AI triage on issue #${issue.number}`);
}
