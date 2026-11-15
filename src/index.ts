import type { Probot } from "probot";
import type { AppServices } from "./bootstrap/clients.js";
import { createWebhookServices } from "./bootstrap/clients.js";
import { loadEnv } from "./config/env.js";
import { registerTriageHandlers } from "./modules/triage/index.js";
import { registerWebhooks } from "./modules/webhooks/index.js";

/**
 * Probot application definition.
 *
 * `createApp` receives the webhook-side services built by a composition root;
 * the default export is the `probot run ./lib/index.js` entry point, which
 * composes its own graph lazily when Probot loads the app.
 */
export function createApp(services: AppServices): (app: Probot) => void {
  return (app: Probot) => {
    // AI triage: comment possible solutions/opinions on new issues. The
    // module owns the `issues.opened` registration and its failure boundary.
    registerTriageHandlers(app, services.triage);

    // Durable review ingestion (ticket 03): persist the review request and
    // enqueue it through the transactional outbox — the webhook handler never
    // runs the review itself.
    registerWebhooks(app, {
      ingestion: services.ingestion,
      repositories: services.ingestionRepositories,
      unitOfWork: services.ingestionUnitOfWork,
    });

    // For more information on building apps:
    // https://probot.github.io/docs/

    // To get your app running against GitHub, see:
    // https://probot.github.io/docs/development/
  };
}

export default (app: Probot) => {
  createApp(createWebhookServices(loadEnv()))(app);
};
