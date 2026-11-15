/**
 * Execution environment allowlist (ticket 11, §10.6).
 *
 * Repository execution must never see application secrets: DATABASE_URL,
 * REDIS_URL, model API keys, GitHub App credentials, webhook secrets, admin
 * OAuth secrets — none of the host application's env may leak into a child
 * process. The child receives ONLY variables on this explicit allowlist,
 * sourced from the app process env where present.
 */

/**
 * Variables the execution environment may receive. Everything else in
 * process.env is dropped — the deny-by-default posture is the security
 * property (an unknown future secret cannot leak by omission).
 */
export const EXECUTION_ENV_ALLOWLIST = Object.freeze([
  "PATH",
  "LANG",
  "LC_ALL",
  "TERM",
  // CI-style markers commonly needed by allowlisted tooling. Values are still
  // taken from the app env only when present and never from config secrets.
  "CI",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
]);

/** Hardened git variables set for every execution (see src/modules/workspace/git.ts). */
const GIT_HARDENING: Record<string, string> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_SSH_COMMAND: "ssh -oBatchMode=yes",
};

/**
 * Build the child environment: deny-by-default allowlist + git hardening.
 * `HOME` is always pointed at a scratch directory so repository commands
 * cannot read host dotfiles (~/.ssh, ~/.gitconfig, ~/.netrc, credentials).
 * `extraEnv` is filtered through the same allowlist.
 */
export function buildExecutionEnv(options: {
  homeDir: string;
  tmpDir: string;
  appEnv?: NodeJS.ProcessEnv;
  extraEnv?: Record<string, string>;
}): Record<string, string> {
  const appEnv = options.appEnv ?? process.env;
  const env: Record<string, string> = {
    PATH: appEnv.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: options.homeDir,
    TMPDIR: options.tmpDir,
    ...GIT_HARDENING,
  };
  for (const key of EXECUTION_ENV_ALLOWLIST) {
    if (key === "PATH") {
      continue;
    }
    const value = appEnv[key];
    if (typeof value === "string" && value.length > 0) {
      env[key] = value;
    }
  }
  for (const [key, value] of Object.entries(options.extraEnv ?? {})) {
    if (EXECUTION_ENV_ALLOWLIST.includes(key) && typeof value === "string") {
      env[key] = value;
    }
  }
  return env;
}

/**
 * Application env var names that must never appear in an execution env —
 * used by tests and by a startup assertion in the service.
 */
export const FORBIDDEN_EXECUTION_ENV_VARS = Object.freeze([
  "DATABASE_URL",
  "REDIS_URL",
  "MODEL_API_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "WEBHOOK_SECRET",
  "PRIVATE_KEY",
  "GITHUB_PRIVATE_KEY",
  "GITHUB_APP_ID",
  "APP_ID",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "ADMIN_OAUTH_CLIENT_SECRET",
  "SESSION_SECRET",
  "GROQ_API_KEY",
]);
