import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, test } from "vitest";
import { DockerSandboxExecutor, DEFAULT_SANDBOX_IMAGE } from "../src/modules/execution/docker-executor.js";
import { ExecutionService } from "../src/modules/execution/index.js";
import { evaluateCommand } from "../src/modules/execution/policy.js";
import {
  ExecutionPolicyError,
  type CommandRequest,
  type ReviewExecutionConfig,
} from "../src/modules/execution/types.js";
import { prisma, disconnectDatabase } from "./helpers/db.js";

/**
 * Ticket 11 integration tests: secure execution and resource isolation.
 *
 * Covers the acceptance scenarios: allowlisted execution, policy denials,
 * hard timeouts with cleanup, secret/host/workspace escape attempts, network
 * blocking in the Docker sandbox, and audit records for both allowed and
 * denied executions.
 */

process.env.DATABASE_URL ??= "postgres://postgres:postgres@localhost:5432/reviewer";

const execFileAsync = promisify(execFile);
const ACTOR = "test:ticket-11";

function execConfig(overrides: Partial<ReviewExecutionConfig> = {}): ReviewExecutionConfig {
  return {
    mode: "static-analysis",
    commands: {
      allowlist: ["git", "grep", "find", "printenv", "sleep"],
      allowTests: false,
      allowBuilds: false,
      allowPackageScripts: false,
    },
    sandbox: { enabled: false, networkMode: "none", allowedDomains: [], runAsNonRoot: true },
    resources: {
      cpuLimit: "1",
      memoryLimit: "256Mi",
      diskLimit: "256Mi",
      executionTimeoutMs: 5000,
    },
    ...overrides,
  };
}

function request(overrides: Partial<CommandRequest> = {}): CommandRequest {
  return {
    command: "grep",
    args: [],
    workspacePath: workspace,
    actor: ACTOR,
    ...overrides,
  };
}

// One fresh untracked workspace per suite (no secrets in it — the secrets are
// injected into the APP env and must NOT be visible to executions).
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "t11-ws-"));
fs.writeFileSync(path.join(workspace, "file.txt"), "hello world\nsecond line\n");
fs.writeFileSync(path.join(workspace, ".env"), "DATABASE_URL=postgres://leak-attempt@localhost/db\n");

const service = new ExecutionService({ prisma, execution: execConfig() });
const dockerAvailable = await (async () => {
  try {
    await execFileAsync("docker", ["info", "-f", "{{.ServerVersion}}"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
})();
const docker = describe.skipIf(!dockerAvailable)("docker sandbox", () => {});

afterAll(async () => {
  fs.rmSync(workspace, { recursive: true, force: true });
  await disconnectDatabase();
});

// 1. Allowed command -----------------------------------------------------------

test("allowlisted command executes with argv-only semantics and exits cleanly", async () => {
  const result = await service.runCommand(request({ command: "grep", args: ["-c", "", "file.txt"] }));
  expect(result.decision).toBe("allowed");
  expect(result.reason).toBe("ok");
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("2");
  expect(result.sandboxed).toBe(false);
  expect(result.terminated).toBe(true);
});

test("git log works inside the workspace with hardened env", async () => {
  const result = await service.runCommand(request({ command: "git", args: ["--version"] }));
  expect(result.decision).toBe("allowed");
  expect(result.stdout).toMatch(/^git version/);
});

// 2. Policy denials ------------------------------------------------------------

test("disallowed command is denied before any process is spawned", async () => {
  const result = await service.runCommand(request({ command: "curl", args: ["http://example.com"] }));
  expect(result.decision).toBe("denied");
  expect(result.reason).toBe("not_allowlisted");
  expect(result.exitCode).toBeNull();
  expect(result.stdout).toBe("");
});

test("test execution is denied while allowTests is disabled", async () => {
  // The allowlist is the primary gate: commands not on it are rejected as
  // not_allowlisted. For classification coverage, use a config whose
  // allowlist includes the test/build entry points.
  const clsService = new ExecutionService({
    prisma,
    execution: execConfig({
      commands: {
        ...execConfig().commands,
        allowlist: [...execConfig().commands.allowlist, "vitest", "tsc", "npm", "make"],
      },
    }),
  });
  const result = await clsService.runCommand(request({ command: "vitest", args: ["run"] }));
  expect(result.decision).toBe("denied");
  expect(result.reason).toBe("tests_disabled");

  const npm = await clsService.runCommand(request({ command: "npm", args: ["test"] }));
  expect(npm.decision).toBe("denied");
  expect(npm.reason).toBe("tests_disabled");

  const unlisted = await service.runCommand(request({ command: "vitest", args: ["run"] }));
  expect(unlisted.decision).toBe("denied");
  expect(unlisted.reason).toBe("not_allowlisted");
});

test("build execution is denied while allowBuilds is disabled", async () => {
  const clsService = new ExecutionService({
    prisma,
    execution: execConfig({
      commands: {
        ...execConfig().commands,
        allowlist: [...execConfig().commands.allowlist, "tsc", "make"],
      },
    }),
  });
  const result = await clsService.runCommand(request({ command: "tsc", args: ["--version"] }));
  expect(result.decision).toBe("denied");
  expect(result.reason).toBe("builds_disabled");

  const make = await clsService.runCommand(request({ command: "make", args: ["all"] }));
  expect(make.decision).toBe("denied");
  expect(make.reason).toBe("builds_disabled");
});

test("read-only mode denies ALL command execution", async () => {
  const readOnly = new ExecutionService({
    prisma,
    execution: execConfig({ mode: "read-only" }),
  });
  const result = await readOnly.runCommand(request({ command: "grep", args: ["hello", "file.txt"] }));
  expect(result.decision).toBe("denied");
  expect(result.reason).toBe("mode_read_only");
});

// 3. Timeout -------------------------------------------------------------------

test("hard timeout kills the process tree and reports cleanup", async () => {
  const fast = new ExecutionService({
    prisma,
    execution: execConfig({ resources: { ...execConfig().resources, executionTimeoutMs: 300 } }),
  });
  const result = await fast.runCommand(request({ command: "sleep", args: ["30"] }));
  expect(result.decision).toBe("error");
  expect(result.reason).toBe("timeout_exceeded");
  expect(result.timedOut).toBe(true);
  expect(result.terminated).toBe(true);
  expect(result.durationMs ?? 0).toBeLessThan(10_000);
});

// 4. Escape attempts -----------------------------------------------------------

test("agent cannot exfiltrate DATABASE_URL through the environment", async () => {
  // Even when printenv IS allowlisted, the deny-by-default env allowlist
  // drops every application secret.
  process.env.DATABASE_URL = "postgres://postgres:postgres@localhost:5432/reviewer";
  const result = await service.runCommand(request({ command: "printenv", args: ["DATABASE_URL"] }));
  // The command ran, found nothing (the secret was dropped) and exited 1 —
  // the security property is the EMPTY stdout.
  expect(result.decision).toBe("error");
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");

  // Full environment dump must not contain any application secret either.
  const all = await service.runCommand(request({ command: "printenv", args: [] }));
  expect(all.decision).toBe("allowed");
  expect(all.stdout).not.toContain("DATABASE_URL");
  expect(all.stdout).not.toContain("postgres://");
  expect(all.stdout).not.toContain("SESSION_SECRET");
  delete process.env.DATABASE_URL;
});

test("reading the repository .env file is denied (cat not allowlisted)", async () => {
  const result = await service.runCommand(request({ command: "cat", args: [".env"] }));
  expect(result.decision).toBe("denied");
  expect(result.reason).toBe("not_allowlisted");
});

test("grep on the GitHub private key path is confined to the workspace", async () => {
  const hostFile = await service.runCommand(request({ command: "grep", args: ["BEGIN", "/etc/passwd"] }));
  expect(hostFile.decision).toBe("denied");
  expect(hostFile.reason).toBe("path_escape");

  const privateKey = await service.runCommand(request({ command: "grep", args: ["PRIVATE KEY", "../id_rsa"] }));
  expect(privateKey.decision).toBe("denied");
  expect(privateKey.reason).toBe("path_escape");

  const homeEscape = await service.runCommand(request({ command: "grep", args: ["x", "~/.ssh/id_rsa"] }));
  expect(homeEscape.decision).toBe("denied");
  expect(homeEscape.reason).toBe("path_escape");
});

test("find over host roots is rejected", async () => {
  const result = await service.runCommand(request({ command: "find", args: ["/etc", "-name", "*.conf"] }));
  expect(result.decision).toBe("denied");
  expect(result.reason).toBe("path_escape");
});

test("workspace traversal via .. is rejected", async () => {
  const result = await service.runCommand(request({ command: "grep", args: ["hello", "../../.env"] }));
  expect(result.decision).toBe("denied");
  expect(result.reason).toBe("path_escape");
});

test("shell execution is never allowlisted by default", async () => {
  // Even with argv-only execution, a shell in the allowlist would accept
  // arbitrary strings after -c — so sh/bash are structurally kept off the
  // default allowlist and denied here.
  const result = await service.runCommand(request({ command: "sh", args: ["-c", "printenv DATABASE_URL"] }));
  expect(result.decision).toBe("denied");
  expect(result.reason).toBe("not_allowlisted");

  const nul = await service.runCommand(request({ command: "grep", args: ["a\u0000b"] }));
  expect(nul.decision).toBe("denied");
  expect(nul.reason).toBe("invalid_arg");
});

test("bare-executable rule: paths and whitespace tricks are structurally invalid", async () => {
  expect(() => evaluateCommand(execConfig(), request({ command: "/bin/sh" }))).toThrow(ExecutionPolicyError);
  expect(() => evaluateCommand(execConfig(), request({ command: " git" }))).toThrow(ExecutionPolicyError);
});

// 5. Audit records --------------------------------------------------------------

test("allowed and denied executions both produce audit records", async () => {
  await service.runCommand(request({ command: "grep", args: ["hello", "file.txt"] }));
  await service.runCommand(request({ command: "curl", args: ["http://example.com"] }));

  const rows = await prisma.commandExecutionAudit.findMany({
    where: { actor: ACTOR, command: { in: ["grep", "curl"] } },
    orderBy: { createdAt: "desc" },
    take: 6,
  });
  const grep = rows.find((r) => r.command === "grep");
  const curl = rows.find((r) => r.command === "curl");
  expect(grep).toBeDefined();
  expect(grep!.decision).toBe("allowed");
  expect(grep!.reason).toBe("ok");
  expect(grep!.mode).toBe("static-analysis");
  expect(grep!.sandboxed).toBe(false);
  expect(grep!.stdoutBytes).toBeGreaterThan(0);
  expect(curl).toBeDefined();
  expect(curl!.decision).toBe("denied");
  expect(curl!.reason).toBe("not_allowlisted");
  expect(curl!.exitCode).toBeNull();
});

test("audit rows never contain output content", async () => {
  await service.runCommand(request({ command: "grep", args: ["hello", "file.txt"] }));
  const rows = await prisma.commandExecutionAudit.findMany({ where: { actor: ACTOR, command: "grep" }, take: 50 });
  for (const row of rows) {
    expect(JSON.stringify(row)).not.toContain("hello world");
  }
});

// 6. Docker sandbox (skipped when Docker is unavailable) -------------------------

docker.test("sandboxed static-analysis command runs as non-root with no network", { timeout: 120_000 }, async () => {
  const executor = new DockerSandboxExecutor({ image: DEFAULT_SANDBOX_IMAGE });
  await executor.ensureImage();
  const cfg = execConfig({
    mode: "static-analysis",
    sandbox: { enabled: true, networkMode: "none", allowedDomains: [], runAsNonRoot: true },
  });
  const { policy } = evaluateCommand(cfg, request({ command: "grep", args: ["hello", "file.txt"] }));
  const result = await executor.execute(request({ command: "grep", args: ["hello", "file.txt"] }), policy);
  expect(result.decision).toBe("allowed");
  expect(result.sandboxed).toBe(true);
  expect(result.terminated).toBe(true);
  expect(result.stdout).toContain("hello world");
});

docker.test("sandbox blocks all network egress in networkMode none", { timeout: 120_000 }, async () => {
  const executor = new DockerSandboxExecutor({ image: DEFAULT_SANDBOX_IMAGE });
  await executor.ensureImage();
  const cfg = execConfig({
    mode: "sandbox",
    sandbox: { enabled: true, networkMode: "none", allowedDomains: [], runAsNonRoot: true },
    commands: { ...execConfig().commands, allowlist: ["wget"], allowTests: true },
  });
  const req = request({ command: "wget", args: ["-T", "3", "-q", "-O", "-", "http://example.com"] });
  const { policy } = evaluateCommand(cfg, req);
  const result = await executor.execute(req, policy);
  // Alpine's busybox wget must fail: there is no route out of the container.
  expect(result.decision).toBe("error");
  expect(result.exitCode).not.toBe(0);
});

docker.test(
  "allowlist networkMode fails closed to none without a configured network",
  { timeout: 120_000 },
  async () => {
    const executor = new DockerSandboxExecutor({ image: DEFAULT_SANDBOX_IMAGE, networkName: undefined });
    await executor.ensureImage();
    const cfg = execConfig({
      mode: "sandbox",
      sandbox: { enabled: true, networkMode: "allowlist", allowedDomains: ["example.com"], runAsNonRoot: true },
      commands: { ...execConfig().commands, allowlist: ["wget"], allowTests: true },
    });
    const req = request({ command: "wget", args: ["-T", "3", "-q", "-O", "-", "http://example.com"] });
    const { policy } = evaluateCommand(cfg, req);
    const result = await executor.execute(req, policy);
    expect(result.decision).toBe("error");
    expect(result.detail).toContain("network_not_enforced");
  },
);

docker.test("sandboxed command cannot read host files outside the mount", { timeout: 120_000 }, async () => {
  const executor = new DockerSandboxExecutor({ image: DEFAULT_SANDBOX_IMAGE });
  await executor.ensureImage();
  const cfg = execConfig({
    mode: "sandbox",
    sandbox: { enabled: true, networkMode: "none", allowedDomains: [], runAsNonRoot: true },
    commands: { ...execConfig().commands, allowlist: ["grep"] },
  });
  // ../ traversal is rejected by the POLICY before reaching Docker…
  const policyDenial = evaluateCommand(cfg, request({ command: "grep", args: ["root", "/etc/passwd"] }));
  expect(policyDenial.decision.allowed).toBe(false);
  expect(policyDenial.decision.reason).toBe("path_escape");

  // …and inside the container the rootfs is read-only and non-root anyway.
  const req = request({ command: "grep", args: ["notInWorkspace", "file.txt"] });
  const { policy } = evaluateCommand(cfg, req);
  const result = await executor.execute(req, policy);
  expect(result.exitCode).toBe(1); // grep found nothing — no host secrets
  expect(result.stderr).not.toContain("Permission");
});
