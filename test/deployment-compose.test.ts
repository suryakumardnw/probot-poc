/**
 * Ticket 13 — production Compose structure validation (deploy/docker-compose.yml).
 *
 * These are deployment-safety invariants from ARCHITECTURE.md §18 and the
 * ticket 13 acceptance criteria, enforced statically so a careless compose
 * edit cannot silently publish the databases or mount the Docker socket.
 *
 * Parsed with the `yaml` package (raw file, no compose interpolation).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defined } from "./helpers/assert.js";
import { network, readComposeFile, service } from "./helpers/compose.js";

const composePath = path.resolve(__dirname, "../deploy/docker-compose.yml");
const compose = readComposeFile(composePath);

const LONG_RUNNING = ["probot", "worker", "postgres", "redis", "backup"];

describe("production compose structure (ticket 13)", () => {
  it("contains exactly the §18.2 service topology", () => {
    expect(Object.keys(compose.services).sort()).toEqual(
      ["backup", "migrate", "postgres", "probot", "redis", "worker"].sort(),
    );
  });

  it("publishes NO ports for postgres or redis (private by construction)", () => {
    for (const svc of ["postgres", "redis", "worker", "migrate", "backup"]) {
      expect(service(compose, svc).ports ?? [], `${svc} ports`).toEqual([]);
      expect("ports" in service(compose, svc), `${svc} has no ports key`).toBe(false);
    }
  });

  it("publishes NO host ports for any service (Dokploy Traefik ingress)", () => {
    // On Dokploy, Traefik routes to probot's container port over
    // dokploy-network (Domains tab). Publishing host ports would claim
    // 0.0.0.0:3000 and collide with Dokploy gateway endpoints. Local runs
    // use deploy/docker-compose.local.yml for a localhost-only mapping.
    for (const svc of Object.keys(compose.services)) {
      expect("ports" in service(compose, svc), `${svc} has no ports key`).toBe(false);
    }
  });

  it("exposes container port 3000 on probot for the Traefik ingress", () => {
    expect(service(compose, "probot").expose).toEqual(["3000"]);
  });

  it("uses named volumes for all persistent data (§17.1)", () => {
    for (const v of ["postgres-data", "redis-data", "review-workspaces", "pg-backups"]) {
      expect(compose.volumes, `volume ${v} declared`).toHaveProperty(v);
    }
    expect(service(compose, "postgres").volumes.join(" ")).toContain("postgres-data:/var/lib/postgresql/data");
    expect(service(compose, "redis").volumes.join(" ")).toContain("redis-data:/data");
    expect(service(compose, "worker").volumes.join(" ")).toContain("review-workspaces:/app/workspaces");
    expect(service(compose, "backup").volumes.join(" ")).toContain("pg-backups:/backups");
    // No host bind mounts in app services (all volume sources are named volumes).
    for (const svc of LONG_RUNNING) {
      for (const v of service(compose, svc).volumes ?? []) {
        const source = (typeof v === "string" ? v.split(":")[0] : v.source) ?? "";
        expect(
          source.startsWith("/") || source.startsWith("./") || source.startsWith("../"),
          `${svc} volume ${source} is not a bind mount`,
        ).toBe(false);
      }
    }
  });

  it("configures health checks on every long-running service", () => {
    for (const svc of LONG_RUNNING) {
      expect(service(compose, svc).healthcheck, `${svc} healthcheck`).toBeDefined();
      expect(service(compose, svc).healthcheck.test, `${svc} healthcheck test`).toBeTruthy();
    }
  });

  it("sets resource limits on every long-running service (§18.4)", () => {
    for (const svc of LONG_RUNNING) {
      const limits = service(compose, svc).deploy?.resources?.limits;
      expect(limits, `${svc} limits`).toBeDefined();
      expect(String(limits.cpus)).toBeTruthy();
      expect(String(limits.memory)).toMatch(/^\d+[KMG]$/);
    }
    // Deployment memory budget: 2560M primary (worker 1536 + probot 256 +
    // postgres 384 + redis 256 + backup 128), plus the optional Phoenix 512M
    // and Dozzle stack (128M + 64M tunnel) = 3200M total on an 8 GB host.
    // These are reviewed ceilings; re-tune from observed peaks during a PR.
    expect(service(compose, "worker").deploy.resources.limits.cpus).toBe("2.0");
    expect(service(compose, "worker").deploy.resources.limits.memory).toBe("1536M");
    expect(service(compose, "probot").deploy.resources.limits.memory).toBe("256M");
    expect(service(compose, "postgres").deploy.resources.limits.memory).toBe("384M");
    expect(service(compose, "redis").deploy.resources.limits.memory).toBe("256M");
    expect(service(compose, "backup").deploy.resources.limits.memory).toBe("128M");
  });

  it("keeps optional services off by default (backup / tunnel profiles)", () => {
    // The lean PoC deployment starts only the review path; backups and the
    // public log tunnel are explicit opt-ins. Named volumes stay declared, so
    // PostgreSQL data survives regardless of the backup service.
    expect(service(compose, "backup").profiles).toEqual(["backup"]);
    expect(service(compose, "backup").volumes).toContain("pg-backups:/backups");
  });

  it("orders startup with health-gated depends_on + one-shot migration", () => {
    for (const svc of ["probot", "worker"]) {
      const deps = service(compose, svc).depends_on;
      expect(defined(deps.migrate).condition).toBe("service_completed_successfully");
      expect(defined(deps.postgres).condition).toBe("service_healthy");
      expect(defined(deps.redis).condition).toBe("service_healthy");
    }
    expect(service(compose, "migrate").command.join(" ")).toContain("prisma migrate deploy");
    expect(defined(service(compose, "migrate").depends_on.postgres).condition).toBe("service_healthy");
  });

  it("configures restart policy and graceful shutdown for long-running services", () => {
    for (const svc of LONG_RUNNING) {
      expect(service(compose, svc).restart).toBe("unless-stopped");
      expect(service(compose, svc).stop_grace_period, `${svc} stop_grace_period`).toBeTruthy();
    }
    expect(service(compose, "migrate").restart).toBe("no");
  });

  it("never mounts the Docker socket (§10.4 isolation)", () => {
    const raw = readFileSync(composePath, "utf8");
    expect(raw.includes("docker.sock")).toBe(false);
    for (const svc of Object.keys(compose.services)) {
      for (const v of service(compose, svc).volumes ?? []) {
        const target = (typeof v === "string" ? v.split(":")[1] : v.target) ?? "";
        expect(target, `${svc} target ${target}`).not.toContain("docker.sock");
      }
    }
  });

  it("keeps secrets out of the compose file (env_file + inline env vars)", () => {
    // Key material is never hardcoded: it arrives via deploy/.env (env_file)
    // as GITHUB_PRIVATE_KEY / GITHUB_PRIVATE_KEY_BASE64 / GITHUB_PRIVATE_KEY_PATH.
    expect(compose.secrets).toBeUndefined();
    const raw = readFileSync(composePath, "utf8");
    expect(raw).not.toMatch(/PRIVATE_KEY(_BASE64|_PATH)?:\s*\S/); // no literal key values in compose
    expect(raw).not.toMatch(/PRIVATE_KEY\s*=\s*[A-Za-z0-9+/\\-]{8,}/);
    expect(raw).not.toMatch(/POSTGRES_PASSWORD\s*=\s*\S/); // interpolated from deploy/.env only
    for (const svc of ["probot", "worker", "migrate"]) {
      expect(service(compose, svc).env_file, `${svc} uses env_file`).toContain("./.env");
    }
  });

  it("keeps the databases on an internal-only network", () => {
    const internal = network(compose, "internal");
    expect(internal.internal).toBe(true);
    for (const svc of ["postgres", "redis", "backup", "migrate"]) {
      expect(service(compose, svc).networks).toContain("internal");
      expect(service(compose, svc).networks ?? []).not.toContain("edge");
    }
    expect(network(compose, "edge").external).toBe(true); // Dokploy-managed ingress network
  });

  it("attaches the worker to the optional observability bridge network", () => {
    expect(service(compose, "worker").networks).toContain("observability");
    // The app owns the network so it starts without the optional trace stack;
    // deploy/observability joins it as an external network.
    expect(network(compose, "observability").external).not.toBe(true);
    expect(network(compose, "observability").name).toBe("${OBSERVABILITY_NETWORK:-ai-pr-reviewer_observability}");
  });

  it("hardens the public-facing container (read-only rootfs, tmpfs)", () => {
    expect(service(compose, "probot").read_only).toBe(true);
    expect(service(compose, "probot").tmpfs.join(" ")).toContain("/tmp");
  });

  it("pins production image versions (no floating tags)", () => {
    expect(service(compose, "postgres").image).toMatch(/^postgres:\d+\.\d+-alpine$/);
    expect(service(compose, "redis").image).toMatch(/^redis:\d+\.\d+-alpine$/);
  });
});
