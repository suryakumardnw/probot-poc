/**
 * Optional observability stack structure validation (deploy/observability).
 *
 * Phoenix is deliberately a separate Compose project: it is optional, and the
 * app compose must still start without it. These invariants keep the stack
 * private-by-default and pinned.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const composePath = path.resolve(
  __dirname,
  "../deploy/observability/docker-compose.yml",
);
const compose = parse(readFileSync(composePath, "utf8"), { merge: true }) as {
  services: Record<string, any>;
  volumes: Record<string, unknown>;
  networks: Record<string, any>;
};

describe("observability compose structure", () => {
  it("contains only the Phoenix service", () => {
    expect(Object.keys(compose.services)).toEqual(["phoenix"]);
  });

  it("pins the Phoenix image (no floating tags)", () => {
    expect(compose.services.phoenix.image).toMatch(
      /^arizephoenix\/phoenix:\d+\.\d+\.\d+$/,
    );
  });

  it("publishes the UI only on loopback and exposes the OTLP port internally", () => {
    expect(compose.services.phoenix.ports).toEqual([
      "127.0.0.1:${PHOENIX_HOST_PORT:-6006}:6006",
    ]);
    expect(compose.services.phoenix.expose).toEqual(["6006"]);
  });

  it("persists traces on a named volume", () => {
    expect(compose.volumes).toHaveProperty("phoenix-data");
    expect(compose.services.phoenix.volumes).toContain(
      "phoenix-data:/mnt/data",
    );
    expect(compose.services.phoenix.environment.PHOENIX_WORKING_DIR).toBe(
      "/mnt/data",
    );
  });

  it("disables outbound telemetry and defaults auth off for loopback-only use", () => {
    expect(compose.services.phoenix.environment.PHOENIX_TELEMETRY_ENABLED).toBe(
      "false",
    );
    expect(compose.services.phoenix.environment.PHOENIX_ENABLE_AUTH).toBe(
      "${PHOENIX_ENABLE_AUTH:-false}",
    );
  });

  it("bounds trace retention to avoid unbounded disk growth", () => {
    expect(
      compose.services.phoenix.environment.PHOENIX_DEFAULT_RETENTION_POLICY_DAYS,
    ).toBe("${PHOENIX_RETENTION_DAYS:-30}");
  });

  it("health-checks the server and applies resource limits", () => {
    expect(compose.services.phoenix.healthcheck.test).toBeTruthy();
    const limits = compose.services.phoenix.deploy.resources.limits;
    expect(String(limits.cpus)).toBeTruthy();
    expect(String(limits.memory)).toMatch(/^\d+[KMG]$/);
  });

  it("joins the app-owned observability network as an external network", () => {
    expect(compose.services.phoenix.networks).toContain("observability");
    expect(compose.networks.observability.external).toBe(true);
    expect(compose.networks.observability.name).toBe(
      "${OBSERVABILITY_NETWORK:-ai-pr-reviewer_observability}",
    );
  });
});
