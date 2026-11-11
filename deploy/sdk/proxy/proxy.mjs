/**
 * Phase 2 CONNECT allowlist egress proxy (NON-PRODUCTION).
 *
 * This container is the ONLY service in the SDK stack with external network
 * connectivity (it is attached to `sdk-egress`, a normal bridge network). The
 * SDK worker stays on the internal-only `sdk-internal` network and can reach
 * the model ONLY through this proxy.
 *
 * Behaviour:
 *   - HTTP CONNECT only, on 0.0.0.0:3128.
 *   - Allow ONLY `${MODEL_ALLOWED_HOST}:443` (default llm.nativewit.app).
 *     Everything else gets 403 and is never dialled.
 *   - No TLS interception: after `200 Connection Established` the two sockets
 *     are piped verbatim. Payload bytes and headers are never inspected or
 *     logged.
 *   - Logs are limited to `{action, host, port}`.
 *   - Handshake (request line) and upstream establishment (DNS + TCP) are
 *     time-bounded.
 *   - Tiny unauthenticated health endpoint on 0.0.0.0:3129 (`GET /health`).
 *     It exposes only `{status, allowedHost}` — no secrets.
 *
 * The proxy is intentionally not a general-purpose client: it has no CONNECT
 * to any other host/port, no auth (the network is internal-only) and no open
 * relay. It holds no model credential.
 */
import { createServer as createHttpServer } from "node:http";
import net from "node:net";
import { pathToFileURL } from "node:url";

export const DEFAULT_ALLOWED_HOST = "llm.nativewit.app";
export const ALLOWED_PORT = 443;
export const DEFAULT_PROXY_PORT = 3128;
export const DEFAULT_HEALTH_PORT = 3129;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 10_000;

function allowedHostFromEnv() {
  return (process.env.MODEL_ALLOWED_HOST ?? DEFAULT_ALLOWED_HOST).trim().toLowerCase();
}

/**
 * Parse a CONNECT authority (`host:port`, or `[ipv6]:port`).
 * Returns `{host, port}` or `null` when malformed.
 */
export function parseConnectTarget(authority) {
  if (typeof authority !== "string") return null;
  const value = authority.trim();
  if (!value) return null;

  let host;
  let portText;
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end === -1) return null;
    host = value.slice(1, end);
    const rest = value.slice(end + 1);
    if (!rest.startsWith(":")) return null;
    portText = rest.slice(1);
  } else {
    const colon = value.lastIndexOf(":");
    if (colon <= 0) return null;
    host = value.slice(0, colon);
    portText = value.slice(colon + 1);
  }

  if (!/^\d{1,5}$/.test(portText)) return null;
  const port = Number(portText);
  if (port < 1 || port > 65535) return null;
  if (!host || /[\s/\\]/.test(host)) return null;

  return { host: host.toLowerCase(), port };
}

/**
 * Deny-by-default: only the configured host on port 443 is allowed.
 * The comparison is exact (case-insensitive), never suffix/prefix matching.
 */
export function isAllowedTarget(target, allowedHost = allowedHostFromEnv()) {
  if (!target) return false;
  return (
    target.port === ALLOWED_PORT &&
    String(target.host).toLowerCase() === String(allowedHost).toLowerCase()
  );
}

function log(action, target) {
  // Deliberately only these three fields. No headers, no payloads, no URLs.
  console.error(
    JSON.stringify({ action, host: target?.host ?? null, port: target?.port ?? null }),
  );
}

function reject(socket, status, reason) {
  if (socket.writable) {
    // Graceful end flushes the status line before closing.
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  } else {
    socket.destroy();
  }
}

function handleConnect(req, clientSocket, head) {
  const target = parseConnectTarget(req.url ?? "");

  if (!target || !isAllowedTarget(target)) {
    log("deny", target);
    reject(clientSocket, 403, "Forbidden");
    return;
  }

  log("allow", target);

  // Do not read client bytes until the upstream tunnel exists.
  clientSocket.pause();

  const upstream = net.connect({ host: target.host, port: target.port });
  let established = false;
  let settled = false;

  const fail = (status, reason) => {
    if (settled) return;
    settled = true;
    clearTimeout(establishTimer);
    // Send the HTTP error before tearing the sockets down.
    reject(clientSocket, status, reason);
    upstream.destroy();
    log("error", target);
  };

  const establishTimer = setTimeout(() => fail(504, "Gateway Timeout"), CONNECT_TIMEOUT_MS);
  upstream.setTimeout(CONNECT_TIMEOUT_MS, () => fail(504, "Gateway Timeout"));
  clientSocket.setTimeout(HANDSHAKE_TIMEOUT_MS, () => {
    if (!established) fail(408, "Request Timeout");
  });

  upstream.once("connect", () => {
    if (settled) return;
    settled = true;
    established = true;
    clearTimeout(establishTimer);
    upstream.setTimeout(0);
    clientSocket.setTimeout(0);

    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head && head.length > 0) upstream.write(head);

    // Raw byte piping only. Never inspect or log payloads.
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
    clientSocket.resume();
  });

  upstream.on("error", () => {
    if (established) {
      clientSocket.destroy();
    } else {
      fail(502, "Bad Gateway");
    }
  });
  clientSocket.on("error", () => upstream.destroy());
  clientSocket.on("close", () => upstream.destroy());
  upstream.on("close", () => clientSocket.destroy());
}

export function createProxyServer({ allowedHost = allowedHostFromEnv() } = {}) {
  const server = createHttpServer((req, res) => {
    // The proxy port only speaks CONNECT. Anything else is refused.
    res.writeHead(405, { "content-type": "text/plain" });
    res.end("CONNECT only\n");
  });
  server.on("connect", (req, clientSocket, head) => {
    // Re-check the configured host per connection rather than baking in a
    // closure value, so a restart/config change is the only way to widen it.
    handleConnect(req, clientSocket, head);
  });
  return server;
}

export function createHealthServer({ allowedHost = allowedHostFromEnv() } = {}) {
  return createHttpServer((req, res) => {
    if (req.method !== "GET" || req.url !== "/health") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end('{"status":"not-found"}');
      return;
    }
    const payload = JSON.stringify({ status: "ok", allowedHost });
    res.writeHead(200, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
      "cache-control": "no-store",
    });
    res.end(payload);
  });
}

function main() {
  const allowedHost = allowedHostFromEnv();
  const proxyPort = Number(process.env.MODEL_PROXY_PORT ?? DEFAULT_PROXY_PORT);
  const healthPort = Number(process.env.MODEL_PROXY_HEALTH_PORT ?? DEFAULT_HEALTH_PORT);

  const proxy = createProxyServer({ allowedHost });
  const health = createHealthServer({ allowedHost });

  proxy.on("error", (error) => {
    console.error(`[sdk-egress-proxy] proxy error: ${error?.message ?? error}`);
    process.exit(1);
  });
  health.on("error", (error) => {
    console.error(`[sdk-egress-proxy] health error: ${error?.message ?? error}`);
    process.exit(1);
  });

  proxy.listen(proxyPort, "0.0.0.0", () => {
    console.error(`[sdk-egress-proxy] CONNECT allowlist on 0.0.0.0:${proxyPort} (host=${allowedHost}:${ALLOWED_PORT})`);
  });
  health.listen(healthPort, "0.0.0.0", () => {
    console.error(`[sdk-egress-proxy] health on 0.0.0.0:${healthPort}`);
  });

  const shutdown = (signal) => {
    console.error(`[sdk-egress-proxy] received ${signal}; shutting down`);
    proxy.close();
    health.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// Only start servers when executed directly; tests import the helpers.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
