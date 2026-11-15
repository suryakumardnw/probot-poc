import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { z } from "zod";
import { getPath, setPath } from "../shared/object-path.js";
import type { ReviewConfig } from "./review-schema.js";
import { CURRENT_SCHEMA_VERSION, reviewConfigSchema } from "./review-schema.js";

export { getPath, setPath } from "../shared/object-path.js";

/**
 * Central configuration loader (ARCHITECTURE.md §11.2, §11.4, §3.2).
 *
 * Resolution flow:
 *   1. Read review.json (strict JSON).
 *   2. Reject embedded secrets (secrets live in env vars only).
 *   3. Resolve ${ENV_VAR} / ${ENV_VAR:-default} references.
 *   4. Check schemaVersion and validate strictly (no unknown keys).
 *   5. Resolve repository overrides (allowlisted sections only).
 *   6. Apply mandatory security policies (overrides cannot weaken them).
 *   7. Produce the effective configuration + immutable snapshot.
 *
 * Last-known-good protection: an invalid review.json never replaces the
 * active configuration. When loading fails and a validated last-known-good
 * snapshot exists on disk, that snapshot is returned and flagged.
 */

export const LAST_KNOWN_GOOD_SUFFIX = ".last-known-good.json";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

export class MissingEnvVarError extends ConfigValidationError {
  readonly variable: string;
  constructor(variable: string, at: string) {
    super(`Environment variable '${variable}' referenced at '${at}' is not set`);
    this.variable = variable;
  }
}

export class EmbeddedSecretError extends ConfigValidationError {
  constructor(path: string) {
    super(
      `Configuration property '${path}' appears to contain an embedded secret. ` +
        `Secrets must be provided through environment variables (e.g. provider.apiKeyEnv: "MODEL_API_KEY") and never stored in review.json.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Secret hygiene
// ---------------------------------------------------------------------------

/** Keys whose values must never appear in review.json. */
const FORBIDDEN_SECRET_KEYS = new Set([
  "apikey",
  "api_key",
  "apisecret",
  "api_secret",
  "secret",
  "password",
  "passwd",
  "token",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "privatekey",
  "private_key",
  "clientsecret",
  "client_secret",
  "webhooksecret",
  "webhook_secret",
  "credentials",
  "authorization",
  "cookie",
]);

/**
 * Reject any property that looks like it carries a secret value. Values are
 * never read into memory for reporting — only the property path is.
 */
export function checkForEmbeddedSecrets(value: unknown, path = ""): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => checkForEmbeddedSecrets(item, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      if (FORBIDDEN_SECRET_KEYS.has(key.toLowerCase()) && typeof child === "string" && child.length > 0) {
        throw new EmbeddedSecretError(childPath);
      }
      // Ignore env-var *references* (${VAR}) — they are not secrets.
      if (
        FORBIDDEN_SECRET_KEYS.has(key.toLowerCase()) &&
        typeof child !== "undefined" &&
        child !== null &&
        typeof child !== "string"
      ) {
        throw new EmbeddedSecretError(childPath);
      }
      checkForEmbeddedSecrets(child, childPath);
    }
  }
}

/**
 * Deep-clone a configuration with secret-adjacent fields redacted so the
 * result is safe to print (dry-run output, logs, API responses).
 */
const REDACTED = "[REDACTED]";

const SECRET_DISPLAY_KEYS = /(api[_-]?key|secret|token|password|credential|authorization|cookie)/i;

export function redactConfiguration<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => redactConfiguration(item)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_DISPLAY_KEYS.test(key) ? REDACTED : redactConfiguration(child);
    }
    return out as unknown as T;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Environment variable resolution
// ---------------------------------------------------------------------------

const ENV_TEMPLATE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * Resolve `${VAR}` (required) and `${VAR:-default}` (optional) references in
 * every string of the configuration. A missing variable without a default
 * produces a clear error naming the variable and its location.
 */
export function resolveEnvReferences(value: unknown, env: NodeJS.ProcessEnv, path = ""): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => resolveEnvReferences(item, env, `${path}[${index}]`));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = resolveEnvReferences(child, env, path ? `${path}.${key}` : key);
    }
    return out;
  }
  if (typeof value !== "string") {
    return value;
  }
  return value.replace(ENV_TEMPLATE, (match, variable: string, fallback?: string) => {
    const resolved = env[variable];
    if (typeof resolved === "string" && resolved.length > 0) {
      return resolved;
    }
    if (match.includes(":-") && fallback !== undefined) {
      return fallback;
    }
    throw new MissingEnvVarError(variable, path);
  });
}

// ---------------------------------------------------------------------------
// Mandatory security constraints vs. configurable preferences
// ---------------------------------------------------------------------------

/**
 * Mandatory security constraints. These application-level policies are
 * applied to every effective configuration AFTER repository overrides, so a
 * repository can never weaken them. They are intentionally NOT configurable
 * preferences:
 *
 * | Path                                    | Policy              | Rationale |
 * | --------------------------------------- | ------------------- | --------- |
 * | execution.sandbox.runAsNonRoot          | true (locked)       | Repository-controlled execution must never run as root. |
 * | provider.failurePolicy                  | fail-immediately    | The provider must never silently fail over or retry into a different model. |
 * | review.confidence.minimumInline         | >= 0.5 (floor)      | Inline publishing must stay above a minimum confidence bar. |
 * | review.confidence.minimumVerified       | >= 0.5 (floor)      | Verification must stay above a minimum confidence bar. |
 */
export const MANDATORY_SECURITY_POLICIES = Object.freeze({
  locked: Object.freeze({
    "execution.sandbox.runAsNonRoot": true,
    "provider.failurePolicy": "fail-immediately",
  }),
  floors: Object.freeze({
    "review.confidence.minimumInline": 0.5,
    "review.confidence.minimumVerified": 0.5,
  }),
}) as {
  locked: { "execution.sandbox.runAsNonRoot": boolean; "provider.failurePolicy": "fail-immediately" };
  floors: { "review.confidence.minimumInline": number; "review.confidence.minimumVerified": number };
};

/**
 * Force mandatory security policies onto an (effective) configuration.
 * Runs after repository overrides so they can never be weakened.
 */
export function applyMandatorySecurityPolicies(config: ReviewConfig): ReviewConfig {
  for (const [path, value] of Object.entries(MANDATORY_SECURITY_POLICIES.locked)) {
    setPath(config, path, value);
  }
  for (const [path, floor] of Object.entries(MANDATORY_SECURITY_POLICIES.floors)) {
    const current = getPath(config, path);
    if (typeof current === "number" && current < floor) {
      setPath(config, path, floor);
    }
  }
  return config;
}

// ---------------------------------------------------------------------------
// Repository overrides (§11.3)
// ---------------------------------------------------------------------------

export type RepositoryOverrides = Record<string, unknown>;

/**
 * Validate the allowlist itself: entries must be dot-paths that exist in the
 * base configuration and must not target (or overlap) a mandatory security
 * path.
 */
export function validateAllowedSections(allowedSections: string[], baseConfig: ReviewConfig): void {
  const mandatoryPaths = [
    ...Object.keys(MANDATORY_SECURITY_POLICIES.locked),
    ...Object.keys(MANDATORY_SECURITY_POLICIES.floors),
  ];
  for (const section of allowedSections) {
    if (getPath(baseConfig, section) === undefined) {
      throw new ConfigValidationError(
        `repositoryOverrides.allowedSections: '${section}' is not a known configuration section`,
      );
    }
    for (const mandatory of mandatoryPaths) {
      if (section === mandatory || mandatory.startsWith(`${section}.`)) {
        throw new ConfigValidationError(
          `repositoryOverrides.allowedSections: '${section}' overlaps mandatory security policy '${mandatory}' and cannot be overridable`,
        );
      }
    }
  }
}

function deepMerge(target: unknown, patch: unknown): unknown {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    return patch;
  }
  if (target === null || typeof target !== "object" || Array.isArray(target)) {
    return deepMerge({}, patch);
  }
  const out: Record<string, unknown> = { ...(target as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = deepMerge(out[key], value);
  }
  return out;
}

/**
 * Resolve repository-provided overrides against the base configuration.
 * Only sections listed in `configuration.repositoryOverrides.allowedSections`
 * may be overridden (exact section or a nested path beneath it). Everything
 * else is rejected with a clear error. Overrides are then re-validated
 * strictly and mandatory security policies are re-applied.
 */
export function resolveRepositoryOverrides(
  baseConfig: ReviewConfig,
  overrides: RepositoryOverrides,
  options: { env: NodeJS.ProcessEnv } = { env: process.env },
): ReviewConfig {
  const allowed = baseConfig.configuration.repositoryOverrides.allowedSections;
  if (!baseConfig.configuration.repositoryOverrides.enabled) {
    if (Object.keys(overrides).length > 0) {
      throw new ConfigValidationError("repositoryOverrides are disabled but overrides were supplied");
    }
    return structuredClone(baseConfig);
  }

  validateAllowedSections(allowed, baseConfig);

  const patched: Record<string, unknown> = structuredClone(baseConfig) as unknown as Record<string, unknown>;
  for (const [path, patch] of Object.entries(overrides)) {
    const allowedBy = allowed.find((section) => path === section || path.startsWith(`${section}.`));
    if (!allowedBy) {
      throw new ConfigValidationError(
        `Repository override at '${path}' is not permitted. Allowed sections: ${allowed.join(", ")}`,
      );
    }
    const envResolved = resolveEnvReferences(patch, options.env, path);
    setPath(patched, path, deepMerge(getPath(patched, path), envResolved));
  }

  const validated = validateRawConfig(patched);
  return applyMandatorySecurityPolicies(validated);
}

// ---------------------------------------------------------------------------
// Validation + snapshots
// ---------------------------------------------------------------------------

export function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  - ${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("\n");
}

/** Validate a parsed configuration object strictly. Throws with useful details. */
export function validateRawConfig(raw: unknown): ReviewConfig {
  // Allow editor-only metadata keys (e.g. "$schema") that are not part of the
  // configuration itself.
  const candidate =
    raw !== null && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : raw;
  if (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)) {
    delete (candidate as Record<string, unknown>).$schema;
  }
  const parsed = reviewConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new ConfigValidationError(`Invalid review configuration:\n${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}

export interface ConfigurationSnapshot {
  schemaVersion: number;
  hash: string;
  capturedAt: string;
  configuration: ReviewConfig;
}

/** Create an immutable, hash-stamped snapshot of a configuration. */
export function createConfigurationSnapshot(config: ReviewConfig): ConfigurationSnapshot {
  const serialized = JSON.stringify(config);
  return {
    schemaVersion: config.schemaVersion,
    hash: `sha256:${createHash("sha256").update(serialized).digest("hex")}`,
    capturedAt: new Date().toISOString(),
    configuration: Object.freeze(structuredClone(config)),
  };
}

// ---------------------------------------------------------------------------
// File loading, atomic updates, last-known-good protection
// ---------------------------------------------------------------------------

export interface LoadReviewConfigOptions {
  env?: NodeJS.ProcessEnv;
  /** Write the loaded (validated) configuration as the new last-known-good. */
  updateLastKnownGood?: boolean;
  /** Allow falling back to the last-known-good file when review.json is invalid. */
  allowLastKnownGoodFallback?: boolean;
}

export interface LoadedConfiguration {
  config: ReviewConfig;
  /** Path the configuration was loaded from. */
  path: string;
  /** True when review.json was invalid and the last-known-good was used. */
  fromLastKnownGood: boolean;
  snapshot: ConfigurationSnapshot;
}

function readJsonFile(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new ConfigValidationError(`Cannot read configuration file '${path}': ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigValidationError(`Configuration file '${path}' is not valid JSON: ${(error as Error).message}`);
  }
  return parsed;
}

function atomicWriteFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, contents, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path); // atomic on POSIX
}

function lkgPathFor(path: string): string {
  return resolve(path + LAST_KNOWN_GOOD_SUFFIX);
}

/**
 * Load, resolve and validate review.json. Never activates an invalid
 * configuration: if review.json fails validation and a validated
 * last-known-good snapshot exists, the snapshot is returned and flagged.
 */
export function loadReviewConfig(path: string, options: LoadReviewConfigOptions = {}): LoadedConfiguration {
  const env = options.env ?? process.env;
  const allowFallback = options.allowLastKnownGoodFallback ?? true;

  let config: ReviewConfig;
  try {
    const raw = readJsonFile(path);
    checkForEmbeddedSecrets(raw);
    const resolved = resolveEnvReferences(raw, env);
    config = validateRawConfig(resolved);
    config = applyMandatorySecurityPolicies(config);
  } catch (error) {
    if (!allowFallback) {
      throw error;
    }
    const lkgPath = lkgPathFor(path);
    let lkg: ReviewConfig | null = null;
    try {
      const raw = readJsonFile(lkgPath);
      checkForEmbeddedSecrets(raw);
      lkg = validateRawConfig(raw);
    } catch {
      lkg = null;
    }
    if (!lkg) {
      throw error instanceof ConfigValidationError
        ? error
        : new ConfigValidationError(`Invalid review configuration: ${(error as Error).message}`);
    }
    const snapshot = createConfigurationSnapshot(lkg);
    return {
      config: lkg,
      path: lkgPath,
      fromLastKnownGood: true,
      snapshot,
    };
  }

  if (options.updateLastKnownGood) {
    atomicWriteFile(lkgPathFor(path), JSON.stringify(config, null, 2));
  }

  return {
    config,
    path,
    fromLastKnownGood: false,
    snapshot: createConfigurationSnapshot(config),
  };
}

/**
 * Restore the last-known-good snapshot as the active configuration. Unlike
 * updateReviewConfig this does NOT require the current review.json to be
 * valid — restoring from a validated snapshot is exactly how a broken active
 * file is repaired. Throws ConfigValidationError when the snapshot itself
 * cannot be validated.
 */
export function restoreLastKnownGood(path: string): LoadedConfiguration {
  const lkgPath = lkgPathFor(path);
  const raw = readJsonFile(lkgPath);
  checkForEmbeddedSecrets(raw);
  const config = applyMandatorySecurityPolicies(validateRawConfig(raw));
  atomicWriteFile(path, JSON.stringify(config, null, 2));
  return { config, path, fromLastKnownGood: false, snapshot: createConfigurationSnapshot(config) };
}

export interface UpdateReviewConfigOptions {
  env?: NodeJS.ProcessEnv;
  overrides?: RepositoryOverrides;
}

export interface UpdateReviewConfigResult {
  previous: LoadedConfiguration;
  next: LoadedConfiguration;
}

/**
 * Atomically replace the active configuration after strict validation.
 * An invalid candidate never touches review.json or the last-known-good
 * file: validation happens before any write.
 */
export function updateReviewConfig(
  path: string,
  candidate: unknown,
  options: UpdateReviewConfigOptions = {},
): UpdateReviewConfigResult {
  const env = options.env ?? process.env;

  // 1. Validate the candidate fully (no writes before this succeeds).
  checkForEmbeddedSecrets(candidate);
  const resolved = resolveEnvReferences(candidate, env);
  let nextConfig = validateRawConfig(resolved);

  // 2. Optional repository override resolution against the candidate.
  if (options.overrides) {
    nextConfig = resolveRepositoryOverrides(nextConfig, options.overrides, { env });
  } else {
    nextConfig = applyMandatorySecurityPolicies(nextConfig);
  }

  // 3. Load the previous configuration (for the caller's audit trail). If the
  //    current file is invalid we still refuse the update: a broken active
  //    file must be repaired, not silently overwritten.
  const previous = loadReviewConfig(path, { env, allowLastKnownGoodFallback: false });

  // 4. Atomic writes: candidate first, then last-known-good.
  const serialized = JSON.stringify(nextConfig, null, 2);
  atomicWriteFile(path, serialized);
  atomicWriteFile(lkgPathFor(path), serialized);

  const next = loadReviewConfig(path, { env, updateLastKnownGood: false });
  return { previous, next };
}

/** Default path of the central configuration. */
export const DEFAULT_CONFIG_PATH = resolve(process.cwd(), "config", "review.json");

export { CURRENT_SCHEMA_VERSION };
