/**
 * Phase 1 offline placeholder SDK worker (NON-PRODUCTION).
 *
 * Purpose: prove the container boundary around a real @opencode/sdk host.
 * It creates the SDK host with inline configuration, exposes an internal-only
 * health endpoint, refreshes a heartbeat file, and closes the host on SIGTERM.
 *
 * Deliberately NOT implemented in Phase 1:
 *   - queue consumption (BullMQ/Redis)
 *   - model calls or model credentials
 *   - GitHub access, review logic, publishing, adapter wiring
 *
 * This file is plain ESM so the image needs no TypeScript build step.
 */
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";

import { OpenCode } from "@opencode/sdk";

const PORT = Number(process.env.SDK_WORKER_PORT ?? 8081);
// Bind the container interface so the isolation probe (another container on
// the internal-only network) can reach /health. The port is never published
// on the host: the compose stack only uses `expose`, never `ports`.
const HOST = process.env.SDK_WORKER_HOST ?? "0.0.0.0";
const LOG_LEVEL = process.env.LOG_LEVEL ?? "error";

const RUNTIME_ROOT = "/tmp/sdk-worker";
const HEARTBEAT_FILE = `${RUNTIME_ROOT}/heartbeat`;
const HEARTBEAT_INTERVAL_MS = 5_000;

// Inline configuration analogous to the Phase 0 spike. No provider, network
// or model is configured: Phase 1 performs no model calls at all.
const INLINE_CONFIG = {
  $schema: "https://opencode.ai/config.json",
  update: "disable",
  share: "disabled",
  snapshots: false,
  permissions: [
    { action: "*", resource: "*", effect: "deny" },
    { action: "read", resource: "*", effect: "allow" },
    { action: "external_directory", resource: "*", effect: "deny" },
  ],
};

const WRITABLE_DIRS = [
  `${RUNTIME_ROOT}`,
  "/tmp/home",
  "/tmp/home/.config",
  "/tmp/home/.cache",
  "/tmp/home/.local/share",
  "/tmp/home/.local/state",
];

let host = null;
let heartbeatTimer = null;
let server = null;
let shuttingDown = false;
let resolveLifetime = null;

// Resolved by SIGTERM/SIGINT. The main function awaits it inside a try block,
// so all cleanup lives in one literal `finally`, regardless of how it stops.
const lifetime = new Promise((resolve) => {
  resolveLifetime = resolve;
});

async function touchHeartbeat() {
  await writeFile(HEARTBEAT_FILE, `${Date.now()}\n`);
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function startHttpServer() {
  return new Promise((resolve, reject) => {
    const srv = createServer((req, res) => {
      if (req.method !== "GET") {
        sendJson(res, 405, { status: "method-not-allowed" });
        return;
      }
      if (req.url === "/health" || req.url === "/ready") {
        const ready = host !== null;
        sendJson(res, ready ? 200 : 503, {
          status: ready ? "ok" : "starting",
          node: process.version,
          uid: typeof process.getuid === "function" ? process.getuid() : null,
          host: ready ? "ready" : "starting",
        });
        return;
      }
      sendJson(res, 404, { status: "not-found" });
    });
    srv.once("error", reject);
    srv.listen(PORT, HOST, () => {
      server = srv;
      resolve();
    });
  });
}

function requestShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[sdk-worker] received ${signal}; shutting down`);
  resolveLifetime();
}

async function main() {
  await Promise.all(WRITABLE_DIRS.map((dir) => mkdir(dir, { recursive: true })));

  try {
    try {
      host = await OpenCode.create({
        config: {
          content: JSON.stringify(INLINE_CONFIG),
          project: false,
          claude: false,
        },
        database: { path: `${RUNTIME_ROOT}/opencode.db` },
        models: { fetch: false },
        fs: { filewatcher: false },
        log: {
          level: LOG_LEVEL === "debug" ? "debug" : "error",
          // Minimal sink: never print SDK payloads or environment values.
          emit: () => {},
        },
      });
    } catch (error) {
      console.error(`[sdk-worker] OpenCode host creation failed: ${error?.message ?? error}`);
      throw error;
    }

    await touchHeartbeat();
    heartbeatTimer = setInterval(() => {
      touchHeartbeat().catch((error) => {
        console.error(`[sdk-worker] heartbeat write failed: ${error?.message ?? error}`);
      });
    }, HEARTBEAT_INTERVAL_MS);

    await startHttpServer();
    console.error(`[sdk-worker] ready on ${HOST}:${PORT} (offline placeholder, no model calls)`);

    // Normal lifetime: runs until a signal resolves this promise.
    await lifetime;
  } finally {
    // Single cleanup path. No other code calls host.close(), so it cannot
    // double-close. Explicit close() — never `await using`.
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
    try {
      await host?.close();
    } catch (error) {
      console.error(`[sdk-worker] host close failed: ${error?.message ?? error}`);
    }
  }
}

process.on("SIGTERM", () => requestShutdown("SIGTERM"));
process.on("SIGINT", () => requestShutdown("SIGINT"));

main().then(
  () => process.exit(0),
  (error) => {
    console.error(`[sdk-worker] fatal: ${error?.stack ?? error}`);
    process.exit(1);
  },
);
