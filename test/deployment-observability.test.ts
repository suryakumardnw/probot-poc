/**
 * Optional observability stack structure validation (deploy/observability).
 *
 * Phoenix is deliberately a separate Compose project: it is optional, and the
 * app compose must still start without it. These invariants keep the stack
 * private-by-default and pinned.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { network, readComposeFile, service } from "./helpers/compose.js";

const composePath = path.resolve(__dirname, "../deploy/observability/docker-compose.yml");
const compose = readComposeFile(composePath);

describe("observability compose structure", () => {
  it("contains only the Phoenix service", () => {
    expect(Object.keys(compose.services)).toEqual(["phoenix"]);
  });

  it("pins the Phoenix image (no floating tags)", () => {
    expect(service(compose, "phoenix").image).toMatch(/^arizephoenix\/phoenix:\d+\.\d+\.\d+$/);
  });

  it("publishes the UI only on loopback and exposes the OTLP port internally", () => {
    expect(service(compose, "phoenix").ports).toEqual(["127.0.0.1:${PHOENIX_HOST_PORT:-6006}:6006"]);
    expect(service(compose, "phoenix").expose).toEqual(["6006"]);
  });

  it("persists traces on a named volume", () => {
    expect(compose.volumes).toHaveProperty("phoenix-data");
    expect(service(compose, "phoenix").volumes).toContain("phoenix-data:/mnt/data");
    expect(service(compose, "phoenix").environment.PHOENIX_WORKING_DIR).toBe("/mnt/data");
  });

  it("disables outbound telemetry and defaults auth off for loopback-only use", () => {
    expect(service(compose, "phoenix").environment.PHOENIX_TELEMETRY_ENABLED).toBe("false");
    expect(service(compose, "phoenix").environment.PHOENIX_ENABLE_AUTH).toBe("${PHOENIX_ENABLE_AUTH:-false}");
  });

  it("bounds trace retention to avoid unbounded disk growth", () => {
    expect(service(compose, "phoenix").environment.PHOENIX_DEFAULT_RETENTION_POLICY_DAYS).toBe(
      "${PHOENIX_RETENTION_DAYS:-30}",
    );
  });

  it("health-checks the server and applies resource limits", () => {
    expect(service(compose, "phoenix").healthcheck.test).toBeTruthy();
    const limits = service(compose, "phoenix").deploy.resources.limits;
    expect(String(limits.cpus)).toBeTruthy();
    expect(String(limits.memory)).toMatch(/^\d+[KMG]$/);
  });

  it("joins the app-owned observability network as an external network", () => {
    expect(service(compose, "phoenix").networks).toContain("observability");
    expect(network(compose, "observability").external).toBe(true);
    expect(network(compose, "observability").name).toBe("${OBSERVABILITY_NETWORK:-ai-pr-reviewer_observability}");
  });
});
