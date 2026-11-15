import type { Probot } from "probot";
import type { AppServices } from "./bootstrap/clients.js";
import { createWebhookServices } from "./bootstrap/clients.js";
import { loadEnv } from "./config/env.js";
import { handleIssuesOpened } from "./controllers/issue.controller.js";
import { registerInstallationHandlers } from "./handlers/installation.js";
import { registerIssueCommentHandlers } from "./handlers/issue-comment.js";
import { registerPullRequestHandlers } from "./handlers/pull-request.js";

/**
 * Probot application definition.
 *
 * `createApp` receives the webhook-side services built by a composition root;
 * the default export is the `probot run ./lib/index.js` entry point, which
 * composes its own graph lazily when Probot loads the app.
 */
export function createApp(services: AppServices): (app: Probot) => void {
  return (app: Probot) => {
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
    registerPullRequestHandlers(app, { ingestion: services.ingestion });
    registerIssueCommentHandlers(app, {
      ingestion: services.ingestion,
      repositories: services.ingestionRepositories,
    });
    registerInstallationHandlers(app, { unitOfWork: services.ingestionUnitOfWork });

    // For more information on building apps:
    // https://probot.github.io/docs/

    // To get your app running against GitHub, see:
    // https://probot.github.io/docs/development/
  };
}

export default (app: Probot) => {
  createApp(createWebhookServices(loadEnv()))(app);
};
