/**
 * OpenCode session configuration builder (ARCHITECTURE.md §8.1, §11.3).
 *
 * Builds the per-session `opencode.json` consumed by the OpenCode CLI. The
 * configuration is written to a session-owned directory (never into the
 * repository workspace) and never contains secrets: the model API key is
 * supplied through the documented `{env:...}`/`env` variable mechanisms and
 * read from the child-process environment, which is an explicit allowlist.
 *
 * Security invariants (§10.1):
 * - Repository content is untrusted: prompt-injection instructions in the
 *   repository can never widen these permissions, because the agent has no
 *   write access to this file and rules are deny-by-default.
 * - The agent may read files inside the review workspace only; all other
 *   tools/actions are denied.
 */

// Structural subset of the central review configuration (ticket 02) used here.
export interface AgentRuntimeConfigSource {
  provider: {
    type: string;
    baseURL: string;
    apiKeyEnv: string;
    model: string;
    temperature: number;
    maxOutputTokens: number;
    timeoutMs: number;
  };
  agent: {
    runtime: { type: "opencode-cli" | "opencode-sdk" | "opencode-server" | "custom"; sessionStrategy: string; timeoutMs: number };
    context: {
      adaptive: boolean;
      maxFiles: number;
      maxRetrievalCalls: number;
      maxInputTokens: number;
      maxOutputTokens: number;
    };
    tools: { enabled: string[]; permissionPolicy: "allowlist" | "none" };
  };
  /**
   * Optional agent-tracing integration. Any OpenCode plugin package can be
   * configured here; the application only enables it and forwards its options
   * and credentials to the isolated child. Trace storage/visualisation stays in
   * the backend (Phoenix, Langfuse, ...).
   */
  observability?: {
    agentTracing?: {
      enabled?: boolean;
      plugin?: string;
      options?: Record<string, string | number | boolean | string[]>;
    };
  };
}

/**
 * Map the central `agent.tools.enabled` allowlist (conceptual tool names from
 * §11.3) onto OpenCode V2 permission actions. Unknown names are ignored.
 *
 * Conceptual tool     OpenCode action   Notes
 * read_file           read              Read a file inside the workspace.
 * list_files          glob              Enumerate paths inside the workspace.
 * search_code         grep              Content search inside the workspace.
 * inspect_symbols     grep              Best-effort mapping (text search).
 * get_diff            read              Best-effort mapping (read workspace files).
 */
export const TOOL_ACTION_MAP: Record<string, string> = {
  read_file: "read",
  list_files: "glob",
  search_code: "grep",
  inspect_symbols: "grep",
  get_diff: "read",
};

/**
 * Build the OpenCode `permission` configuration for one session.
 *
 * Deny-by-default: the `*` catch-all denies every action, then only the
 * actions mapped from the tools allowlist are re-allowed. `read` is granular
 * (object syntax, last matching pattern wins) so mandatory secret-protection
 * denials override the allow. External directories are denied outright so the
 * agent is confined to the review workspace.
 */
export function buildPermissionRules(config: AgentRuntimeConfigSource): Record<string, unknown> {
  const permission: Record<string, unknown> = {
    // 1. Deny every action by default (bash, edit, write, webfetch, websearch,
    //    task/subagents, skill, lsp, question, mcp tools — everything).
    "*": "deny",
    // 2. Confine the agent to the review workspace.
    external_directory: "deny",
  };

  // 3. Re-allow only the mapped actions of the tools allowlist. `read` is
  //    granular: allow all paths, then append mandatory secret denials (last
  //    match wins in OpenCode pattern evaluation).
  if (config.agent.tools.permissionPolicy === "allowlist") {
    const actions = new Set<string>();
    for (const tool of config.agent.tools.enabled) {
      const action = TOOL_ACTION_MAP[tool];
      if (action) actions.add(action);
    }
    for (const action of actions) {
      if (action === "read") {
        permission.read = {
          "*": "allow",
          "*.env": "deny",
          "*.env.*": "deny",
          "*credential*": "deny",
          "*credentials*": "deny",
          ".git-credentials": "deny",
        };
      } else {
        permission[action] = "allow";
      }
    }
  }

  return permission;
}

/** Default agent-tracing plugin (pinned; bump deliberately). */
export const DEFAULT_AGENT_TRACING_PLUGIN = "@devtheops/opencode-plugin-otel@2.1.0";

/** Environment variables the OpenCode child process is allowed to inherit. */
const CHILD_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TERM",
] as const;

/**
 * OpenCode OTel credentials/headers forwarded to the child so the configured
 * plugin can export session traces. Values are passed by value to the child
 * process only — never written to the generated opencode.json.
 */
const OPENCODE_TRACING_ENV_ALLOWLIST = [
  "OPENCODE_ENABLE_TELEMETRY",
  "OPENCODE_OTLP_ENDPOINT",
  "OPENCODE_OTLP_PROTOCOL",
  "OPENCODE_OTLP_HEADERS",
  "OPENCODE_OTLP_HEADERS_HELPER",
  "OPENCODE_RESOURCE_ATTRIBUTES",
  "OPENCODE_SPAN_ATTRIBUTES",
  "OPENCODE_CAPTURE_PROMPT_IN_LOGS",
  "OPENCODE_CAPTURE_MODEL_CONTEXT",
  "OPENCODE_DISABLE_LOGS",
  "OPENCODE_DISABLE_METRICS",
  "OPENCODE_DISABLE_TRACES",
] as const;

/** Langfuse plugin credentials (alternative backend; same isolation rule). */
const LANGFUSE_ENV_ALLOWLIST = [
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  // The plugin accepts both spellings (the SDK historically used BASEURL).
  "LANGFUSE_BASE_URL",
  "LANGFUSE_BASEURL",
  "LANGFUSE_ENVIRONMENT",
  "LANGFUSE_USER_ID",
] as const;

/**
 * Build the sanitized child-process environment. Only allowlisted variables
 * plus the model-provider credentials (by env-var name from the central
 * configuration) are passed — GitHub credentials and every other secret of
 * the trusted application are never visible to the agent (§10.6).
 *
 * Only the credentials relevant to the selected tracing plugin are forwarded:
 * a Phoenix/OTel child never receives the Langfuse keys, and vice versa. For
 * Langfuse, the missing correlation adapter is `LANGFUSE_USER_ID` (a stable,
 * secret-free label derived from the review id). OTel correlation travels as
 * plugin options.
 */
export function buildChildEnv(
  config: AgentRuntimeConfigSource,
  env: NodeJS.ProcessEnv,
  correlation?: { reviewId?: string },
): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  for (const name of CHILD_ENV_ALLOWLIST) {
    if (env[name] !== undefined) child[name] = env[name];
  }
  // Provider credential + endpoint, referenced by configuration `env` field.
  const keyName = config.provider.apiKeyEnv;
  if (env[keyName] !== undefined) child[keyName] = env[keyName];
  if (env.MODEL_BASE_URL !== undefined) child.MODEL_BASE_URL = env.MODEL_BASE_URL;
  if (env.MODEL_NAME !== undefined) child.MODEL_NAME = env.MODEL_NAME;

  // Agent tracing credentials (no-op unless a tracing plugin is enabled).
  const agentTracing = config.observability?.agentTracing;
  if (agentTracing?.enabled) {
    const plugin = agentTracing.plugin ?? DEFAULT_AGENT_TRACING_PLUGIN;
    const isLangfuse = /langfuse/i.test(plugin);
    const allowlist = isLangfuse
      ? LANGFUSE_ENV_ALLOWLIST
      : OPENCODE_TRACING_ENV_ALLOWLIST;
    for (const name of allowlist) {
      if (env[name] !== undefined) child[name] = env[name];
    }
    if (isLangfuse && correlation?.reviewId) {
      child.LANGFUSE_USER_ID = `review:${correlation.reviewId}`;
    }
  }
  return child;
}

export interface OpenCodeSessionConfigInput {
  /** Session-owned directory that will hold config/ and data/ subdirectories. */
  sessionDir: string;
  workspacePath: string;
  config: AgentRuntimeConfigSource;
  /** Resolved model identifier sent to the provider endpoint. */
  modelId: string;
  /** Resolved output-token budget for the model. */
  maxOutputTokens: number;
  /** Correlation id used for agent-trace tags (never sent to the model). */
  reviewId?: string;
  /** Repository full name used for agent-trace tags (never sent to the model). */
  repository?: string;
  /** PR number used for agent-trace tags (never sent to the model). */
  pullRequestNumber?: number;
}

/**
 * Build secret-free trace tags for one review (Langfuse plugin option). Tags
 * are metadata only; the review prompt and model request are unaffected.
 */
export function buildTraceTags(input: {
  reviewId?: string;
  repository?: string;
  pullRequestNumber?: number;
}): string[] {
  const tags: string[] = [];
  if (input.reviewId) tags.push(`review:${input.reviewId}`);
  if (input.repository) tags.push(`repository:${input.repository}`);
  if (typeof input.pullRequestNumber === "number") tags.push(`pr:${input.pullRequestNumber}`);
  return tags;
}

/**
 * Build OTel span attributes for one review (generic OTel plugin option).
 * Values are secret-free identifiers only. GitHub owner/repo names cannot
 * contain commas or equals signs, so the plugin's comma-separated parsing is
 * unambiguous.
 */
export function buildSpanAttributes(input: {
  reviewId?: string;
  repository?: string;
  pullRequestNumber?: number;
}): string {
  const attributes: string[] = [];
  if (input.reviewId) attributes.push(`review.id=${input.reviewId}`);
  if (input.repository) attributes.push(`repository=${input.repository}`);
  if (typeof input.pullRequestNumber === "number") {
    attributes.push(`pr.number=${input.pullRequestNumber}`);
  }
  return attributes.join(",");
}

export interface AgentTracingInput {
  config: AgentRuntimeConfigSource;
  reviewId?: string;
  repository?: string;
  pullRequestNumber?: number;
}

/**
 * Build the tracing plugin entry shared by the CLI and SDK runtimes. Returns
 * undefined when agent tracing is disabled. The plugin package is public;
 * credentials stay in the child/host environment and are never serialized.
 */
export function buildAgentTracingPlugin(
  input: AgentTracingInput,
): { package: string; options: Record<string, unknown> } | undefined {
  const agentTracing = input.config.observability?.agentTracing;
  if (!agentTracing?.enabled) return undefined;

  const options: Record<string, unknown> = {
    ...agentTracing.options,
    // The plugin's own opt-in flag; the entry is only emitted when tracing is
    // enabled, so this is always true here.
    enabled: true,
  };
  const tags = buildTraceTags(input);
  if (tags.length > 0) options.tags = tags;
  const spanAttributes = [
    typeof agentTracing.options?.spanAttributes === "string"
      ? agentTracing.options.spanAttributes
      : "",
    buildSpanAttributes(input),
  ]
    .filter((value) => value.length > 0)
    .join(",");
  if (spanAttributes.length > 0) options.spanAttributes = spanAttributes;

  return {
    package: agentTracing.plugin ?? DEFAULT_AGENT_TRACING_PLUGIN,
    options,
  };
}

/**
 * Build the per-session OpenCode configuration object (JSON, V2 schema).
 * Provider id "reviewer" is application-owned; the model key "glm" is a fixed
 * alias so that slashes in upstream model identifiers never collide with the
 * `provider/model` reference format.
 */
export function buildSessionConfig(input: OpenCodeSessionConfigInput): Record<string, unknown> {
  const { config } = input;
  const tracingPlugin = buildAgentTracingPlugin({
    config,
    reviewId: input.reviewId,
    repository: input.repository,
    pullRequestNumber: input.pullRequestNumber,
  });
  return {
    $schema: "https://opencode.ai/config.json",
    model: "reviewer/glm",
    update: "disable",
    snapshots: false,
    permission: buildPermissionRules(config),
    // OpenCode 2 uses the plural `plugins` key. The plugin package is public;
    // credentials are supplied through the child environment only.
    ...(tracingPlugin ? { plugins: [tracingPlugin] } : {}),
    // OpenCode 2 provider shape: `package` selects the provider implementation
    // and `settings` carries its options. The v1 `npm`/`options` keys are NOT
    // read here — with them OpenCode silently ignores the provider and falls
    // back to its default model (verified against v2.2.6: zero requests reach
    // the configured endpoint).
    providers: {
      reviewer: {
        name: "Review Model Provider",
        env: [config.provider.apiKeyEnv],
        package: "@opencode/ai/providers/openai-compatible",
        settings: {
          baseURL: config.provider.baseURL,
          apiKey: `{env:${config.provider.apiKeyEnv}}`,
          timeout: config.provider.timeoutMs,
        },
        models: {
          glm: {
            name: config.provider.model,
            modelID: input.modelId,
            limit: { context: config.agent.context.maxInputTokens, output: input.maxOutputTokens },
          },
        },
      },
    },
  };
}

/**
 * Resolve the model identifier actually sent to the endpoint. Per ticket 05:
 * the configured endpoint requires the "provider/model" MODEL_NAME form
 * (e.g. `workers-ai/@cf/zai-org/glm-4.7-flash`); the central
 * `provider.model` value is used as a fallback only.
 */
export function resolveModelId(config: AgentRuntimeConfigSource, env: NodeJS.ProcessEnv): string {
  const fromEnv = env.MODEL_NAME?.trim();
  if (fromEnv) return fromEnv;
  return config.provider.model;
}
