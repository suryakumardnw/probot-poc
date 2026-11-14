import { createAppAuth } from "@octokit/auth-app";

/**
 * Installation-scoped GitHub credential handling (ARCHITECTURE.md §10.6).
 *
 * The GitHub App private key lives in the trusted credential layer (env /
 * deployment secrets). Only short-lived installation access tokens are ever
 * minted, and they are handed exclusively to git transport for a single
 * clone/fetch — never to the agent, never persisted, never logged.
 *
 * This module is the credential seam: tests inject a fake provider, and the
 * agent runtime (ticket 06/07) never receives anything this module returns.
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

export class CredentialUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialUnavailableError";
  }
}

/** Provider that refuses to mint tokens (no App credentials configured). */
export class NullTokenProvider implements InstallationTokenProvider {
  async getInstallationToken(): Promise<InstallationToken> {
    throw new CredentialUnavailableError("No GitHub App credentials configured; cannot mint installation tokens");
  }
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

/**
 * Default provider: mint a short-lived installation token via the GitHub App
 * JWT flow (`@octokit/auth-app`). Tokens are cached in memory until
 * `expiresAt - 60s` and are scoped to one installation. Nothing is persisted
 * and nothing is logged.
 */
export class AppInstallationTokenProvider implements InstallationTokenProvider {
  private auth;
  private cache = new Map<string, CachedToken>();

  constructor(opts: { appId: string; privateKey: string; baseUrl?: string }) {
    this.auth = createAppAuth({
      appId: opts.appId,
      privateKey: opts.privateKey,
      ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    });
  }

  async getInstallationToken(installationId: bigint | number, _repositoryFullName: string): Promise<InstallationToken> {
    const key = installationId.toString();
    const cached = this.cache.get(key);
    if (cached && Date.now() < cached.expiresAtMs) {
      return { token: cached.token, expiresAt: new Date(cached.expiresAtMs).toISOString() };
    }
    const result = await this.auth({ type: "installation", installationId: Number(installationId) });
    const expiresAtMs = result.expiresAt ? Date.parse(result.expiresAt) - 60_000 : 0;
    this.cache.set(key, { token: result.token, expiresAtMs });
    return { token: result.token, expiresAt: result.expiresAt ?? null };
  }

  /** Drop all cached tokens (e.g. on credential rotation). */
  clear(): void {
    this.cache.clear();
  }
}

/**
 * Build the git clone URL for a repository. When a token is present it is
 * embedded for transport only — callers must redact the result with
 * `sanitizeGitUrl`/`redactCredentials` before any logging or persistence.
 */
export function buildCloneUrl(repositoryFullName: string, token: string, githubBaseUrl = "https://github.com"): string {
  const base = githubBaseUrl.replace(/\/$/, "");
  if (!token) return `${base}/${repositoryFullName}.git`;
  return `https://x-access-token:${encodeURIComponent(token)}@${base.replace(/^https?:\/\//, "")}/${repositoryFullName}.git`;
}
