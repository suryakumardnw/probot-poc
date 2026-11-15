import { DockerSandboxExecutor } from "./docker-executor.js";
import { createDiskQuotaWatcher } from "./limits.js";
import { LocalSandboxExecutor } from "./local-executor.js";
import { evaluateCommand } from "./policy.js";
import {
  ExecutionPolicyError,
  type CommandRequest,
  type EffectivePolicy,
  type ExecutionResult,
  type ReviewExecutionConfig,
  type SandboxExecutor,
} from "./types.js";

/**
 * Execution service (ticket 11, §10.3): the SINGLE entry point for running a
 * command during a review.
 *
 * Flow: policy evaluation (pure, in the trusted app) → executor (local
 * hardened process or Docker sandbox) → audit record. Every request —
 * allowed, denied, or failed — produces a `command_execution_audits` row.
 * stdout/stderr CONTENT is never persisted, only byte counts.
 *
 * Prisma stays behind `ExecutionAuditRepository`; the composition root
 * supplies the adapter and the process environment.
 */

/** Audit fields as plain data; the repository adapter owns the vendor types. */
export interface ExecutionAuditEntry {
  reviewId?: string;
  actor: string;
  command: string;
  args: string[];
  decision: ExecutionResult["decision"];
  reason: ExecutionResult["reason"];
  mode: EffectivePolicy["mode"];
  sandboxed: boolean;
  networkMode: EffectivePolicy["networkMode"];
  exitCode: number | null;
  timedOut: boolean;
  diskQuotaExceeded: boolean;
  durationMs: number | null;
  stdoutBytes: number;
  stderrBytes: number;
  detail?: string;
}

export interface ExecutionAuditRepository {
  record(entry: ExecutionAuditEntry): Promise<void>;
}

/** Make an argument safe for Postgres jsonb (it cannot store NUL at all) —
 * replace control bytes with visible placeholders for the audit record. */
function escapeControlBytes(arg: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are the subject of this replacement
  return arg.replace(/[\u0000-\u001f\u007f]/g, (c) => `[U+${c.charCodeAt(0).toString(16).padStart(4, "0")}]`);
}

export interface ExecutionServiceOptions {
  audit: ExecutionAuditRepository;
  /** Config value `execution.*` (ticket 02 schema). */
  execution: ReviewExecutionConfig;
  /** Process environment for the executor (injected by the composition root). */
  appEnv: NodeJS.ProcessEnv;
  /** Override the executor (tests); defaults by `sandbox.enabled`. */
  executor?: SandboxExecutor;
  /** Clamp per-request timeouts DOWN to this ceiling. */
  timeoutCeilingMs?: number;
}

export class ExecutionService {
  private readonly auditRepository: ExecutionAuditRepository;
  private readonly execution: ReviewExecutionConfig;
  private readonly executor: SandboxExecutor;
  private readonly timeoutCeilingMs?: number;

  constructor(options: ExecutionServiceOptions) {
    this.auditRepository = options.audit;
    this.execution = options.execution;
    this.timeoutCeilingMs = options.timeoutCeilingMs;
    this.executor =
      options.executor ??
      (options.execution.sandbox.enabled
        ? new DockerSandboxExecutor({
            appEnv: options.appEnv,
            ...(options.appEnv.SANDBOX_DOCKER_HOST ? { dockerHost: options.appEnv.SANDBOX_DOCKER_HOST } : {}),
            ...(options.appEnv.SANDBOX_DOCKER_NETWORK ? { networkName: options.appEnv.SANDBOX_DOCKER_NETWORK } : {}),
          })
        : new LocalSandboxExecutor({ appEnv: options.appEnv }));
  }

  /** The configured executor (for lifecycle management by callers). */
  get sandboxExecutor(): SandboxExecutor {
    return this.executor;
  }

  /**
   * Validate, execute, and audit a command request. Never throws for policy
   * rejections — those are returned as denied results and audited. Throws
   * ExecutionPolicyError only for structurally invalid requests (also audited
   * as denied).
   */
  async runCommand(request: CommandRequest): Promise<ExecutionResult> {
    const { decision, policy } = this.evaluate(request);
    if (!decision.allowed) {
      const result = this.deniedResult(request, decision.reason, decision.detail, policy);
      await this.audit(request, result, policy, decision.detail);
      return result;
    }

    let result: ExecutionResult;
    if (this.executor.sandboxed) {
      result = await this.executeWithHostDiskQuota(request, policy);
    } else {
      result = await this.executor.execute(request, policy);
    }
    await this.audit(request, result, policy, decision.detail);
    return result;
  }

  private evaluate(request: CommandRequest) {
    try {
      return evaluateCommand(this.execution, request, { timeoutCeilingMs: this.timeoutCeilingMs });
    } catch (error) {
      if (error instanceof ExecutionPolicyError) {
        return {
          decision: { allowed: false, reason: error.reason, detail: error.detail },
          policy: this.emptyPolicy(),
        };
      }
      throw error;
    }
  }

  /**
   * Docker path: in-container writes are capped by the read-only rootfs and
   * tmpfs size; the workspace bind-mount (rw in sandbox mode) is watched
   * host-side so a container filling the host disk is detected and the
   * result is marked `disk_quota_exceeded` (§10.4).
   */
  private async executeWithHostDiskQuota(request: CommandRequest, policy: EffectivePolicy): Promise<ExecutionResult> {
    const watcher = createDiskQuotaWatcher([request.workspacePath], policy.diskQuotaBytes, 500);
    try {
      const result = await this.executor.execute(request, policy);
      if (result.diskQuotaExceeded) {
        return result;
      }
      const { exceeded } = await watcher.exceeded();
      if (!exceeded) {
        return result;
      }
      return {
        ...result,
        decision: "error",
        reason: "disk_quota_exceeded",
        diskQuotaExceeded: true,
        detail: `Host disk usage of the workspace exceeded execution.resources.diskLimit (${policy.diskQuotaBytes} bytes)`,
      };
    } finally {
      watcher.stop();
    }
  }

  private deniedResult(
    request: CommandRequest,
    reason: ExecutionResult["reason"],
    detail: string | undefined,
    policy: EffectivePolicy,
  ): ExecutionResult {
    void policy;
    return {
      decision: "denied",
      reason,
      command: request.command,
      args: [...request.args],
      exitCode: null,
      timedOut: false,
      diskQuotaExceeded: false,
      durationMs: null,
      stdout: "",
      stderr: "",
      sandboxed: this.executor.sandboxed,
      terminated: true,
      ...(detail ? { detail } : {}),
    };
  }

  /** Persist the audit row. Content of stdout/stderr is NEVER stored. */
  private async audit(
    request: CommandRequest,
    result: ExecutionResult,
    policy: EffectivePolicy,
    detail?: string,
  ): Promise<void> {
    try {
      await this.auditRepository.record({
        reviewId: request.reviewId,
        actor: request.actor,
        command: result.command,
        // Control bytes (e.g. rejected NUL injections) cannot be stored in
        // Postgres JSON — escape them for the audit record only.
        args: result.args.map(escapeControlBytes),
        decision: result.decision,
        reason: result.reason,
        mode: policy.mode,
        sandboxed: result.sandboxed,
        networkMode: policy.networkMode,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        diskQuotaExceeded: result.diskQuotaExceeded,
        durationMs: result.durationMs,
        stdoutBytes: Buffer.byteLength(result.stdout, "utf8"),
        stderrBytes: Buffer.byteLength(result.stderr, "utf8"),
        ...(result.detail || detail ? { detail: escapeControlBytes(result.detail ?? detail ?? "") } : {}),
      });
    } catch (error) {
      // Audit failure must not silently drop the trail — rethrow after the
      // execution result is known so callers can surface it.
      throw new Error(`Command execution audit write failed: ${(error as Error).message}`);
    }
  }

  private emptyPolicy(): EffectivePolicy {
    return {
      mode: this.execution.mode,
      networkMode: this.execution.sandbox.networkMode,
      timeoutMs: this.execution.resources.executionTimeoutMs,
      memoryBytes: null,
      cpuLimit: null,
      diskQuotaBytes: 0,
      runAsNonRoot: this.execution.sandbox.runAsNonRoot,
      workspaceReadOnly: this.execution.mode !== "sandbox",
      extraEnv: {},
    };
  }
}
