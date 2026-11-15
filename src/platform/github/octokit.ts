/**
 * Concrete GitHub transport adapter (ARCHITECTURE.md §4.4, §6.4, §7.4).
 *
 * The publishing module depends only on the `PublisherOctokit` port; this
 * platform adapter builds the REST client with the retry plugin. Callers at
 * the composition edge inject the factory.
 */

import { Octokit } from "@octokit/core";
import { restEndpointMethods } from "@octokit/plugin-rest-endpoint-methods";
import { retry } from "@octokit/plugin-retry";
import type { PublisherOctokit } from "../../ports/github-publisher.js";

const RestOctokit = Octokit.plugin(restEndpointMethods, retry);

export function createGitHubOctokit(token: string, baseUrl?: string): PublisherOctokit {
  // Octokit's generated REST types widen ids to `number | bigint`; the port
  // narrows them to the numeric ids GitHub returns in practice. This is the
  // adapter boundary where the concrete transport meets the application port.
  return new RestOctokit({
    auth: token,
    ...(baseUrl ? { baseUrl } : {}),
  }) as unknown as PublisherOctokit;
}
