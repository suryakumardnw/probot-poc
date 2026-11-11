/**
 * Container healthcheck for the Phase 1 placeholder SDK worker.
 *
 * Exit 0 only when:
 *   - GET /health returns HTTP 200 with { status: "ok", host: "ready" }
 *   - /tmp/sdk-worker/heartbeat is fresh (< 15s old)
 *
 * No secrets are read or printed.
 */
import { readFile } from "node:fs/promises";

const PORT = Number(process.env.SDK_WORKER_PORT ?? 8081);
const HEALTH_URL = `http://127.0.0.1:${PORT}/health`;
const HEARTBEAT_FILE = "/tmp/sdk-worker/heartbeat";
const HEARTBEAT_MAX_AGE_MS = 15_000;
const FETCH_TIMEOUT_MS = 3_000;

async function check() {
  const response = await fetch(HEALTH_URL, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`health endpoint returned HTTP ${response.status}`);
  }
  const body = await response.json();
  if (body?.status !== "ok" || body?.host !== "ready") {
    throw new Error(`health endpoint not ready (status=${body?.status}, host=${body?.host})`);
  }

  const raw = await readFile(HEARTBEAT_FILE, "utf8");
  const heartbeatAt = Number(raw.trim());
  if (!Number.isFinite(heartbeatAt)) {
    throw new Error("heartbeat file is not a timestamp");
  }
  const ageMs = Date.now() - heartbeatAt;
  if (ageMs > HEARTBEAT_MAX_AGE_MS || ageMs < -HEARTBEAT_MAX_AGE_MS) {
    throw new Error(`heartbeat is stale (age=${ageMs}ms)`);
  }
}

check().then(
  () => process.exit(0),
  (error) => {
    console.error(`[sdk-healthcheck] ${error?.message ?? error}`);
    process.exit(1);
  },
);
