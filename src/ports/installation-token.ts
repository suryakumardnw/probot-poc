/**
 * GitHub App installation-token port (ARCHITECTURE.md §10.6).
 *
 * Only short-lived installation access tokens are ever minted. They are handed
 * exclusively to the git transport or the GitHub API adapter for a single
 * operation — never to the agent, never persisted, never logged.
 *
 * `platform/github/app-auth.ts` owns the vendor SDK and the token cache;
 * modules depend on this port and never import `@octokit/auth-app`.
 */

export interface InstallationToken {
  token: string;
  expiresAt: string | null;
}

export interface InstallationTokenProvider {
  /**
   * Mint a fresh short-lived installation token scoped to `repositoryFullName`.
   * Implementations MUST NOT log the token. An empty token means "public /
   * unauthenticated access" (used by tests against local fixtures).
   */
  getInstallationToken(installationId: bigint | number, repositoryFullName: string): Promise<InstallationToken>;
}
