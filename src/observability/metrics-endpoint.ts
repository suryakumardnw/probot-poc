import http from "node:http";
import type { AddressInfo } from "node:net";
import { getMetricsRegistry } from "./metrics.js";

/**
 * GET /metrics — Prometheus text exposition (§16.2).
 *
 * Hand-rolled (no prom-client): every metric in the registry is rendered in
 * the OpenMetrics-compatible text format and served over plain HTTP. The
 * Probot server mounts the handler alongside /healthz and /readyz; the worker
 * process runs it on its own port (METRICS_PORT) since it is a separate
 * container. The endpoint is read-only and secret-free by construction.
 */

export const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

export function metricsHandler(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, HEAD");
    res.end();
    return;
  }
  const body = getMetricsRegistry().render();
  res.statusCode = 200;
  res.setHeader("Content-Type", METRICS_CONTENT_TYPE);
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  res.end(body);
}

/**
 * Start a dedicated metrics HTTP server (worker process). Returns the server
 * so the caller can close it on shutdown. Port 0 picks an ephemeral port
 * (useful in tests).
 */
export function startMetricsServer(port: number, host = "0.0.0.0"): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if ((req.url ?? "/").split("?")[0] !== "/metrics") {
        res.statusCode = 404;
        res.end();
        return;
      }
      metricsHandler(req, res);
    });
    server.on("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

/** Bound port of a started metrics server (tests / logs). */
export function metricsServerPort(server: http.Server): number | undefined {
  const address = server.address() as AddressInfo | null;
  return address?.port;
}
