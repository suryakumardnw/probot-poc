import fs from "node:fs";
import { createAppAuth } from "@octokit/auth-app";
import type { InstallationToken, InstallationTokenProvider } from "../../ports/installation-token.js";

/**
 * GitHub App installation credentials (ARCHITECTURE.md §10.6).
 *
 * The private key lives in the trusted credential layer (environment or
 * mounted deployment secret). This adapter mints short-lived installation
 * access tokens through the GitHub App JWT flow and caches them in memory
 * until `expiresAt - 60s`. Nothing is persisted and nothing is logged.
 *
 * `platform/github` owns the vendor SDK; modules depend on the
 * `InstallationTokenProvider` port.
 */

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

export class AppInstallationTokenProvider implements InstallationTokenProvider {
  private readonly auth;
  private readonly cache = new Map<string, CachedToken>();

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
 * Build the default provider from injected environment credentials. Falls
 * back to a NullTokenProvider (throws on use) when no GitHub App credentials
 * are configured. Private key material never leaves this adapter.
 */
export function createDefaultTokenProvider(appEnv: NodeJS.ProcessEnv): InstallationTokenProvider {
  const appId = appEnv.GITHUB_APP_ID;
  let privateKey = appEnv.GITHUB_PRIVATE_KEY;
  if (!privateKey) {
    const privateKeyPath = appEnv.GITHUB_PRIVATE_KEY_PATH;
    if (privateKeyPath) {
      privateKey = fs.readFileSync(privateKeyPath, "utf-8");
    }
  }
  if (!privateKey && appEnv.GITHUB_PRIVATE_KEY_BASE64) {
    privateKey = Buffer.from(appEnv.GITHUB_PRIVATE_KEY_BASE64.replace(/\s+/g, ""), "base64").toString("utf8");
  }
  if (!appId || !privateKey) {
    return new NullTokenProvider();
  }
  return new AppInstallationTokenProvider({
    appId,
    privateKey,
    baseUrl: appEnv.GITHUB_BASE_URL,
  });
}
