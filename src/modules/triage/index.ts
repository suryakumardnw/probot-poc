/**
 * Issue triage module (ARCHITECTURE.md §1.2).
 *
 * New issues authored by humans are triaged by the configured model provider
 * and the rendered analysis is posted back as a comment. Triage is
 * best-effort: a provider or GitHub failure is logged and never fails the
 * webhook, so issue delivery is not retried because of the assistant.
 *
 * Dependencies stay at the module edge: the composition root injects a
 * `ModelProvider`; the module owns the prompt, the request shape and the
 * comment rendering.
 */

import type { Context, Probot } from "probot";
import { createTriageService, type TriageService, type TriageServiceDependencies } from "./triage.service.js";
import { renderTriageComment } from "./triage.view.js";

export {
  buildTriageMessages,
  estimateTokens,
  truncate,
  MAX_BODY_TOKENS,
  TRIAGE_SYSTEM_PROMPT,
  type TriageIssue,
} from "./triage.prompt.js";
export { createTriageService, type TriageService, type TriageServiceDependencies } from "./triage.service.js";
export { renderTriageComment } from "./triage.view.js";

/**
 * Handle one `issues.opened` delivery.
 *
 * Pull requests also fire `issues.opened`; they are ignored. Bot-authored
 * issues (including this app's own comments) are ignored to avoid loops.
 */
export async function handleIssuesOpened(context: Context<"issues.opened">, triage: TriageService): Promise<void> {
  const { issue, repository } = context.payload;

  // Skip PRs (issues webhook fires for PRs too) and bots.
  if (issue.pull_request || issue.user?.type === "Bot") {
    return;
  }

  context.log.info(`Triaging issue #${issue.number} in ${repository.full_name}`);

  const analysis = await triage.triageIssue({
    number: issue.number,
    title: issue.title,
    body: issue.body ?? "(no body)",
  });

  await context.octokit.rest.issues.createComment({
    owner: repository.owner.login,
    repo: repository.name,
    issue_number: issue.number,
    body: renderTriageComment(analysis),
  });

  context.log.info(`Posted AI triage on issue #${issue.number}`);
}

/**
 * Register the `issues.opened` handler.
 *
 * The try/catch is the webhook failure boundary required by §12.4: a missing
 * API key, provider outage or GitHub error is logged as `AI issue triage
 * failed` and the delivery still succeeds.
 */
export function registerTriageHandlers(app: Probot, deps: TriageServiceDependencies): void {
  const triage = createTriageService(deps);

  app.on("issues.opened", async (context) => {
    try {
      await handleIssuesOpened(context, triage);
    } catch (error) {
      context.log.error(error, "AI issue triage failed");
    }
  });
}
