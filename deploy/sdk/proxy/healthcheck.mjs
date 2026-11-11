/**
 * Container healthcheck for the Phase 2 egress proxy.
 *
 * Exit 0 only when GET /health on the health port returns HTTP 200 with
 * { status: "ok" }. Reads no secrets and prints no configuration values beyond
 * the allowlisted host (which is not secret).
 */
const HEALTH_PORT = Number(process.env.MODEL_PROXY_HEALTH_PORT ?? 3129);
const HEALTH_URL = `http://127.0.0.1:${HEALTH_PORT}/health`;
const TIMEOUT_MS = 3_000;

async function check() {
  const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`health endpoint returned HTTP ${response.status}`);
  }
  const body = await response.json();
  if (body?.status !== "ok") {
    throw new Error(`health endpoint not ok (status=${body?.status})`);
  }
}

check().then(
  () => process.exit(0),
  (error) => {
    console.error(`[sdk-egress-healthcheck] ${error?.message ?? error}`);
    process.exit(1);
  },
);
