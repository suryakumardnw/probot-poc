import type { Probot } from "probot";
import { handleIssuesOpened } from "./controllers/issue.controller.js";
import { registerInstallationHandlers } from "./handlers/installation.js";
import { registerIssueCommentHandlers } from "./handlers/issue-comment.js";
import { registerPullRequestHandlers } from "./handlers/pull-request.js";

export default (app: Probot) => {
  // AI triage: comment possible solutions/opinions on new issues.
  app.on("issues.opened", async (context) => {
    try {
      await handleIssuesOpened(context);
    } catch (error) {
      context.log.error(error, "AI issue triage failed");
    }
  });

  // Durable review ingestion (ticket 03): persist the review request and
  // enqueue it through the transactional outbox — the webhook handler never
  // runs the review itself.
  registerPullRequestHandlers(app);
  registerIssueCommentHandlers(app);
  registerInstallationHandlers(app);

  // For more information on building apps:
  // https://probot.github.io/docs/

  // To get your app running against GitHub, see:
  // https://probot.github.io/docs/development/
};
