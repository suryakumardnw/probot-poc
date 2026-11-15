/**
 * Git clone URL construction (ARCHITECTURE.md §10.6).
 *
 * Installation tokens are minted by the `InstallationTokenProvider` port
 * (`platform/github/app-auth.ts`) and travel inside the git remote URL for the
 * duration of one clone/fetch only. Callers must redact the result with
 * `sanitizeGitUrl`/`redactCredentials` before any logging or persistence.
 */

export function buildCloneUrl(repositoryFullName: string, token: string, githubBaseUrl = "https://github.com"): string {
  const base = githubBaseUrl.replace(/\/$/, "");
  if (!token) {
    return `${base}/${repositoryFullName}.git`;
  }
  return `https://x-access-token:${encodeURIComponent(token)}@${base.replace(/^https?:\/\//, "")}/${repositoryFullName}.git`;
}
