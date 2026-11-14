/**
 * Dozzle operations stack — Compose structure validation
 * (deploy/docker-compose.dozzle.yml).
 *
 * Dozzle is an infrastructure/operations tool, deliberately a SEPARATE
 * Compose project from the application stack. This file asserts the
 * architecture decision and the safeguards the project requires:
 *
 *   - The socket mount lives ONLY here (the main stack's §10.4 invariant
 *     and its tests stay completely unchanged — see
 *     test/deployment-compose.test.ts, which must keep passing as-is).
 *   - No host ports (Dokploy Traefik ingress over dokploy-network).
 *   - Authentication generated from env vars into a named volume, so the
 *     stack deploys from Compose alone (no host-side file creation).
 *   - Disabled actions/shell, pinned image.
 *
 * Parsed with the `yaml` package (raw file, no compose interpolation).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const composePath = path.resolve(__dirname, "../deploy/docker-compose.dozzle.yml");
const compose = parse(readFileSync(composePath, "utf8"), { merge: true }) as {
  services: Record<string, any>;
  networks: Record<string, any>;
  volumes: Record<string, any>;
};

const MAIN_COMPOSE_PATH = path.resolve(__dirname, "../deploy/docker-compose.yml");

describe("dozzle compose structure (operations stack)", () => {
  it("contains only the dozzle service, its auth init and the optional tunnel", () => {
    expect(Object.keys(compose.services).sort()).toEqual(["dozzle", "dozzle-init", "dozzle-tunnel"]);
    expect(compose.services.dozzle.image).toBe("amir20/dozzle:v11.4.1");
    expect(compose.services["dozzle-init"].image).toBe("amir20/dozzle:v11.4.1-alpine");
  });

  it("publishes Dozzle through an outbound-only Cloudflare quick tunnel (CGNAT)", () => {
    const tunnel = compose.services["dozzle-tunnel"];
    expect(tunnel.image).toBe("cloudflare/cloudflared:2026.10.7");
    expect(tunnel.command).toEqual(["tunnel", "--no-autoupdate", "--url", "http://dozzle:8080"]);
    expect(tunnel.networks).toEqual(["edge"]);
    expect(tunnel.depends_on.dozzle.condition).toBe("service_healthy");
    // A tunnel needs no inbound port and must never bind one on the host.
    expect("ports" in tunnel).toBe(false);
    expect(tunnel.expose).toBeUndefined();
  });

  it("keeps the public tunnel opt-in (profile) and host-port-free", () => {
    const tunnel = compose.services["dozzle-tunnel"];
    expect(tunnel.profiles).toEqual(["tunnel"]);
    expect("ports" in tunnel).toBe(false);
    expect(tunnel.expose).toBeUndefined();
  });

  it("mounts the Docker socket READ-ONLY and shared state as a named volume", () => {
    const mounts = compose.services.dozzle.volumes as string[];
    expect(mounts).toContain("/var/run/docker.sock:/var/run/docker.sock:ro");
    expect(mounts).toContain("dozzle-data:/data");
    // Regression: never bind-mount users.yml (or its host dir) directly.
    // A missing single-file source becomes a directory and Dozzle crashes
    // with "read /data/users.yml: is a directory".
    expect(mounts.some((m) => m.includes("/data/users.yml"))).toBe(false);
    expect(compose.volumes).toHaveProperty("dozzle-data");
  });

  it("generates users.yml from env vars before dozzle starts", () => {
    const init = compose.services["dozzle-init"];
    const command = init.command as string[];
    const script = command[0];
    expect(script).toContain("/dozzle generate admin");
    // Password is passed positionally ($1) rather than read inside the shell,
    // so Compose interpolation never has to escape shell `$VAR` references.
    expect(script).toContain('--password "$1"');
    expect(script).toContain('[ -z "$1" ]');
    expect(command[1]).toBe("dozzle-init");
    expect(command[2]).toContain("DOZZLE_ADMIN_PASSWORD");
    expect(command[5]).toContain("DOZZLE_FORCE_USERS");
    expect(init.volumes).toContain("dozzle-data:/data");
    expect(init.environment).toBeUndefined();
    expect(compose.services.dozzle.depends_on["dozzle-init"].condition).toBe("service_completed_successfully");
  });

  it("deploys auth from Compose env only (no host files, no manual steps)", () => {
    const raw = readFileSync(composePath, "utf8");
    // No host bind mount for /data; credentials live in the named volume.
    expect(raw).not.toContain("DOZZLE_DATA_DIR");
    expect(raw).not.toContain("DOZZLE_USERS_FILE");
    expect(compose.services.dozzle.volumes).toContain("dozzle-data:/data");
  });

  it("publishes NO host ports (expose 8080 for the Traefik ingress)", () => {
    expect("ports" in compose.services.dozzle).toBe(false);
    expect(compose.services.dozzle.expose).toEqual(["8080"]);
  });

  it("requires simple authentication and disables mutating capabilities", () => {
    const env = compose.services.dozzle.environment;
    expect(env.DOZZLE_AUTH_PROVIDER).toBe("simple");
    expect(env.DOZZLE_ENABLE_ACTIONS).toBe("false");
    expect(env.DOZZLE_ENABLE_SHELL).toBe("false");
    expect(env.DOZZLE_ENABLE_MCP).toBe("false");
  });

  it("mounts the UI under /dozzle on the existing Probot domain", () => {
    // Same ingress pattern as Phoenix (/phoenix), except Traefik must NOT
    // strip this prefix: DOZZLE_BASE rewrites assets to /dozzle/* and expects
    // to receive it.
    expect(compose.services.dozzle.environment.DOZZLE_BASE).toBe("/dozzle");
    expect(compose.services.dozzle.networks).toEqual(["edge"]);
  });

  it("joins ONLY the external Dokploy edge network (no internal reach into app networks)", () => {
    expect(compose.services.dozzle.networks).toEqual(["edge"]);
    expect(compose.networks.edge.external).toBe(true);
    expect(compose.networks.edge.name).toMatch(/\$\{DOKPLOY_NETWORK:-dokploy-network\}/);
  });

  it("has a healthcheck, restart policy and resource limits", () => {
    const svc = compose.services.dozzle;
    expect(svc.healthcheck.test).toEqual(["CMD", "/dozzle", "healthcheck"]);
    expect(svc.restart).toBe("unless-stopped");
    expect(svc.stop_grace_period).toBeTruthy();
    expect(svc.deploy.resources.limits.memory).toMatch(/^\d+[KMG]$/);
    expect(String(svc.deploy.resources.limits.cpus)).toBeTruthy();
  });

  it("keeps the socket mount OUT of the main application compose (§10.4 invariant intact)", () => {
    // Defense in depth: the main-stack test also asserts this; check again
    // here so the dozzle introduction cannot regress the app stack.
    const main = readFileSync(MAIN_COMPOSE_PATH, "utf8");
    expect(main.includes("docker.sock")).toBe(false);
  });

  it("never ships credentials (no inline users or bcrypt hashes)", () => {
    const raw = readFileSync(composePath, "utf8");
    expect(raw).toMatch(/dozzle.*generate/); // documented generation command
    expect(raw).not.toMatch(/^\s*users:/m); // no inline user entries
    expect(raw).not.toMatch(/\$2[aby]\$/); // no baked-in credential hashes
  });
});
