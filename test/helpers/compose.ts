import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { defined } from "./assert.js";

/**
 * Structural view of the Compose files asserted by the deployment tests.
 *
 * Only the fields the tests inspect are typed; YAML parsing is still the real
 * `yaml` package, so a malformed file fails exactly as before. `service()`
 * narrows the dynamic record lookup instead of leaking `any` through the test.
 *
 * `readComposeFile` asserts the vendor `yaml` result to `ComposeDocument` at
 * the test-fixture boundary: the checked-in Compose file is the fixture, and
 * every later access is narrowed through `service()`/`network()`/`defined`.
 * This is a test-only boundary cast, not a production adapter.
 */
export interface ComposeService {
  image: string;
  command: string[];
  ports?: unknown;
  expose?: string[];
  volumes: Array<string | { source?: string; target?: string }>;
  healthcheck: { test?: unknown };
  deploy: { resources: { limits: { cpus?: string; memory?: string } } };
  profiles?: string[];
  depends_on: Record<string, { condition?: string }>;
  restart?: string;
  stop_grace_period?: string;
  env_file?: string[];
  networks: string[];
  read_only?: boolean;
  tmpfs: string[];
  environment: Record<string, unknown>;
}

export interface ComposeNetwork {
  external?: boolean;
  internal?: boolean;
  name?: string;
}

export interface ComposeDocument {
  services: Record<string, ComposeService>;
  volumes: Record<string, unknown>;
  networks: Record<string, ComposeNetwork>;
  secrets?: unknown;
}

export function readComposeFile(path: string): ComposeDocument {
  return parse(readFileSync(path, "utf8"), { merge: true }) as ComposeDocument;
}

export function service(document: ComposeDocument, name: string): ComposeService {
  return defined(document.services[name], `compose service ${name}`);
}

export function network(document: ComposeDocument, name: string): ComposeNetwork {
  return defined(document.networks[name], `compose network ${name}`);
}
