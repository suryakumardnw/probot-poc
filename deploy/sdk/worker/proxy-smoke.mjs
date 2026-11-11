/**
 * Phase 2 egress-path smoke test (NON-PRODUCTION).
 *
 * One-shot check that the SDK worker's only external path is the allowlist
 * proxy. Run it from the compose stack with the worker's network/hardening:
 *
 *   docker compose -f deploy/docker-compose.sdk.yml run --rm sdk-egress-probe
 *
 * Checks:
 *   1. proxy /health returns {status:"ok"} (internal, direct);
 *   2. CONNECT to the allowlisted model host completes a TLS handshake and
 *      gets *any* HTTP response (401/403/404 all mean "reachable");
 *   3. CONNECT to a non-allowlisted host (api.github.com) is rejected by the
 *      proxy (no HTTP response, or a 403);
 *   4. direct egress from this container to api.github.com still fails.
 *
 * Node 24's built-in fetch does NOT honour HTTPS_PROXY, so this uses an
 * explicit undici ProxyAgent — the same mechanism the SDK host will receive as
 * an injected `fetch`. No secrets are read or printed.
 */
import { fetch as undiciFetch, ProxyAgent } from "undici";

const PROXY_URL = process.env.MODEL_PROXY_URL ?? "http://sdk-egress-proxy:3128";
const ALLOWED_HOST = process.env.MODEL_ALLOWED_HOST ?? "llm.nativewit.app";
const REQUEST_TIMEOUT_MS = 12_000;

const checks = [];

function record(id, pass, detail) {
  checks.push({ id, pass: Boolean(pass), detail });
}

function proxyHealthUrl() {
  const url = new URL(PROXY_URL);
  url.port = process.env.MODEL_PROXY_HEALTH_PORT ?? "3129";
  url.pathname = "/health";
  return url.toString();
}

function errorDetail(error) {
  return error?.code ?? error?.name ?? error?.message ?? String(error);
}

async function checkProxyHealth() {
  try {
    const response = await fetch(proxyHealthUrl(), {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = await response.json();
    const pass = response.ok && body?.status === "ok";
    record("proxy-health", pass, { http: response.status, status: body?.status ?? null });
  } catch (error) {
    record("proxy-health", false, `request failed: ${errorDetail(error)}`);
  }
}

async function checkAllowlistedConnect(dispatcher) {
  try {
    const response = await undiciFetch(`https://${ALLOWED_HOST}/`, {
      dispatcher,
      // Any HTTP response (even an auth/not-found error) means CONNECT + TLS
      // succeeded through the proxy.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    record("allowlisted-connect", true, {
      reached: true,
      host: ALLOWED_HOST,
      http: response.status,
    });
  } catch (error) {
    record("allowlisted-connect", false, {
      reached: false,
      host: ALLOWED_HOST,
      error: errorDetail(error),
    });
  }
}

async function checkDeniedHost(dispatcher) {
  try {
    const response = await undiciFetch("https://api.github.com/", {
      dispatcher,
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    // A 403 from the proxy is the expected deny; any other HTTP status means
    // the tunnel was actually established and the allowlist failed.
    record("denied-host-blocked", response.status === 403, {
      blocked: response.status === 403,
      host: "api.github.com",
      http: response.status,
    });
  } catch (error) {
    // Connection refused/reset by the proxy is also an acceptable denial.
    record("denied-host-blocked", true, {
      blocked: true,
      host: "api.github.com",
      error: errorDetail(error),
    });
  }
}

async function checkDirectEgressBlocked() {
  try {
    const response = await fetch("https://api.github.com/", {
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    record("direct-egress-blocked", false, {
      blocked: false,
      host: "api.github.com",
      http: response.status,
    });
  } catch (error) {
    record("direct-egress-blocked", true, {
      blocked: true,
      host: "api.github.com",
      error: errorDetail(error),
    });
  }
}

async function main() {
  const dispatcher = new ProxyAgent({ uri: PROXY_URL });

  await checkProxyHealth();
  await checkAllowlistedConnect(dispatcher);
  await checkDeniedHost(dispatcher);
  await checkDirectEgressBlocked();

  await dispatcher.close();

  const failed = checks.filter((check) => !check.pass);
  const report = {
    probe: "sdk-egress-path",
    phase: 2,
    timestamp: new Date().toISOString(),
    proxyConfigured: true,
    allowedHost: ALLOWED_HOST,
    passed: failed.length === 0,
    summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    checks,
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  console.error(
    `[sdk-egress] ${report.summary.passed}/${report.summary.total} checks passed — ${report.passed ? "PASS" : "FAIL"}`,
  );
  for (const failure of failed) {
    console.error(`[sdk-egress] FAIL ${failure.id}: ${JSON.stringify(failure.detail)}`);
  }

  process.exit(report.passed ? 0 : 1);
}

main().catch((error) => {
  console.error(`[sdk-egress] fatal: ${error?.stack ?? error}`);
  process.exit(1);
});
