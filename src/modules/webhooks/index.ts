/**
 * GitHub webhook adapters (ARCHITECTURE.md §4, §13.1).
 *
 * Handlers stay fast: they validate the event, map it onto the ingestion
 * module's durable intake, and never run a review inline. Durable work is
 * committed by ingestion and executed by the worker.
 */

import type { Probot } from "probot";
import type { ReviewConfigStore } from "../../ports/review-config.js";
import type { IngestionServices } from "../ingestion/index.js";
import { registerInstallationHandlers } from "./installation.js";
import { registerIssueCommentHandlers } from "./issue-comment.js";
import { registerPullRequestHandlers } from "./pull-request.js";

export { registerInstallationHandlers, type InstallationHandlerDeps } from "./installation.js";
export { registerIssueCommentHandlers, type IssueCommentHandlerDeps } from "./issue-comment.js";
export { registerPullRequestHandlers, type PullRequestHandlerDeps } from "./pull-request.js";

export interface WebhookDependencies {
  /** The public ingestion services this adapter needs, and nothing more. */
  ingestion: Pick<
    IngestionServices,
    "ingestReviewRequest" | "findReviewTarget" | "registerInstallation" | "markInstallationDeleted"
  >;
  config: ReviewConfigStore;
}

/**
 * Register every GitHub webhook the app consumes for durable review intake.
 *
 * Registration order is unchanged from the pre-module entry point:
 * pull requests, manual `/review` comments, then installation lifecycle.
 */
export function registerWebhooks(app: Probot, deps: WebhookDependencies): void {
  registerPullRequestHandlers(app, { ingestion: deps.ingestion });
  registerIssueCommentHandlers(app, {
    ingestion: deps.ingestion,
    config: deps.config,
  });
  registerInstallationHandlers(app, { installations: deps.ingestion });
}
