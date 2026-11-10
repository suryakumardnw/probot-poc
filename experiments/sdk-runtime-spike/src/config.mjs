/**
 * Phase 0 spike configuration helpers.
 *
 * Loads the repository `.env` WITHOUT logging values, builds the inline
 * OpenCode SDK configuration (no config file is written), and exposes the
 * permission ruleset under test. This is throwaway spike code.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const SPIKE_ROOT = path.resolve(here, "..");
export const REPO_ROOT = path.resolve(SPIKE_ROOT, "../..");
export const WORK_ROOT = path.join(SPIKE_ROOT, ".work");

export const ENV_KEYS = ["MODEL_BASE_URL", "MODEL_NAME", "MODEL_API_KEY"];

/** Parse a dotenv file into an object. Never call console.log on the result. */
export function loadDotEnv(file = path.join(REPO_ROOT, ".env")) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    let key = line.slice(0, eq).trim();
    if (key.startsWith("export ")) key = key.slice(7).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Resolve provider env. In offline mode placeholders are used so host/config
 * lifecycle can be exercised without credentials. In real mode all keys are
 * mandatory (exit code 3 when missing).
 */
export function resolveProviderEnv({ offline }) {
  const dotenv = loadDotEnv();
  const env = {};
  for (const key of ENV_KEYS) {
    const value = process.env[key] ?? dotenv[key];
    if (value !== undefined && value !== "") env[key] = value;
  }

  if (offline) {
    env.MODEL_BASE_URL ??= "http://127.0.0.1:9/v1";
    env.MODEL_NAME ??= "offline-placeholder";
    env.MODEL_API_KEY ??= "offline-placeholder";
    return { env, missing: [], source: "offline" };
  }

  const missing = ENV_KEYS.filter((key) => !env[key]);
  return { env, missing, source: missing.length ? "missing" : "env" };
}

/** Values that must never appear in console output or result files. */
export function secretValues(env) {
  const values = new Set();
  // Only the API key is a secret. Base URL and model identifier are safe.
  if (env.MODEL_API_KEY) values.add(env.MODEL_API_KEY);
  // Fake secrets created by the spike itself.
  values.add("SPIKE_FAKE_SECRET_DO_NOT_READ");
  values.add("OUTSIDE_SECRET_DO_NOT_READ");
  return [...values].sort((a, b) => b.length - a.length);
}

/** Scrub known secret values from a string. */
export function scrub(text, secrets) {
  let out = String(text ?? "");
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("[REDACTED]");
  }
  // Defensive: redact common key-shaped tokens even if they were not loaded.
  out = out.replace(/(sk-[A-Za-z0-9_-]{8,})/g, "[REDACTED]");
  return out;
}

/** Recursively scrub strings in a JSON-able value. */
export function scrubDeep(value, secrets) {
  if (typeof value === "string") return scrub(value, secrets);
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item, secrets));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = scrubDeep(item, secrets);
    return out;
  }
  return value;
}

/**
 * Ordered permission rules for SDK v2.2.7 (array shape). Last matching rule
 * wins. Deny everything, then re-allow read-only workspace actions, then deny
 * secret reads and all external-directory access.
 *
 * Note the wildcard matcher is anchored (`*` -> `.*`), so `*.env` also matches
 * bare `.env` and any path ending in `.env`.
 */
export function buildPermissionRules() {
  return [
    { action: "*", resource: "*", effect: "deny" },
    { action: "*", resource: "*/*", effect: "deny" },
    { action: "read", resource: "*", effect: "allow" },
    { action: "read", resource: "*.env", effect: "deny" },
    { action: "read", resource: "*.env.*", effect: "deny" },
    { action: "read", resource: "*credential*", effect: "deny" },
    { action: "read", resource: "*credentials*", effect: "deny" },
    { action: "read", resource: ".git-credentials", effect: "deny" },
    { action: "grep", resource: "*", effect: "allow" },
    { action: "glob", resource: "*", effect: "allow" },
    { action: "external_directory", resource: "*", effect: "deny" },
  ];
}

export const PROVIDER_ID = "reviewer";
export const MODEL_KEY = "glm";
export const MODEL_REF = { providerID: PROVIDER_ID, id: MODEL_KEY };
export const PROVIDER_PACKAGE = "@opencode/ai/providers/openai-compatible";

/** Build the inline SDK config (serialized as `config.content`). */
export function buildInlineConfig(env, { timeoutMs = 300_000 } = {}) {
  return {
    $schema: "https://opencode.ai/config.json",
    model: `${PROVIDER_ID}/${MODEL_KEY}`,
    update: "disable",
    share: "disabled",
    snapshots: false,
    permissions: buildPermissionRules(),
    providers: {
      [PROVIDER_ID]: {
        name: "Review Model Provider (spike)",
        env: ["MODEL_API_KEY"],
        package: PROVIDER_PACKAGE,
        settings: {
          baseURL: env.MODEL_BASE_URL,
          apiKey: "{env:MODEL_API_KEY}",
          timeout: timeoutMs,
        },
        models: {
          [MODEL_KEY]: {
            name: env.MODEL_NAME,
            modelID: env.MODEL_NAME,
            limit: { context: 128_000, output: 4_096 },
          },
        },
      },
    },
  };
}

/** Non-secret description of the provider config for the results file. */
export function describeProvider(env) {
  let host = "";
  try {
    host = new URL(env.MODEL_BASE_URL).host;
  } catch {
    host = "invalid-url";
  }
  return {
    providerID: PROVIDER_ID,
    modelKey: MODEL_KEY,
    package: PROVIDER_PACKAGE,
    baseUrlHost: host,
    modelName: env.MODEL_NAME,
    apiKeyEnvVar: "MODEL_API_KEY",
    apiKeyPresent: Boolean(env.MODEL_API_KEY),
  };
}

/** Structural validation of the permission ruleset (offline check). */
export function validatePermissionConfig(rules) {
  const problems = [];
  if (!Array.isArray(rules) || rules.length === 0) problems.push("permissions must be a non-empty array");
  for (const [index, rule] of rules.entries()) {
    if (!rule || typeof rule !== "object") problems.push(`rule ${index} is not an object`);
    else {
      if (typeof rule.action !== "string" || !rule.action) problems.push(`rule ${index} has no action`);
      if (typeof rule.resource !== "string" || !rule.resource) problems.push(`rule ${index} has no resource`);
      if (!["allow", "deny", "ask"].includes(rule.effect)) problems.push(`rule ${index} has invalid effect`);
    }
  }
  const has = (action, resource, effect) =>
    rules.some((r) => r.action === action && r.resource === resource && r.effect === effect);
  if (!has("*", "*", "deny")) problems.push("missing catch-all deny");
  if (!has("external_directory", "*", "deny")) problems.push("missing external_directory deny");
  if (!has("read", "*.env", "deny")) problems.push("missing .env read deny");
  if (!has("read", "*", "allow")) problems.push("missing read allow");
  if (!has("grep", "*", "allow")) problems.push("missing grep allow");
  if (!has("glob", "*", "allow")) problems.push("missing glob allow");

  // Last-match-wins sanity check using the SDK's anchored wildcard semantics.
  const toRegExp = (pattern) =>
    new RegExp(
      "^" + pattern.replaceAll("\\", "/").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
      "s",
    );
  const decide = (action, resource) => {
    let result = { action, resource: "*", effect: "ask" };
    for (const rule of rules) {
      if (toRegExp(rule.action).test(action) && toRegExp(rule.resource).test(resource)) result = rule;
    }
    return result.effect;
  };
  const expectations = [
    ["read", "README.md", "allow"],
    ["read", "src/app.js", "allow"],
    ["read", ".env", "deny"],
    ["read", "config/prod.env", "deny"],
    ["grep", "src/app.js", "allow"],
    ["glob", "src", "allow"],
    ["edit", "src/app.js", "deny"],
    ["write", "pwned.txt", "deny"],
    ["shell", "rm src/app.js", "deny"],
    ["external_directory", "/tmp/outside", "deny"],
  ];
  const evaluated = expectations.map(([action, resource, expected]) => {
    const actual = decide(action, resource);
    if (actual !== expected) problems.push(`expected ${action} ${resource} -> ${expected}, got ${actual}`);
    return { action, resource, expected, actual };
  });
  return { ok: problems.length === 0, problems, evaluated };
}
