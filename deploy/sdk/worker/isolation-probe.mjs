/**
 * Phase 1 container-boundary probe (NON-PRODUCTION).
 *
 * One-shot adversarial check of the running SDK worker container. Run it from
 * the compose stack so it shares the SAME hardening boundary as the worker:
 *
 *   docker compose -f deploy/docker-compose.sdk.yml run --rm sdk-isolation-probe
 *
 * Exit 0 only if every check passes. A JSON report goes to stdout; a concise
 * human summary goes to stderr. Never prints secret values or environment
 * contents — failing environment keys are named, not shown.
 */
import { access, readFile, unlink, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import net from "node:net";
import { Resolver } from "node:dns/promises";

const CHECKS = [];
const WRITE_TIMEOUT_MS = 4_000;
const PUBLIC_HTTP_URL = "https://api.github.com";
const PUBLIC_TCP_HOST = "1.1.1.1";
const PUBLIC_TCP_PORT = 443;
const PUBLIC_DNS_SERVER = "1.1.1.1";
const INTERNAL_HEALTH_URL = "http://sdk-worker:8081/health";
const HEARTBEAT_FILE = "/tmp/sdk-worker/heartbeat";

function record(id, pass, actual, expected) {
  CHECKS.push({ id, pass: Boolean(pass), actual, expected });
}

function errorDetail(error) {
  return error?.code ?? error?.name ?? error?.message ?? String(error);
}

async function checkUid() {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  record("uid-non-root", uid !== null && uid !== 0, { uid }, { uid: "non-zero (1000)" });
}

async function checkReadOnlyWrite(id, filePath, label) {
  let actual;
  let pass = false;
  try {
    await writeFile(filePath, "probe\n", { flag: "w" });
    actual = "write unexpectedly succeeded";
    await unlink(filePath).catch(() => {});
  } catch (error) {
    // Require the specific read-only signal. EACCES (permissions), ENOENT
    // (missing path) or any other error would not prove a read-only mount.
    actual = `write failed: code=${error?.code ?? "none"} (${errorDetail(error)})`;
    pass = error?.code === "EROFS";
  }
  record(id, pass, actual, `${label} is read-only (write must fail with EROFS)`);
}

async function checkWorkspacesWritable() {
  const filePath = `/app/workspaces/.sdk-probe-${process.pid}.tmp`;
  try {
    await writeFile(filePath, "probe\n");
    const content = (await readFile(filePath, "utf8")).trim();
    await unlink(filePath);
    record(
      "workspaces-writable",
      content === "probe",
      { contentMatches: content === "probe", deleted: true },
      "create/read/delete succeeds in /app/workspaces",
    );
  } catch (error) {
    record("workspaces-writable", false, `workspace write failed: ${errorDetail(error)}`, "create/read/delete succeeds in /app/workspaces");
  }
}

async function checkTmpWritable() {
  const filePath = `/tmp/.sdk-probe-${process.pid}.tmp`;
  try {
    await writeFile(filePath, "probe\n");
    const content = (await readFile(filePath, "utf8")).trim();
    await unlink(filePath);
    record("tmp-writable", content === "probe", { contentMatches: content === "probe", deleted: true }, "create/read/delete succeeds in /tmp");
  } catch (error) {
    record("tmp-writable", false, `tmp write failed: ${errorDetail(error)}`, "create/read/delete succeeds in /tmp");
  }
}

async function checkSocketAbsent() {
  const candidates = ["/var/run/docker.sock", "/run/docker.sock"];
  const found = [];
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.F_OK);
      found.push(candidate);
    } catch {
      // absent — expected
    }
  }
  record("no-docker-socket", found.length === 0, { present: found }, "neither Docker socket path exists");
}

// Guardrail, not an exhaustive credential scanner: these cover the providers
// and secrets this project has used or might plausibly inject. Generic
// `API_KEY` is matched case-insensitively so new provider prefixes are caught.
const FORBIDDEN_ENV_PATTERNS = [
  /GITHUB/i,
  /GH_TOKEN/i,
  /APP_ID/i,
  /WEBHOOK_SECRET/i,
  /PRIVATE_KEY/i,
  /DATABASE_URL/i,
  /POSTGRES/i,
  /REDIS/i,
  /AWS_/i,
  /OPENAI_API_KEY/i,
  /MODEL_API_KEY/i,
  /GLM_API_KEY/i,
  /ZHIPU_API_KEY/i,
  /ANTHROPIC/i,
  /API_KEY/i,
];
const PEM_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

async function checkNoCredentials() {
  const forbiddenKeys = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (FORBIDDEN_ENV_PATTERNS.some((pattern) => pattern.test(key))) {
      forbiddenKeys.push(key);
      continue;
    }
    if (typeof value === "string" && PEM_PATTERN.test(value)) {
      forbiddenKeys.push(key);
    }
  }
  record("no-forbidden-credentials", forbiddenKeys.length === 0, { keys: forbiddenKeys }, "no credential-like environment keys or PEM values");
}

async function readProcStatus() {
  const raw = await readFile("/proc/self/status", "utf8");
  const fields = {};
  for (const line of raw.split("\n")) {
    const match = line.match(/^([A-Za-z]+):\s*(.*)$/);
    if (match) fields[match[1]] = match[2].trim();
  }
  return fields;
}

async function checkCapabilities(status) {
  const raw = status.CapEff ?? "";
  let value = null;
  let pass = false;
  try {
    value = BigInt(`0x${raw}`);
    pass = value === 0n;
  } catch {
    pass = false;
  }
  record("capabilities-dropped", pass, { CapEff: raw || null }, "CapEff is 0000000000000000");
}

async function checkNoNewPrivileges(status) {
  const raw = status.NoNewPrivs ?? null;
  record("no-new-privileges", raw === "1", { NoNewPrivs: raw }, "NoNewPrivs is 1");
}

function withTimeout(promise, ms, onTimeout) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(onTimeout), ms)),
  ]);
}

async function fetchBlocked() {
  try {
    const response = await fetch(PUBLIC_HTTP_URL, {
      redirect: "manual",
      signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
    });
    return { blocked: false, detail: `HTTP ${response.status}` };
  } catch (error) {
    return { blocked: true, detail: errorDetail(error) };
  }
}

function tcpConnectAttempt(host, port, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (connected, detail) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ connected, detail });
    };
    const socket = net.connect({ host, port });
    socket.setTimeout(timeoutMs, () => finish(false, "timeout"));
    socket.once("connect", () => finish(true, "connected"));
    socket.once("error", (error) => finish(false, errorDetail(error)));
  });
}

async function dnsBlocked() {
  const resolver = new Resolver();
  resolver.setServers([PUBLIC_DNS_SERVER]);
  const attempt = resolver
    .resolve4("api.github.com")
    .then((addresses) => ({ resolved: true, detail: addresses.join(",") }))
    .catch((error) => ({ resolved: false, detail: errorDetail(error) }));
  return withTimeout(attempt, WRITE_TIMEOUT_MS, { resolved: false, detail: "timeout" });
}

async function checkPublicEgressBlocked() {
  const [http, tcp, dns] = await Promise.all([
    fetchBlocked(),
    tcpConnectAttempt(PUBLIC_TCP_HOST, PUBLIC_TCP_PORT, WRITE_TIMEOUT_MS),
    dnsBlocked(),
  ]);
  const pass = http.blocked && !tcp.connected && !dns.resolved;
  record(
    "public-egress-blocked",
    pass,
    {
      http: http.blocked ? `blocked (${http.detail})` : `UNEXPECTED ${http.detail}`,
      tcp: !tcp.connected ? `blocked (${tcp.detail})` : "UNEXPECTED connected",
      dns: !dns.resolved ? `blocked (${dns.detail})` : `UNEXPECTED resolved ${dns.detail}`,
    },
    "public HTTP, raw TCP and external DNS all fail or time out",
  );
}

async function checkInternalReachability() {
  try {
    const response = await fetch(INTERNAL_HEALTH_URL, {
      signal: AbortSignal.timeout(5_000),
    });
    const body = await response.json();
    const pass = response.ok && body?.status === "ok";
    record(
      "internal-service-reachable",
      pass,
      { http: response.status, status: body?.status ?? null },
      "GET http://sdk-worker:8081/health succeeds with status ok",
    );
  } catch (error) {
    record("internal-service-reachable", false, `request failed: ${errorDetail(error)}`, "GET http://sdk-worker:8081/health succeeds with status ok");
  }
}

function unescapeMountPath(value) {
  return value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
}

// /dev/shm, /dev/pts, /dev/mqueue and the other /dev/* mounts are rw by
// Docker default. That is a standard container interface, not an application
// writable surface, so /dev, /proc and /sys are allowed by prefix. The
// invariant is: no writable mount outside /tmp, /app/workspaces and standard
// /proc, /sys, /dev interfaces.
async function checkWritableMountSurface() {
  const raw = await readFile("/proc/self/mounts", "utf8");
  const allowedExact = new Set([
    "/app/workspaces",
    "/tmp",
    "/etc/hosts",
    "/etc/hostname",
    "/etc/resolv.conf",
  ]);
  const allowedPrefixes = ["/proc", "/sys", "/dev"];
  const writable = [];
  const unexpected = [];

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const fields = line.split(/\s+/);
    const mountPoint = unescapeMountPath(fields[1] ?? "");
    const options = (fields[3] ?? "").split(",");
    if (!options.includes("rw")) continue;
    writable.push(mountPoint);
    const allowed =
      allowedExact.has(mountPoint) ||
      allowedPrefixes.some((prefix) => mountPoint === prefix || mountPoint.startsWith(`${prefix}/`));
    if (!allowed) unexpected.push(mountPoint);
  }

  record(
    "writable-mount-surface",
    unexpected.length === 0,
    { writable: writable.sort(), unexpected },
    "no writable mount outside /tmp, /app/workspaces and standard /proc, /sys, /dev interfaces",
  );
}

async function main() {
  await checkUid();
  await checkReadOnlyWrite("rootfs-read-only", "/sdk-probe-rootfs", "root filesystem");
  await checkReadOnlyWrite("app-read-only", "/app/.sdk-probe-write", "/app (image code)");
  await checkWorkspacesWritable();
  await checkTmpWritable();
  await checkSocketAbsent();
  await checkNoCredentials();

  const status = await readProcStatus();
  await checkCapabilities(status);
  await checkNoNewPrivileges(status);

  await checkPublicEgressBlocked();
  await checkInternalReachability();
  await checkWritableMountSurface();

  // Sanity: heartbeat exists locally only if /tmp is shared with this process.
  // Not a scored check (the probe has its own /tmp); useful diagnostics.
  let heartbeatSeen = false;
  try {
    await access(HEARTBEAT_FILE, fsConstants.F_OK);
    heartbeatSeen = true;
  } catch {
    heartbeatSeen = false;
  }

  const failed = CHECKS.filter((check) => !check.pass);
  const report = {
    probe: "sdk-container-isolation",
    phase: 1,
    timestamp: new Date().toISOString(),
    node: process.version,
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    passed: failed.length === 0,
    summary: {
      total: CHECKS.length,
      passed: CHECKS.length - failed.length,
      failed: failed.length,
    },
    diagnostics: { heartbeatVisibleToProbe: heartbeatSeen },
    checks: CHECKS,
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  console.error(
    `[sdk-isolation] ${report.summary.passed}/${report.summary.total} checks passed — ${report.passed ? "PASS" : "FAIL"}`,
  );
  for (const failure of failed) {
    console.error(`[sdk-isolation] FAIL ${failure.id}: ${JSON.stringify(failure.actual)}`);
  }

  process.exit(report.passed ? 0 : 1);
}

main().catch((error) => {
  console.error(`[sdk-isolation] fatal: ${error?.stack ?? error}`);
  process.exit(1);
});
