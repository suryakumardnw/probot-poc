/**
 * Inline OpenCode SDK configuration builder for the Phase 2a runtime adapter.
 *
 * The SDK host accepts configuration inline (`config.content`, verified with
 * `@opencode/sdk@2.2.7` in Phase 0), so no config file is written to disk. The
 * provider credential is always an `{env:NAME}` reference — the key value is
 * resolved by the embedded host from `process.env` and never serialized here.
 *
 * Permissions use the v2.2.7 ordered array shape: the last matching rule wins.
 * Deny-by-default, then re-allow only the read-only actions mapped from the
 * central tools allowlist, then deny secret paths and external directories.
 */

import {
  TOOL_ACTION_MAP,
  resolveModelId,
  type AgentRuntimeConfigSource,
} from "../opencode-config.js";

export const SDK_PROVIDER_ID = "reviewer";
export const SDK_MODEL_KEY = "glm";
export const SDK_PROVIDER_PACKAGE = "@opencode/ai/providers/openai-compatible";

export type SdkPermissionEffect = "allow" | "deny" | "ask";

export interface SdkPermissionRule {
  action: string;
  resource: string;
  effect: SdkPermissionEffect;
}

/** Actions the adapter is willing to allow from the tools allowlist. */
const READ_ONLY_ACTIONS = new Set(["read", "grep", "glob"]);

/**
 * Build the ordered permission array for the SDK host. Last matching rule wins
 * (verified anchored-wildcard semantics: `*` -> `.*`).
 */
export function buildSdkPermissions(config: AgentRuntimeConfigSource): SdkPermissionRule[] {
  const rules: SdkPermissionRule[] = [
    // 1. Deny every action/resource by default. Both catch-alls are needed:
    //    `*/*` requires a slash, so bare resource names only match `*`.
    { action: "*", resource: "*", effect: "deny" },
    { action: "*", resource: "*/*", effect: "deny" },
  ];

  // 2. Re-allow only read-only actions mapped from the tools allowlist.
  if (config.agent.tools.permissionPolicy === "allowlist") {
    const actions = new Set<string>();
    for (const tool of config.agent.tools.enabled) {
      const action = TOOL_ACTION_MAP[tool];
      if (action && READ_ONLY_ACTIONS.has(action)) actions.add(action);
    }
    for (const action of ["read", "grep", "glob"]) {
      if (actions.has(action)) {
        rules.push({ action, resource: "*", effect: "allow" });
      }
    }
  }

  // 3. Secret paths are denied even if reads were allowed above.
  rules.push(
    { action: "read", resource: ".env", effect: "deny" },
    { action: "read", resource: "*.env", effect: "deny" },
    { action: "read", resource: "*.env.*", effect: "deny" },
    { action: "read", resource: "*credential*", effect: "deny" },
    { action: "read", resource: "*credentials*", effect: "deny" },
    { action: "read", resource: ".git-credentials", effect: "deny" },
  );

  // 4. Confine the agent to the review workspace.
  rules.push({ action: "external_directory", resource: "*", effect: "deny" });

  return rules;
}

/** Compile an SDK permission glob to an anchored RegExp (v2.2.7 semantics). */
function toRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "s");
}

/**
 * Evaluate the ordered rules the same way the SDK does: scan in order and keep
 * the last rule whose action and resource patterns both match.
 */
export function evaluateSdkPermission(
  rules: readonly SdkPermissionRule[],
  action: string,
  resource: string,
): SdkPermissionEffect {
  let result: SdkPermissionEffect = "ask";
  for (const rule of rules) {
    if (toRegExp(rule.action).test(action) && toRegExp(rule.resource).test(resource)) {
      result = rule.effect;
    }
  }
  return result;
}

export interface SdkPermissionValidation {
  ok: boolean;
  problems: string[];
  evaluated: Array<{
    action: string;
    resource: string;
    expected: SdkPermissionEffect;
    actual: SdkPermissionEffect;
  }>;
}

/**
 * Structural + behavioral validation of a permission ruleset. Used by unit
 * tests and available for a future pre-flight config check.
 */
export function validateSdkPermissions(
  rules: readonly SdkPermissionRule[],
  options: { requireReadAccess?: boolean } = {},
): SdkPermissionValidation {
  const problems: string[] = [];

  if (!Array.isArray(rules) || rules.length === 0) {
    problems.push("permissions must be a non-empty array");
  }
  for (const [index, rule] of (rules ?? []).entries()) {
    if (!rule || typeof rule !== "object") {
      problems.push(`rule ${index} is not an object`);
      continue;
    }
    if (typeof rule.action !== "string" || !rule.action) problems.push(`rule ${index} has no action`);
    if (typeof rule.resource !== "string" || !rule.resource) {
      problems.push(`rule ${index} has no resource`);
    }
    if (!["allow", "deny", "ask"].includes(rule.effect)) {
      problems.push(`rule ${index} has invalid effect`);
    }
  }

  const has = (action: string, resource: string, effect: SdkPermissionEffect): boolean =>
    (rules ?? []).some(
      (rule) => rule.action === action && rule.resource === resource && rule.effect === effect,
    );

  if (!has("*", "*", "deny")) problems.push("missing catch-all deny");
  if (!has("*", "*/*", "deny")) problems.push("missing path catch-all deny");
  if (!has("external_directory", "*", "deny")) problems.push("missing external_directory deny");
  for (const resource of [
    ".env",
    "*.env",
    "*.env.*",
    "*credential*",
    "*credentials*",
    ".git-credentials",
  ]) {
    if (!has("read", resource, "deny")) problems.push(`missing secret read deny ${resource}`);
  }
  const hasReadAllow = has("read", "*", "allow");
  if (options.requireReadAccess === true && !hasReadAllow) {
    problems.push("missing read allow");
  }

  // Default expectation follows the ruleset: an allowlist ruleset allows
  // reads, a policy "none" ruleset denies them.
  const expectedRead: SdkPermissionEffect =
    options.requireReadAccess === true
      ? "allow"
      : options.requireReadAccess === false
        ? "deny"
        : hasReadAllow
          ? "allow"
          : "deny";
  const expectations: Array<[string, string, SdkPermissionEffect]> = [
    ["read", "README.md", expectedRead],
    ["read", "src/app.ts", expectedRead],
    ["read", ".env", "deny"],
    ["read", "config/prod.env", "deny"],
    ["read", "prod.env.local", "deny"],
    ["read", "credentials/token.txt", "deny"],
    ["read", ".git-credentials", "deny"],
    ["edit", "src/app.ts", "deny"],
    ["write", "pwned.txt", "deny"],
    ["shell", "rm src/app.ts", "deny"],
    ["external_directory", "/tmp/outside", "deny"],
  ];
  const evaluated = expectations.map(([action, resource, expected]) => {
    const actual = evaluateSdkPermission(rules, action, resource);
    if (actual !== expected) {
      problems.push(`expected ${action} ${resource} -> ${expected}, got ${actual}`);
    }
    return { action, resource, expected, actual };
  });

  return { ok: problems.length === 0, problems, evaluated };
}

export interface SdkInlineConfigOptions {
  /** Resolved output-token budget for the model. */
  maxOutputTokens: number;
}

/**
 * Build the serialized inline SDK config. Contains no secret values: the API
 * key is only ever an `{env:...}` reference.
 */
export function buildSdkInlineConfig(
  config: AgentRuntimeConfigSource,
  env: NodeJS.ProcessEnv,
  options: SdkInlineConfigOptions,
): Record<string, unknown> {
  const provider = config.provider;
  return {
    $schema: "https://opencode.ai/config.json",
    model: `${SDK_PROVIDER_ID}/${SDK_MODEL_KEY}`,
    update: "disable",
    share: "disabled",
    snapshots: false,
    permissions: buildSdkPermissions(config),
    providers: {
      [SDK_PROVIDER_ID]: {
        name: "Review Model Provider",
        env: [provider.apiKeyEnv],
        package: SDK_PROVIDER_PACKAGE,
        settings: {
          baseURL: provider.baseURL,
          apiKey: `{env:${provider.apiKeyEnv}}`,
          timeout: provider.timeoutMs,
        },
        models: {
          [SDK_MODEL_KEY]: {
            name: provider.model,
            modelID: resolveModelId(config, env),
            limit: {
              context: config.agent.context.maxInputTokens,
              output: options.maxOutputTokens,
            },
          },
        },
      },
    },
  };
}
