import { resolveQuantity } from "./limits.js";
import {
  ExecutionPolicyError,
  type CommandRequest,
  type EffectivePolicy,
  type ExecutionReason,
  type PolicyDecision,
  type ReviewExecutionConfig,
} from "./types.js";

/**
 * Command policy engine (ARCHITECTURE.md §10.3).
 *
 * PURE validation — no process is spawned, no agent is consulted. The agent
 * may REQUEST a command; this engine decides. Every caller (tool protocol,
 * admin tooling, tests) must route through this module; the agent runtime is
 * never the authority for its own permissions.
 *
 * Injection posture: commands run via execFile-style structured argument
 * arrays — there is no shell, so no metacharacter can ever be interpreted.
 * As defense-in-depth the engine additionally rejects control characters and
 * NUL bytes in arguments, and confines path-like arguments to the workspace.
 */

// eslint-disable-next-line no-control-regex -- control characters are the subject of this check
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Commands that always constitute test execution (deny unless allowed). */
const TEST_COMMANDS = new Set([
  "jest",
  "vitest",
  "mocha",
  "pytest",
  "py.test",
  "rspec",
  "karma",
  "tox",
  "phpunit",
  "gradle",
]);

/** Commands that always constitute build/package execution. */
const BUILD_COMMANDS = new Set([
  "make",
  "cmake",
  "ninja",
  "gcc",
  "g++",
  "clang",
  "tsc",
  "webpack",
  "rollup",
  "esbuild",
  "vite",
  "gradlew",
  "mvn",
  "cargo",
  "go",
]);

/** Package managers that can run arbitrary lifecycle scripts. */
const PACKAGE_MANAGERS = new Set(["npm", "npx", "pnpm", "yarn", "bun", "bunx"]);

/** Lifecycle script arguments of package managers that count as tests/builds. */
const TEST_SCRIPTS = new Set(["test", "t", "tst"]);
const BUILD_SCRIPTS = new Set(["build", "compile", "dist"]);

/** Lifecycle scripts that can execute arbitrary repository code. */
const ARBITRARY_SCRIPTS = new Set([
  "preinstall",
  "install",
  "postinstall",
  "prepack",
  "postpack",
  "prepare",
  "prepublish",
  "prepublishOnly",
  "start",
  "run",
  "exec",
  "x",
]);

function classificationFor(command: string, args: readonly string[]): "test" | "build" | "package" | "other" {
  const base = command.split("/").pop()!.toLowerCase();
  if (TEST_COMMANDS.has(base)) return "test";
  if (BUILD_COMMANDS.has(base)) return "build";
  if (PACKAGE_MANAGERS.has(base)) {
    // Find the first non-flag argument (the subcommand / script name).
    const sub = args.find((a) => !a.startsWith("-"))?.toLowerCase();
    if (sub && ARBITRARY_SCRIPTS.has(sub)) return "package";
    if (sub && TEST_SCRIPTS.has(sub)) return "test";
    if (sub && BUILD_SCRIPTS.has(sub)) return "build";
    return "package";
  }
  return "other";
}

/**
 * Validate a single argument: reject control characters/NULs and path-like
 * arguments that would read or write outside the workspace (absolute paths,
 * `..` traversal). Relative paths inside the workspace are fine.
 */
function validateArg(arg: string, workspacePath: string): ExecutionReason | null {
  if (CONTROL_CHARS.test(arg)) return "invalid_arg";
  if (arg.startsWith("-")) return null; // flags are not paths
  // Path-like tokens: absolute paths or traversal attempts are confined.
  if (arg.startsWith("/") || arg.startsWith("~/")) return "path_escape";
  const segments = arg.split("/");
  if (segments.includes("..")) return "path_escape";
  // Strip a leading "./" and resolve within the workspace for a final check.
  const rel = arg.replace(/^\.\//, "");
  if (rel.length > 0 && (rel.startsWith("/") || (rel.includes(":") && arg.includes("\\")))) {
    return "path_escape";
  }
  void workspacePath;
  return null;
}

export interface EvaluateOptions {
  /** Clamp per-request timeouts DOWN to this ceiling (never up). */
  timeoutCeilingMs?: number;
}

/**
 * Decide whether a command request may run. Throws ExecutionPolicyError on
 * invalid requests; returns a PolicyDecision for policy rejections.
 */
export function evaluateCommand(
  execution: ReviewExecutionConfig,
  request: CommandRequest,
  options: EvaluateOptions = {},
): { decision: PolicyDecision; policy: EffectivePolicy } {
  const deny = (reason: ExecutionReason, detail: string): { decision: PolicyDecision; policy: EffectivePolicy } => ({
    decision: { allowed: false, reason, detail },
    policy: buildEffectivePolicy(execution, options),
  });

  const command = request.command.trim();
  if (!command || command.includes("/") || command.includes("\\") || CONTROL_CHARS.test(command)) {
    throw new ExecutionPolicyError("Command must be a bare executable name", "invalid_arg", `command: ${command}`);
  }
  if (request.command !== command) {
    throw new ExecutionPolicyError("Command name must not contain leading/trailing whitespace", "invalid_arg");
  }

  // §10.2: read-only mode inspects without executing anything.
  if (execution.mode === "read-only") {
    return deny("mode_read_only", `execution.mode "read-only" forbids all command execution`);
  }

  // Workspace is mandatory — commands never run against arbitrary host cwd.
  if (!request.workspacePath || !request.workspacePath.startsWith("/")) {
    throw new ExecutionPolicyError("A workspace path is required for command execution", "workspace_required");
  }

  // Argument validation (defense-in-depth on top of argv-only execution).
  for (const arg of request.args) {
    const issue = validateArg(arg, request.workspacePath);
    if (issue) {
      return deny(issue, `Argument rejected: ${arg.slice(0, 64)}`);
    }
  }

  // §10.3: the allowlist is the primary gate.
  if (!execution.commands.allowlist.includes(command)) {
    return deny("not_allowlisted", `Command "${command}" is not in execution.commands.allowlist`);
  }

  const classification = classificationFor(command, request.args);
  const testsAllowed = execution.mode === "sandbox" ? execution.commands.allowTests : false;
  const buildsAllowed = execution.mode === "sandbox" ? execution.commands.allowBuilds : false;

  if (classification === "test" && !testsAllowed) {
    return deny("tests_disabled", "Test execution is disabled (execution.commands.allowTests)");
  }
  if (classification === "build" && !buildsAllowed) {
    return deny("builds_disabled", "Build execution is disabled (execution.commands.allowBuilds)");
  }
  if (classification === "package" && !execution.commands.allowPackageScripts) {
    return deny("package_scripts_disabled", "Package-manager script execution is disabled");
  }

  return { decision: { allowed: true, reason: "ok" }, policy: buildEffectivePolicy(execution, options) };
}

/** Resolve the effective limits/env posture for an execution attempt. */
export function buildEffectivePolicy(execution: ReviewExecutionConfig, options: EvaluateOptions = {}): EffectivePolicy {
  const ceiling = options.timeoutCeilingMs ?? execution.resources.executionTimeoutMs;
  const workspaceReadOnly = execution.mode !== "sandbox";
  return {
    mode: execution.mode,
    networkMode: execution.sandbox.networkMode,
    timeoutMs: Math.min(execution.resources.executionTimeoutMs, ceiling),
    memoryBytes: resolveQuantity(execution.resources.memoryLimit),
    cpuLimit: execution.resources.cpuLimit,
    diskQuotaBytes: resolveQuantity(execution.resources.diskLimit) ?? 0,
    runAsNonRoot: execution.sandbox.runAsNonRoot,
    workspaceReadOnly,
    extraEnv: {},
  };
}
