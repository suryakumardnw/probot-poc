/**
 * Experimental SDK worker deployment validation
 * (deploy/docker-compose.sdk.yml, deploy/sdk/*).
 *
 * Phase 1 proved the offline container boundary. Phase 2b adds a single
 * allowlisted egress path: a dedicated CONNECT proxy is the only service with
 * external connectivity, and the worker/probes stay internal-only.
 *
 * These static assertions keep that true: the stack must not couple to the
 * production compose stack, publish host ports, give the proxy model
 * credentials, mount the Docker socket, or drop any of the container hardening
 * that the probes rely on.
 *
 * Parsed with the `yaml` package (raw file, no compose interpolation).
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
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
const proxyDir = path.join(sdkDir, "proxy");
const proxyDockerfile = readFileSync(path.join(proxyDir, "Dockerfile"), "utf8");
const proxyProxy = readFileSync(path.join(proxyDir, "proxy.mjs"), "utf8");
const sdkDockerignore = readFileSync(path.join(sdkDir, ".dockerignore"), "utf8");
const proxyDockerignore = readFileSync(path.join(proxyDir, ".dockerignore"), "utf8");

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

const SERVICES = [
  "sdk-egress-probe",
  "sdk-egress-proxy",
  "sdk-isolation-probe",
  "sdk-worker",
];
const INTERNAL_NETWORK = "sdk-internal";
const EGRESS_NETWORK = "sdk-egress";

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
  /GLM_API_KEY/,
  /ZHIPU_API_KEY/,
];

/** Services other than the proxy that are attached to the egress network. */
function egressLeaks(stack: { services: Record<string, any> }): string[] {
  return Object.entries(stack.services)
    .filter(([name]) => name !== "sdk-egress-proxy")
    .filter(([, service]) => (service.networks ?? []).includes(EGRESS_NETWORK))
    .map(([name]) => name);
}

describe("SDK worker compose structure (Phase 2b, non-production)", () => {
  it("is its own project with the worker, proxy and two one-shot probes", () => {
    expect(compose.name).toBe("ai-pr-reviewer-sdk");
    expect(Object.keys(compose.services).sort()).toEqual(SERVICES);
  });

  it("publishes NO host ports", () => {
    for (const svc of SERVICES) {
      expect("ports" in compose.services[svc], `${svc} has no ports key`).toBe(false);
    }
    expect(compose.services["sdk-worker"].expose).toEqual(["8081"]);
    expect(compose.services["sdk-isolation-probe"].expose).toBeUndefined();
    expect(compose.services["sdk-egress-probe"].expose).toBeUndefined();
    // The proxy may only expose its CONNECT and health ports internally.
    expect(compose.services["sdk-egress-proxy"].expose).toEqual(["3128", "3129"]);
  });

  it("the proxy is the ONLY service on the egress network; everyone else is internal-only", () => {
    expect(Object.keys(compose.networks).sort()).toEqual([EGRESS_NETWORK, INTERNAL_NETWORK]);
    expect(compose.networks[INTERNAL_NETWORK].internal).toBe(true);
    expect(compose.networks[EGRESS_NETWORK].internal).toBeFalsy();

    expect(compose.services["sdk-egress-proxy"].networks).toEqual([
      INTERNAL_NETWORK,
      EGRESS_NETWORK,
    ]);
    for (const svc of SERVICES.filter((name) => name !== "sdk-egress-proxy")) {
      expect(compose.services[svc].networks, `${svc} networks`).toEqual([INTERNAL_NETWORK]);
    }
    expect(egressLeaks(compose)).toEqual([]);
  });

  it("gives model credentials to sdk-worker only, via the dedicated SDK env file", () => {
    expect(compose.services["sdk-worker"].env_file).toEqual(["./sdk/.env"]);
    for (const svc of SERVICES.filter((name) => name !== "sdk-worker")) {
      expect(compose.services[svc].env_file, `${svc} has no env_file`).toBeUndefined();
    }
    // The proxy must never receive a model credential or endpoint.
    const proxyEnv = compose.services["sdk-egress-proxy"].environment as Record<string, string>;
    expect(Object.keys(proxyEnv).sort()).toEqual(["MODEL_ALLOWED_HOST", "NODE_ENV"]);
    expect(JSON.stringify(proxyEnv)).not.toMatch(/MODEL_API_KEY|MODEL_BASE_URL|MODEL_NAME/);

    // The worker environment adds only proxy routing, no GitHub/DB/Redis keys.
    const workerEnv = compose.services["sdk-worker"].environment as Record<string, string>;
    for (const [key] of Object.entries(workerEnv)) {
      expect(
        FORBIDDEN_ENV.some((pattern) => pattern.test(key)),
        `sdk-worker env key ${key}`,
      ).toBe(false);
    }
    expect(Object.keys(workerEnv).sort()).toEqual([
      "LOG_LEVEL",
      "MODEL_ALLOWED_HOST",
      "MODEL_PROXY_URL",
      "NODE_ENV",
      "SDK_WORKER_PORT",
    ]);
    expect(workerEnv.MODEL_PROXY_URL).toBe("http://sdk-egress-proxy:3128");

    // Only MODEL_ALLOWED_HOST may use compose interpolation.
    for (const [key, value] of Object.entries(workerEnv)) {
      if (key === "MODEL_ALLOWED_HOST") {
        expect(value).toBe("${MODEL_ALLOWED_HOST:-llm.nativewit.app}");
      } else {
        expect(value, `sdk-worker env value for ${key} is literal`).not.toMatch(/\$\{/);
      }
    }
  });

  it("does not reference the root/production env file", () => {
    for (const svc of SERVICES) {
      const envFiles = compose.services[svc].env_file ?? [];
      for (const entry of envFiles) {
        const file = typeof entry === "string" ? entry : entry.path;
        expect(file, `${svc} env_file`).not.toMatch(/^(\.\/)?\.env$/);
        expect(file, `${svc} env_file`).not.toContain("deploy/.env");
      }
    }
    expect(composeCode).not.toContain("deploy/.env");
  });

  it("excludes env files from both build contexts", () => {
    for (const ignore of [sdkDockerignore, proxyDockerignore]) {
      expect(ignore.split("\n").map((line) => line.trim())).toContain(".env");
      expect(ignore.split("\n").map((line) => line.trim())).toContain(".env.*");
    }
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

  it("applies the same container hardening to all four services", () => {
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

  it("health-gates the worker on the proxy and the probes on their dependencies", () => {
    const worker = compose.services["sdk-worker"];
    expect(worker.healthcheck.test).toEqual(["CMD", "node", "worker/healthcheck.mjs"]);
    expect(worker.healthcheck.interval).toBe("10s");
    expect(worker.healthcheck.timeout).toBe("5s");
    expect(worker.healthcheck.retries).toBe(5);
    expect(worker.healthcheck.start_period).toBe("15s");
    expect(worker.depends_on["sdk-egress-proxy"].condition).toBe("service_healthy");

    const proxy = compose.services["sdk-egress-proxy"];
    expect(proxy.healthcheck.test).toEqual(["CMD", "node", "healthcheck.mjs"]);
    expect(proxy.healthcheck.start_period).toBe("10s");

    const isolation = compose.services["sdk-isolation-probe"];
    expect(isolation.restart).toBe("no");
    expect(isolation.profiles).toContain("probe");
    expect(isolation.command).toEqual(["node", "worker/isolation-probe.mjs"]);
    expect(isolation.depends_on["sdk-worker"].condition).toBe("service_healthy");

    const egress = compose.services["sdk-egress-probe"];
    expect(egress.restart).toBe("no");
    expect(egress.profiles).toContain("probe");
    expect(egress.command).toEqual(["node", "worker/proxy-smoke.mjs"]);
    expect(egress.depends_on["sdk-worker"].condition).toBe("service_healthy");
    expect(egress.depends_on["sdk-egress-proxy"].condition).toBe("service_healthy");
  });

  it("mounts only named volumes at /app/workspaces (no bind mounts)", () => {
    expect(compose.volumes).toHaveProperty("sdk-workspaces");
    expect(compose.volumes).toHaveProperty("probe-workspaces");
    for (const svc of ["sdk-worker", "sdk-isolation-probe"]) {
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
    expect(compose.services["sdk-isolation-probe"].volumes).toEqual([
      "probe-workspaces:/app/workspaces",
    ]);
    // No review data is mounted into either proxy or egress probe.
    expect(compose.services["sdk-egress-proxy"].volumes).toBeUndefined();
    expect(compose.services["sdk-egress-probe"].volumes).toBeUndefined();
    expect(composeCode).not.toMatch(/type:\s*bind/);
  });

  it("does not couple to the production stack", () => {
    expect(composeCode).not.toMatch(/docker-compose(?!\.sdk\.yml)\.yml/);
    expect(composeCode).not.toMatch(/postgres/i);
    expect(composeCode).not.toMatch(/redis/i);
    expect(composeCode).not.toContain("deploy/.env");
  });

  it("would fail if the worker were attached to the egress network", () => {
    // Mutation resistance: copy the compose file, leak sdk-worker onto
    // sdk-egress, and confirm the invariant actually detects it.
    const dir = mkdtempSync(path.join(tmpdir(), "sdk-compose-mutation-"));
    const mutatedPath = path.join(dir, "docker-compose.sdk.yml");
    const mutatedRaw = composeRaw.replace(
      /(  sdk-worker:[\s\S]*?    networks:\n      - sdk-internal\n)/,
      "$1      - sdk-egress\n",
    );
    expect(mutatedRaw).not.toBe(composeRaw);
    writeFileSync(mutatedPath, mutatedRaw);
    const mutated = parse(readFileSync(mutatedPath, "utf8"), { merge: true }) as {
      services: Record<string, any>;
    };
    expect(mutated.services["sdk-worker"].networks).toContain(EGRESS_NETWORK);
    expect(egressLeaks(mutated)).toEqual(["sdk-worker"]);
    expect(egressLeaks(mutated)).not.toEqual([]);
  });
});

describe("SDK egress proxy (Phase 2b, non-production)", () => {
  it("pins Node 24, runs non-root and starts the proxy", () => {
    expect(proxyDockerfile).toMatch(/^FROM node:24\.0\.0-slim/m);
    const users = [...proxyDockerfile.matchAll(/^USER\s+(\S+)\s*$/gm)].map((match) => match[1]);
    expect(users.at(-1)).toBe("node");
    expect(proxyDockerfile).toMatch(/^CMD \["node", "proxy\.mjs"\]$/m);
  });

  it("contains no model credentials or secret copying", () => {
    expect(proxyDockerfile).not.toMatch(/COPY\s+\.env/);
    expect(proxyDockerfile).not.toMatch(/MODEL_API_KEY/);
    expect(proxyProxy).not.toMatch(/MODEL_API_KEY|GITHUB_TOKEN|DATABASE_URL/);
    // The proxy logs only {action, host, port} and never payloads/headers.
    expect(proxyProxy).not.toMatch(/req\.headers|rawHeaders|console\.log\(.*payload/i);
  });

  it("parses CONNECT targets and denies everything except the allowlisted host:443", async () => {
    const proxy = (await import(pathToFileURL(path.join(proxyDir, "proxy.mjs")).href)) as {
      parseConnectTarget: (authority: string) => { host: string; port: number } | null;
      isAllowedTarget: (
        target: { host: string; port: number } | null,
        allowedHost?: string,
      ) => boolean;
    };

    expect(proxy.parseConnectTarget("llm.nativewit.app:443")).toEqual({
      host: "llm.nativewit.app",
      port: 443,
    });
    expect(proxy.parseConnectTarget("[2001:db8::1]:443")).toEqual({
      host: "2001:db8::1",
      port: 443,
    });
    expect(proxy.parseConnectTarget("no-port")).toBeNull();
    expect(proxy.parseConnectTarget("host:notaport")).toBeNull();
    expect(proxy.parseConnectTarget("host:0")).toBeNull();
    expect(proxy.parseConnectTarget("")).toBeNull();

    expect(proxy.isAllowedTarget({ host: "llm.nativewit.app", port: 443 })).toBe(true);
    expect(proxy.isAllowedTarget({ host: "LLM.nativewit.app", port: 443 })).toBe(true);
    expect(proxy.isAllowedTarget({ host: "api.github.com", port: 443 })).toBe(false);
    expect(proxy.isAllowedTarget({ host: "llm.nativewit.app", port: 80 })).toBe(false);
    expect(proxy.isAllowedTarget({ host: "evil.llm.nativewit.app", port: 443 })).toBe(false);
    expect(proxy.isAllowedTarget({ host: "llm.nativewit.app.evil.test", port: 443 })).toBe(false);
    expect(proxy.isAllowedTarget(null)).toBe(false);
  });
});

describe("SDK worker image", () => {
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

  it("declares exact SDK and proxy-fetch dependencies and Node 24 engine", () => {
    expect(packageJson.private).toBe(true);
    expect(packageJson.type).toBe("module");
    expect(packageJson.dependencies?.["@opencode/sdk"]).toBe("2.2.7");
    expect(packageJson.dependencies?.undici).toBe("7.30.2");
    expect(packageJson.engines?.node).toBe(">=24");
  });
});
