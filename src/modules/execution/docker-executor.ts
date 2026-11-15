import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildExecutionEnv } from "./env.js";
import { resolveQuantity } from "./limits.js";
import {
  ExecutionError,
  type CommandRequest,
  type EffectivePolicy,
  type ExecutionResult,
  type SandboxExecutor,
} from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Docker sandbox executor (ticket 11, §10.4).
 *
 * Spawns ONE throwaway container per command (`--rm` — destroyed after the
 * execution; lifecycle §10.4) with:
 * - non-root user (`sandbox`, §10.4);
 * - memory / CPU / PIDs limits and no swap;
 * - read-only rootfs, tmpfs /tmp capped at the disk limit;
 * - the review workspace bind-mounted read-only for static analysis (or
 *   read-write only in sandbox mode);
 * - network: `--network none` for networkMode none/allowlist (see below);
 * - ALL capabilities dropped, no-new-privileges;
 * - NO Docker socket is ever mounted (§18.3) — the app talks to Docker via
 *   the CLI with an optional dedicated SANDBOX_DOCKER_HOST (e.g. a separate
 *   sandbox runner host reachable only over the internal network).
 *
 * Network enforcement mechanism (§10.5):
 * - networkMode "none"      → `--network none` (no egress possible).
 * - networkMode "allowlist" → `--network none` by default; if
 *   SANDBOX_DOCKER_NETWORK names a dedicated user-defined network, the
 *   container attaches to it instead — ticket 13 may run an egress-proxy
 *   sidecar on that network to enforce the domain allowlist. When no network
 *   is configured the allowlist degrades to "none" (fail-closed) and the
 *   execution is audited with reason "network_not_enforced".
 * - networkMode "open"      → default bridge; audited (high risk).
 */

export const DEFAULT_SANDBOX_IMAGE = "ai-pr-reviewer-sandbox:latest";
export const SANDBOX_USER = "sandbox";

export interface DockerExecutorOptions {
  image?: string;
  /** Optional dedicated Docker endpoint for the sandbox runner (never a socket mount). */
  dockerHost?: string;
  /** Optional pre-created user-defined network for allowlist egress. */
  networkName?: string;
  /** Docker CLI binary. */
  dockerBin?: string;
  appEnv?: NodeJS.ProcessEnv;
}

export class DockerSandboxExecutor implements SandboxExecutor {
  readonly sandboxed = true;
  private readonly image: string;
  private readonly dockerHost?: string;
  private readonly networkName?: string;
  private readonly dockerBin: string;
  private readonly appEnv: NodeJS.ProcessEnv;

  constructor(options: DockerExecutorOptions = {}) {
    this.image = options.image ?? DEFAULT_SANDBOX_IMAGE;
    this.dockerHost = options.dockerHost ?? process.env.SANDBOX_DOCKER_HOST;
    this.networkName = options.networkName ?? process.env.SANDBOX_DOCKER_NETWORK;
    this.dockerBin = options.dockerBin ?? "docker";
    this.appEnv = options.appEnv ?? process.env;
  }

  /** Ensure the sandbox image exists locally (build it once if missing). */
  async ensureImage(): Promise<void> {
    try {
      await this.docker("image", "inspect", this.image);
      return;
    } catch {
      const contextDir = join(process.cwd(), "docker", "sandbox");
      await this.docker("build", "-q", "-f", join(contextDir, "Dockerfile.sandbox"), "-t", this.image, contextDir);
    }
  }

  private dockerArgs(...args: readonly string[]): string[] {
    return this.dockerHost ? ["-H", this.dockerHost, ...args] : [...args];
  }

  private docker(...args: readonly string[]): Promise<string> {
    return execFileAsync(this.dockerBin, this.dockerArgs(...args), { timeout: 120_000 }).then((r) => r.stdout);
  }

  async execute(request: CommandRequest, policy: EffectivePolicy): Promise<ExecutionResult> {
    const startedAt = Date.now();
    const containerName = `review-sandbox-${randomUUID()}`;
    const homeDir = mkdtempSync(join(tmpdir(), "exec-home-"));
    try {
      const memoryBytes = policy.memoryBytes ?? 0;
      const tmpfsSize = resolveQuantity(policy.workspaceReadOnly ? "64Mi" : "512Mi");
      const mountMode = policy.workspaceReadOnly ? "ro" : "rw";

      // Network policy (see module docblock): fail-closed.
      const networkArgs: string[] = [];
      let auditedNetworkNote: string | undefined;
      if (policy.networkMode === "open") {
        // default bridge
      } else if (policy.networkMode === "allowlist" && this.networkName) {
        networkArgs.push("--network", this.networkName);
      } else {
        networkArgs.push("--network", "none");
        if (policy.networkMode === "allowlist") {
          auditedNetworkNote = "network_not_enforced: no egress network configured; failed closed to --network none";
        }
      }

      const env = buildExecutionEnv({ homeDir, tmpDir: "/tmp", appEnv: this.appEnv, extraEnv: policy.extraEnv });
      const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);

      const runArgs = [
        "run",
        "--rm",
        "--name",
        containerName,
        "--user",
        SANDBOX_USER,
        "--workdir",
        "/work",
        "--read-only",
        "--tmpfs",
        `/tmp:rw,noexec,nosuid,size=${tmpfsSize ?? 64 * 1024 * 1024}`,
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "128",
        "--memory",
        String(Math.max(memoryBytes, 64 * 1024 * 1024)),
        "--memory-swap",
        String(Math.max(memoryBytes, 64 * 1024 * 1024)),
        "--cpus",
        policy.cpuLimit ?? "1",
        "--volume",
        `${request.workspacePath}:/work:${mountMode}`,
        ...envArgs,
        ...networkArgs,
        this.image,
        request.command,
        ...request.args,
      ];

      const child = spawn(this.dockerBin, this.dockerArgs(...runArgs), {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (c: Buffer) => {
        if (stdout.length < 1_000_000) {
          stdout += c.toString();
        }
      });
      child.stderr?.on("data", (c: Buffer) => {
        if (stderr.length < 1_000_000) {
          stderr += c.toString();
        }
      });

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        // Kill the container; --rm removes it afterwards.
        void execFileAsync(this.dockerBin, this.dockerArgs("kill", containerName), { timeout: 15_000 }).catch(() => {});
      }, policy.timeoutMs);
      timer.unref?.();

      const exit = await new Promise<{ code: number | null; error?: Error }>((resolve) => {
        child.on("close", (code) => resolve({ code }));
        child.on("error", (error) => resolve({ code: null, error }));
      });
      clearTimeout(timer);

      if (exit.error) {
        throw new ExecutionError(`Failed to start sandbox container: ${exit.error.message}`, "executor_error");
      }

      // Container destroyed after execution (--rm): confirm gone; force-remove
      // any straggler so nothing outlives the execution (lifecycle §10.4).
      let terminated = true;
      try {
        await this.docker("inspect", containerName);
        // Still present — remove it now.
        terminated = false;
        await execFileAsync(this.dockerBin, this.dockerArgs("rm", "-f", containerName), {
          timeout: 15_000,
        }).catch(() => {});
      } catch {
        // inspect failed ⇒ container is gone (expected with --rm).
      }

      const ok = exit.code === 0 && !timedOut;
      return {
        decision: ok ? "allowed" : "error",
        reason: timedOut ? "timeout_exceeded" : ok ? "ok" : "executor_error",
        command: request.command,
        args: [...request.args],
        exitCode: exit.code,
        timedOut,
        diskQuotaExceeded: false, // enforced by tmpfs size + host watcher in the service
        durationMs: Date.now() - startedAt,
        stdout,
        stderr,
        sandboxed: this.sandboxed,
        terminated,
        ...(auditedNetworkNote ? { detail: auditedNetworkNote } : {}),
      };
    } finally {
      try {
        rmSync(homeDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup: the sandbox may have removed the directory.
      }
    }
  }
}
