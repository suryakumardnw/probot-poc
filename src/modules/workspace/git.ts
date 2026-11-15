import { execFile } from "node:child_process";
import { redactCredentials } from "./redact.js";

/**
 * Safe git command execution (ARCHITECTURE.md §10.3).
 *
 * Every git invocation uses `execFile`-style structured argument arrays —
 * never a shell string, never string interpolation of user-controlled input
 * into a command line. The child process runs with terminal prompts and
 * credential helpers disabled so git cannot hang waiting for input or leak
 * credentials into a helper's storage.
 */

export const GIT_TIMEOUT_MS = 300_000;
export const GIT_MAX_BUFFER = 32 * 1024 * 1024;

export class GitCommandError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number | null,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "GitCommandError";
  }
}

export interface RunGitOptions {
  cwd?: string;
  timeoutMs?: number;
  maxBuffer?: number;
  /** Secret to redact from any stderr/stdout before it escapes. */
  secret?: string;
  /** Extra environment for the child process. */
  env?: Record<string, string>;
  /** Process environment supplying PATH/HOME (injected by the caller). */
  appEnv: NodeJS.ProcessEnv;
}

/**
 * Run `git <args...>` and return stdout as a string. Throws GitCommandError
 * (with credentials redacted) on non-zero exit.
 */
export function runGit(args: readonly string[], options: RunGitOptions): Promise<string> {
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const childEnv: Record<string, string> = {
    // Prevent git from prompting for credentials or touching system config.
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    // Never resolve credentials via helpers/keys for clone/fetch operations.
    GIT_SSH_COMMAND: "ssh -oBatchMode=yes",
    ...options.env,
  };
  for (const key of Object.keys(childEnv)) {
    if (childEnv[key] === undefined) {
      delete childEnv[key];
    }
  }

  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...args],
      {
        cwd: options.cwd,
        timeout: timeoutMs,
        maxBuffer: options.maxBuffer ?? GIT_MAX_BUFFER,
        // Inherit minimal env plus our hardening variables.
        env: { PATH: options.appEnv.PATH ?? "/usr/bin:/bin", HOME: options.appEnv.HOME, ...childEnv },
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const sanitizedStderr = redactCredentials(stderr?.toString() ?? "", options.secret);
          reject(
            new GitCommandError(
              redactCredentials(`git ${args[0]} failed: ${sanitizedStderr || error.message}`, options.secret),
              typeof (error as NodeJS.ErrnoException & { code?: number }).code === "number"
                ? (error as unknown as { code: number }).code
                : null,
              sanitizedStderr,
            ),
          );
          return;
        }
        resolve(stdout.toString());
      },
    );
  });
}
