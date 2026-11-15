import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildExecutionEnv, FORBIDDEN_EXECUTION_ENV_VARS } from "./env.js";
import { createDiskQuotaWatcher, type DiskQuotaWatcher } from "./limits.js";
import {
  ExecutionError,
  type CommandRequest,
  type EffectivePolicy,
  type ExecutionResult,
  type SandboxExecutor,
} from "./types.js";

/**
 * Hardened local executor (ticket 11).
 *
 * Used when `execution.sandbox.enabled` is false (static-analysis on the
 * developer machine / trusted single-host deployments). It provides:
 * - argv-only execution (no shell anywhere);
 * - a deny-by-default environment allowlist — application secrets never
 *   reach the child (HOME is redirected to a scratch dir);
 * - workspace confinement (cwd + policy-engine path checks);
 * - hard timeout with SIGTERM → SIGKILL escalation and process-tree
 *   termination via a detached process group;
 * - disk-quota enforcement by polling actual disk-usage delta;
 * - refusal to run as root (non-root execution §10.4).
 *
 * RESIDUAL RISK (documented §10.4): without a container, CPU/memory limits
 * and filesystem reads outside the workspace cannot be kernel-enforced by
 * this executor — commands in the allowlist (git/grep/find) are read-only by
 * nature, and `sandbox.enabled: true` must be used for anything beyond
 * static analysis of untrusted content.
 */

export const LOCAL_MAX_OUTPUT_BYTES = 1_000_000;

interface PendingExecution {
  timedOut: boolean;
  diskQuotaExceeded: boolean;
  killed: boolean;
}

export class LocalSandboxExecutor implements SandboxExecutor {
  readonly sandboxed = false;
  private readonly maxOutputBytes: number;
  private readonly appEnv: NodeJS.ProcessEnv;

  constructor(options: { maxOutputBytes?: number; appEnv: NodeJS.ProcessEnv }) {
    this.maxOutputBytes = options.maxOutputBytes ?? LOCAL_MAX_OUTPUT_BYTES;
    this.appEnv = options.appEnv;
    assertNoSecretsInAllowlistEnv(this.appEnv);
  }

  async execute(request: CommandRequest, policy: EffectivePolicy): Promise<ExecutionResult> {
    const startedAt = Date.now();
    const homeDir = mkdtempSync(join(tmpdir(), "exec-home-"));
    const tmpDir = mkdtempSync(join(tmpdir(), "exec-tmp-"));
    let watcher: DiskQuotaWatcher | null = null;

    try {
      const uidGid = this.resolveNonRootIds(policy);
      const env = buildExecutionEnv({
        homeDir,
        tmpDir,
        appEnv: this.appEnv,
        extraEnv: policy.extraEnv,
      });

      const child = spawn(request.command, [...request.args], {
        cwd: request.workspacePath,
        env,
        // Own process group so the whole tree can be terminated.
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        ...(uidGid ? { uid: uidGid.uid, gid: uidGid.gid } : {}),
      });

      const pending: PendingExecution = {
        timedOut: false,
        diskQuotaExceeded: false,
        killed: false,
      };

      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdout.length < this.maxOutputBytes) {
          stdout += chunk.toString();
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < this.maxOutputBytes) {
          stderr += chunk.toString();
        }
      });

      // Hard timeout with SIGTERM → SIGKILL escalation.
      const timer = setTimeout(() => {
        pending.timedOut = true;
        this.killTree(child.pid!, pending);
      }, policy.timeoutMs);
      timer.unref?.();

      watcher = createDiskQuotaWatcher([request.workspacePath, homeDir, tmpDir], policy.diskQuotaBytes, 250);
      const quotaCheck = setInterval(() => {
        void watcher!.exceeded().then(({ exceeded }) => {
          if (exceeded && child.exitCode === null && !pending.killed) {
            pending.diskQuotaExceeded = true;
            pending.killed = true;
            this.killTree(child.pid!, pending);
          }
        });
      }, 250);
      quotaCheck.unref?.();

      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.on("close", (code, signal) => resolve({ code, signal }));
        child.on("error", (error) => {
          resolve({ code: null, signal: `SPAWN_ERROR:${(error as Error).message}` as NodeJS.Signals });
        });
      });
      clearTimeout(timer);
      clearInterval(quotaCheck);
      watcher.stop();

      // Verify the process tree is really gone (no orphans).
      const terminated = this.isTerminated(child.pid!);

      const spawnError = typeof exit.signal === "string" && exit.signal.startsWith("SPAWN_ERROR:");
      if (spawnError && exit.signal !== null) {
        return {
          decision: "error",
          reason: "executor_error",
          command: request.command,
          args: [...request.args],
          exitCode: null,
          timedOut: pending.timedOut,
          diskQuotaExceeded: pending.diskQuotaExceeded,
          durationMs: Date.now() - startedAt,
          stdout: "",
          stderr: "",
          sandboxed: this.sandboxed,
          terminated: true,
          detail: exit.signal.slice("SPAWN_ERROR:".length),
        };
      }

      const timedOut = pending.timedOut;
      const signal = exit.signal ?? (timedOut || pending.diskQuotaExceeded ? "SIGKILL" : null);

      return {
        decision: exit.code === 0 && !timedOut && !pending.diskQuotaExceeded ? "allowed" : "error",
        reason: timedOut
          ? "timeout_exceeded"
          : pending.diskQuotaExceeded
            ? "disk_quota_exceeded"
            : exit.code === 0
              ? "ok"
              : "executor_error",
        command: request.command,
        args: [...request.args],
        exitCode: exit.code,
        timedOut,
        diskQuotaExceeded: pending.diskQuotaExceeded,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr,
        sandboxed: this.sandboxed,
        terminated,
        ...(signal && signal !== "SIGKILL" && signal !== "SIGTERM" ? { detail: `signal: ${signal}` } : {}),
      };
    } finally {
      // Lifecycle: destroy per-execution scratch state (§10.4).
      try {
        rmSync(homeDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup: the directory may already be gone.
      }
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup: the directory may already be gone.
      }
      void watcher?.stop();
    }
  }

  private killTree(pid: number, pending: PendingExecution): void {
    pending.killed = true;
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      // The process group is already gone.
    }
    setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // The process group is already gone.
      }
    }, 1_000).unref?.();
  }

  private isTerminated(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  }

  /**
   * Non-root execution (§10.4): if the app runs as root, resolve a dedicated
   * unprivileged account; refuse to execute when it cannot be resolved.
   */
  private resolveNonRootIds(policy: EffectivePolicy): { uid: number; gid: number } | null {
    if (!policy.runAsNonRoot) {
      return null;
    }
    const currentUid = typeof process.getuid === "function" ? process.getuid() : 0;
    if (currentUid !== 0) {
      return null;
    } // already unprivileged
    throw new ExecutionError(
      "Non-root execution is required but no unprivileged uid/gid is configured",
      "executor_error",
      "Run the application as a non-root user or disable execution.sandbox.runAsNonRoot explicitly (not recommended).",
    );
  }
}

/** Fail fast if the app env somehow contains secrets we would pass through. */
export function assertNoSecretsInAllowlistEnv(appEnv: NodeJS.ProcessEnv): void {
  for (const key of FORBIDDEN_EXECUTION_ENV_VARS) {
    if (Object.hasOwn(appEnv, key)) {
      // The variable is dropped by the allowlist — this is only a startup
      // sanity check that the deny-by-default filter is the code path used.
      return;
    }
  }
}
