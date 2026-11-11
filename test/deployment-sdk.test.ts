/**
 * Phase 1 — experimental SDK worker deployment validation
 * (deploy/docker-compose.sdk.yml, deploy/sdk/*).
 *
 * This stack is a SEPARATE, NON-PRODUCTION unit. These static assertions keep
 * that true: it must not couple to the production compose stack, publish host
 * ports, receive secrets, mount the Docker socket, or drop any of the container
 * hardening that the Phase 1 probe relies on.
 *
 * Parsed with the `yaml` package (raw file, no compose interpolation).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const sdkDir = path.resolve(__dirname, "../deploy/sdk");
const composePath = path.resolve(__dirname, "../deploy/docker-compose.sdk.yml");
const composeRaw = readFileSync(composePath, "utf8");
const compose = parse(composeRaw, { merge: true }) as {
  name: string;
  services: Record<string, any>;
  volumes: Record<string, unknown>;
  networks: Record<string, any>;
};

const dockerfilePath = path.join(sdkDir, "Dockerfile");
const dockerfile = readFileSync(dockerfilePath, "utf8");

// Comments explain the security model and deliberately mention forbidden
// things (e.g. "no Docker socket"). Assertions inspect effective content only.
const composeCode = composeRaw
  .split("\n")
  .map((line) => line.replace(/(^|\s)#.*$/, ""))
  .join("\n");
const dockerfileCode = dockerfile
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n");
const packageJson = JSON.parse(readFileSync(path.join(sdkDir, "package.json"), "utf8")) as {
  private?: boolean;
  type?: string;
  engines?: Record<string, string>;
  dependencies?: Record<string, string>;
};

const SERVICES = ["sdk-isolation-probe", "sdk-worker"];

const FORBIDDEN_ENV = [
  /GITHUB/,
  /APP_ID/,
  /WEBHOOK_SECRET/,
  /PRIVATE_KEY/,
  /DATABASE_URL/,
  /POSTGRES/,
  /REDIS/,
  /AWS_/,
  /OPENAI_API_KEY/,
  /MODEL_API_KEY/,
  /ANTHROPIC/,
];

describe("SDK worker compose structure (Phase 1, non-production)", () => {
  it("is its own project with exactly the worker and one-shot probe", () => {
    expect(compose.name).toBe("ai-pr-reviewer-sdk");
    expect(Object.keys(compose.services).sort()).toEqual(SERVICES);
  });

  it("publishes NO host ports; the worker only exposes 8081 internally", () => {
    for (const svc of SERVICES) {
      expect("ports" in compose.services[svc], `${svc} has no ports key`).toBe(false);
    }
    expect(compose.services["sdk-worker"].expose).toEqual(["8081"]);
    expect(compose.services["sdk-isolation-probe"].expose).toBeUndefined();
  });

  it("uses no env_file and passes only non-secret environment values", () => {
    for (const svc of SERVICES) {
      expect(compose.services[svc].env_file, `${svc} has no env_file`).toBeUndefined();
      const env = compose.services[svc].environment as Record<string, string>;
      for (const [key, value] of Object.entries(env)) {
        expect(FORBIDDEN_ENV.some((pattern) => pattern.test(key)), `${svc} env key ${key}`).toBe(false);
        expect(value, `${svc} env value for ${key} is literal`).not.toMatch(/\$\{/);
      }
      expect(Object.keys(env).sort()).toEqual(["LOG_LEVEL", "NODE_ENV", "SDK_WORKER_PORT"]);
    }
    expect(composeCode).not.toMatch(/\$\{/);
    expect(composeCode).not.toMatch(/env_file/);
  });

  it("never mounts the Docker socket", () => {
    expect(composeRaw.includes("docker.sock")).toBe(false);
    for (const svc of SERVICES) {
      for (const volume of compose.services[svc].volumes ?? []) {
        const target = typeof volume === "string" ? volume.split(":")[1] : volume.target;
        expect(target, `${svc} target ${target}`).not.toContain("docker.sock");
      }
    }
  });

  it("has exactly one internal-only network and both services use only it", () => {
    expect(Object.keys(compose.networks)).toEqual(["sdk-internal"]);
    expect(compose.networks["sdk-internal"].internal).toBe(true);
    for (const svc of SERVICES) {
      expect(compose.services[svc].networks).toEqual(["sdk-internal"]);
    }
  });

  it("applies the same container hardening to the worker and the probe", () => {
    for (const svc of SERVICES) {
      const service = compose.services[svc];
      expect(service.read_only, `${svc} read_only`).toBe(true);
      expect(service.cap_drop, `${svc} cap_drop`).toContain("ALL");
      expect("cap_add" in service, `${svc} has no cap_add`).toBe(false);
      expect(service.security_opt, `${svc} security_opt`).toContain("no-new-privileges:true");
      expect(String(service.user), `${svc} user`).toBe("1000:1000");
      expect(String(service.user)).not.toMatch(/^(0|root)(:|$)/);
      expect(service.tmpfs.join(" "), `${svc} tmpfs`).toContain("/tmp");
      const limits = service.deploy?.resources?.limits;
      expect(limits, `${svc} limits`).toBeDefined();
      // Compose v5 normalises the top-level `pids_limit` and deploy limits
      // into the same field; assert a 256 PID cap exists either way.
      expect(service.pids_limit ?? limits.pids, `${svc} pids limit`).toBe(256);
      expect(String(limits.cpus)).toBeTruthy();
      expect(String(limits.memory)).toMatch(/^\d+[KMG]$/);
    }
  });

  it("forbids privileged/host-namespace escapes and pins resource guardrails", () => {
    for (const svc of SERVICES) {
      const service = compose.services[svc];
      expect(service.privileged ?? false, `${svc} privileged`).toBe(false);
      expect(service, `${svc} has no network_mode`).not.toHaveProperty("network_mode");
      expect(service, `${svc} has no host pid namespace`).not.toHaveProperty("pid");
      expect(service, `${svc} has no host ipc namespace`).not.toHaveProperty("ipc");
      expect(service, `${svc} has no devices`).not.toHaveProperty("devices");
      expect(service, `${svc} has no volumes_from`).not.toHaveProperty("volumes_from");
      expect(String(service.deploy.resources.limits.cpus), `${svc} cpus`).toBe("1.0");
      expect(String(service.deploy.resources.limits.memory), `${svc} memory`).toBe("1G");
      expect(service.deploy.resources.limits.pids, `${svc} pids`).toBe(256);
    }
  });

  it("health-gates the one-shot probe and marks it disposable", () => {
    const worker = compose.services["sdk-worker"];
    expect(worker.healthcheck.test).toEqual(["CMD", "node", "worker/healthcheck.mjs"]);
    expect(worker.healthcheck.interval).toBe("10s");
    expect(worker.healthcheck.timeout).toBe("5s");
    expect(worker.healthcheck.retries).toBe(5);
    expect(worker.healthcheck.start_period).toBe("15s");

    const probe = compose.services["sdk-isolation-probe"];
    expect(probe.restart).toBe("no");
    expect(probe.profiles).toContain("probe");
    expect(probe.command).toEqual(["node", "worker/isolation-probe.mjs"]);
    expect(probe.depends_on["sdk-worker"].condition).toBe("service_healthy");
  });

  it("mounts only named volumes at /app/workspaces (no bind mounts)", () => {
    expect(compose.volumes).toHaveProperty("sdk-workspaces");
    expect(compose.volumes).toHaveProperty("probe-workspaces");
    for (const svc of SERVICES) {
      const volumes = compose.services[svc].volumes ?? [];
      expect(volumes.length, `${svc} has a workspace volume`).toBe(1);
      for (const volume of volumes) {
        expect(typeof volume, `${svc} volume is a short string`).toBe("string");
        const [source, target] = (volume as string).split(":");
        expect(source, `${svc} volume source is named`).not.toMatch(/^(\/|\.{1,2}\/)/);
        expect(compose.volumes).toHaveProperty(source);
        expect(target, `${svc} volume target`).toBe("/app/workspaces");
      }
    }
    expect(compose.services["sdk-worker"].volumes).toEqual(["sdk-workspaces:/app/workspaces"]);
    expect(compose.services["sdk-isolation-probe"].volumes).toEqual(["probe-workspaces:/app/workspaces"]);
    expect(composeCode).not.toMatch(/type:\s*bind/);
  });

  it("does not couple to the production stack", () => {
    expect(composeCode).not.toContain("docker-compose.yml");
    expect(composeCode).not.toMatch(/postgres/i);
    expect(composeCode).not.toMatch(/redis/i);
    expect(composeCode).not.toContain("deploy/.env");
    expect(composeCode).not.toContain("./.env");
  });
});

describe("SDK worker image (Phase 1, non-production)", () => {
  it("pins Node 24 only for this image", () => {
    expect(dockerfile).toMatch(/^FROM node:24\.0\.0-slim/m);
    expect(dockerfile).not.toMatch(/^FROM node:22/m);
  });

  it("installs only production dependencies from the pinned lockfile", () => {
    expect(dockerfile).toContain("COPY package.json package-lock.json ./");
    expect(dockerfile).toContain("npm ci --omit=dev");
    expect(dockerfile).not.toMatch(/COPY\s+\.env/);
    expect(dockerfile).not.toMatch(/COPY\s+\.\s+\./);
  });

  it("contains no review tooling or CLIs", () => {
    expect(dockerfileCode).not.toMatch(/apt-get\s+install/i);
    expect(dockerfileCode).not.toMatch(/install[^\n]*\bgit\b/i);
    expect(dockerfileCode).not.toMatch(/docker\/docker|docker-\$\{?DOCKER_CLI/);
    expect(dockerfileCode).not.toContain("/usr/local/bin/opencode");
    expect(dockerfileCode).not.toContain("/usr/local/bin/docker");
    expect(dockerfileCode).not.toMatch(/curl[^\n]*opencode/);
    expect(dockerfileCode).not.toMatch(/prisma/i);
  });

  it("runs as non-root node and starts the placeholder worker", () => {
    const users = [...dockerfile.matchAll(/^USER\s+(\S+)\s*$/gm)].map((match) => match[1]);
    expect(users.length).toBeGreaterThan(0);
    expect(users.at(-1)).toBe("node");
    expect(dockerfile).toMatch(/^CMD \["node", "worker\/placeholder-worker\.mjs"\]$/m);
    expect(dockerfile).toContain("USER node");
  });

  it("keeps writable state under /tmp and the workspace mountpoint", () => {
    expect(dockerfileCode).toMatch(/ENV[\s\S]*HOME=\/tmp\/home/);
    expect(dockerfileCode).toMatch(/XDG_CACHE_HOME=\/tmp\/home\/\.cache/);
    expect(dockerfileCode).toMatch(/TMPDIR=\/tmp/);
    expect(dockerfileCode).toContain("/app/workspaces");
  });

  it("declares an exact SDK dependency and Node 24 engine", () => {
    expect(packageJson.private).toBe(true);
    expect(packageJson.type).toBe("module");
    expect(packageJson.dependencies?.["@opencode/sdk"]).toBe("2.2.7");
    expect(packageJson.engines?.node).toBe(">=24");
  });
});
