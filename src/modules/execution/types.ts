/**
 * Secure execution and resource isolation (ARCHITECTURE.md §10, ticket 11).
 *
 * The trust boundary: repository content is UNTRUSTED (§10.1). Every command
 * request is validated by the command policy engine in the trusted
 * application, never by the agent that requested it, and then executed in an
 * isolated execution environment with resource limits, a minimal environment
 * (no application secrets) and a network policy.
 */

/** Mode from config `execution.mode` (§10.2). */
export type ExecutionMode = "read-only" | "static-analysis" | "sandbox";

/** Network policy mode from config `execution.sandbox.networkMode` (§10.5). */
export type NetworkMode = "none" | "allowlist" | "open";

/** How a command request was decided (audit record `decision`). */
export type ExecutionDecision = "allowed" | "denied" | "error";

/** Machine-readable rejection/observation reason codes. */
export type ExecutionReason =
  | "mode_read_only"
  | "not_allowlisted"
  | "tests_disabled"
  | "builds_disabled"
  | "package_scripts_disabled"
  | "invalid_arg"
  | "path_escape"
  | "workspace_required"
  | "timeout_exceeded"
  | "disk_quota_exceeded"
  | "executor_error"
  | "network_not_enforced"
  | "ok";

/** A command requested for execution inside the review workspace. */
export interface CommandRequest {
  /** Bare executable name (e.g. "git"). Never a path, never a shell string. */
  command: string;
  /** Structured argument array. NEVER shell-interpolated (§10.3). */
  args: readonly string[];
  /** Workspace root the command runs in (absolute path). */
  workspacePath: string;
  /** Who asked (e.g. "agent:opencode", "review-engine", "admin"). */
  actor: string;
  /** Owning review id, when the request is part of a review job. */
  reviewId?: string;
  /** Optional caller-visible purpose (audited, never interpreted). */
  purpose?: string;
}

/** Outcome of a validated + executed (or rejected) command request. */
export interface ExecutionResult {
  decision: ExecutionDecision;
  reason: ExecutionReason;
  command: string;
  args: string[];
  exitCode: number | null;
  timedOut: boolean;
  diskQuotaExceeded: boolean;
  durationMs: number | null;
  stdout: string;
  stderr: string;
  /** Whether the command ran inside the container sandbox. */
  sandboxed: boolean;
  /** Whether the process was confirmed terminated (no orphans). */
  terminated: boolean;
  /** Details for denials/errors; never contains output content. */
  detail?: string;
}

/** A validated policy decision (returned before any process is spawned). */
export interface PolicyDecision {
  allowed: boolean;
  reason: ExecutionReason;
  detail?: string;
}

/** Sandbox executor interface — local hardened process or Docker container. */
export interface SandboxExecutor {
  readonly sandboxed: boolean;
  execute(request: CommandRequest, policy: EffectivePolicy): Promise<ExecutionResult>;
  /** Release any persistent resources (lifecycle §10.4). */
  destroy?(): Promise<void>;
}

/** Policy values resolved for one execution (after validation). */
export interface EffectivePolicy {
  mode: ExecutionMode;
  networkMode: NetworkMode;
  timeoutMs: number;
  memoryBytes: number | null;
  cpuLimit: string | null;
  diskQuotaBytes: number;
  runAsNonRoot: boolean;
  /** Workspace is mounted read-only (static-analysis / read-only). */
  workspaceReadOnly: boolean;
  /** Environment the child process may receive (allowlist-filtered). */
  extraEnv: Record<string, string>;
}

/** The `execution` section of the review configuration (ticket 02 schema). */
export interface ReviewExecutionConfig {
  mode: ExecutionMode;
  commands: {
    allowlist: string[];
    allowTests: boolean;
    allowBuilds: boolean;
    allowPackageScripts: boolean;
  };
  sandbox: {
    enabled: boolean;
    networkMode: NetworkMode;
    allowedDomains: string[];
    runAsNonRoot: boolean;
  };
  resources: {
    cpuLimit: string;
    memoryLimit: string;
    diskLimit: string;
    executionTimeoutMs: number;
  };
}

export class ExecutionPolicyError extends Error {
  constructor(
    message: string,
    public readonly reason: ExecutionReason,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = "ExecutionPolicyError";
  }
}

export class ExecutionError extends Error {
  constructor(
    message: string,
    public readonly reason: ExecutionReason = "executor_error",
    public readonly detail?: string,
  ) {
    super(message);
    this.name = "ExecutionError";
  }
}
