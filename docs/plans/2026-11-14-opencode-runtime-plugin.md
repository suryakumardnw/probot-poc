# OpenCode Runtime Plugin Implementation Plan

> **Historical document.** This plan records the pre-refactor layout and task
> sequence. Paths such as `src/agent/` and `src/review-engine/` were current
> when it was written; the runtime now lives in `src/platform/agents/` and the
> engine in `src/modules/review/`. See
> [docs/architecture.md](../architecture.md) and
> [docs/agent-runtime-plugins.md](../agent-runtime-plugins.md).
>
> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the agent runtime pluggable so `agent.runtime.type` selects either the existing OpenCode CLI adapter or a new OpenCode SDK adapter, with the SDK host isolated in a sanitized child process and both adapters behind the same `AgentRuntime` contract.

**Architecture:** A small runtime-plugin registry maps the configured runtime type to a plugin. The built-in OpenCode plugin owns two adapters: the existing CLI adapter (`opencode-cli`) and a new SDK adapter (`opencode-sdk`). The SDK adapter runs `@opencode/sdk` in a separate Node child process with the same environment allowlist as the CLI child; the parent adapter talks to it over line-delimited JSON on stdio. The review engine, publishing code and worker entrypoints keep importing only `createAgentRuntime` from `src/agent/index.ts`.

**Tech Stack:** TypeScript, Node.js 24, `@opencode/sdk@2.3.0`, OpenCode CLI 2.2.6, Zod, Vitest, Docker.

**Spec:** `docs/architecture.md` §8 (Agent Runtime Architecture) plus the approved decisions in "Design Decisions" below. The reference implementation is the local `experiment/opencode-sdk-runtime` branch; copy adapter logic from it, but do not merge its experiment directories, deployment units or boolean `agent.sdk.enabled` flag.

> **Implementation note (2026-11-14):** during end-to-end verification,
> `@opencode/sdk@2.2.7` failed real session creation with an internal
> `session.created` schema error (`s.startsWith is not a function`) on both
> Node 24 and Node 26. `@opencode/sdk@2.3.0` creates the same session
> successfully with the unchanged adapter/structural types, so the
> implementation pins 2.3.0.

## Global Constraints

- `agent.runtime.type` defaults to `opencode-cli`; the CLI adapter remains the production default.
- Add only `opencode-sdk` as the new config value. Keep the existing `opencode-server` and `custom` values reserved; the registry must reject any type with no registered plugin using `AgentRuntimeError("config", ...)`.
- Fail closed: selecting `opencode-sdk` must never silently fall back to the CLI. A missing SDK, unsupported Node version, import failure, host failure or unhealthy runtime fails the review.
- Preserve the current `AgentRuntime` contract exactly: `startSession`, `execute`, `terminate`, `healthCheck`.
- The SDK child process receives only the allowlisted environment from `buildChildEnv`: no `GITHUB_TOKEN`, database URL, Redis URL, webhook secret or other worker credentials.
- Provider credentials stay as `{env:VAR}` references in configuration. Never write an API key value into `opencode.json` or the SDK inline config.
- Keep deny-by-default permissions: only read-only actions mapped from `agent.tools.enabled`; deny `.env`, `*.env`, `*.env.*`, `*credential*`, `*credentials*`, `.git-credentials` and `external_directory`.
- Keep the post-run `git status --porcelain` workspace integrity guard for both adapters.
- Keep one isolated session per review. The SDK host is created lazily on the first `execute` and closed by `terminate`.
- Do not modify `src/review-engine/*`, `src/publishing/*`, `src/execution/*` or review-facing behavior.
- Check `git status` before starting. If the branch has unrelated working-tree changes (README, deploy files, docs/deployment, admin/server tests, etc.), stage only the files named by each task. Never use `git add -A`.
- Pin `@opencode/sdk` exactly to `2.3.0`; end-to-end verification showed 2.2.7 fails real session creation with an internal schema event bug, while 2.3.0 passes. Pin `effect@4.1.0` as a direct production dependency so npm does not hoist Prisma's Effect 3.21 into the SDK peer slot. The production image moves to `node:24.22.3-slim`.
- The CLI binary stays pinned to OpenCode `2.2.6`; do not change the CLI pin in this plan.
- No static import of `@opencode/sdk` from `tsc`-compiled application modules. The SDK is loaded only inside the child host process through a dynamic import with a variable specifier, so the build and tests do not depend on the package's type surface.
- Run tests on Node >= 24. The local environment is Node 26; the plan's production floor is Node 24.

## Review Focus

These are the failure modes the spec implies but the happy-path tasks do not naturally exercise. Each one has a test in the task that owns the code.

1. **Unknown or reserved runtime type** — a config typo or `opencode-server` selection must fail immediately with a configuration error, not construct the CLI adapter.
2. **SDK selected while Node < 24 or the package is missing** — the adapter must fail closed with a normalized `config`/`spawn` error and must not fall back to the CLI.
3. **SDK child process crashes, exits early or emits non-protocol stdout** — pending calls must reject and the review must fail without hanging.
4. **Prompt/provider failure, timeout or hung `sessions.get`** — the total deadline must kill the child and reject with `timeout`, even if cleanup hangs.
5. **Secret leakage through child stderr, thrown details or health output** — the provider key and tracing secrets must be scrubbed before logging or attaching details.
6. **Workspace modification during an SDK review** — the post-run integrity guard must fail with `workspace_modified`.
7. **Concurrent SDK reviews** — each review gets its own child process, host, database path and SDK session; one review must never see another's output.
8. **Tracing enabled with the SDK runtime** — the SDK inline config must carry the same plugin entry/tags/span attributes as the CLI config; silently dropping tracing is a regression.
9. **Config/JSON Schema drift** — the Zod enum and the checked-in JSON Schema must accept/reject the same runtime values.
10. **Existing CLI behavior** — the CLI adapter, workspace guard, timeout escalation and tracing config must remain unchanged.

---

## Design Decisions

1. **Plugin registry, not a boolean flag.** `src/agent/runtime-registry.ts` owns a `Map<string, AgentRuntimePlugin>`. The built-in plugin id is `opencode` and owns `opencode-cli` and `opencode-sdk`. Future runtimes register their own plugin without editing the factory.
2. **Config selects the adapter.** `agent.runtime.type` is the only selector. There is no `agent.sdk.enabled`, no `shadowMode` and no automatic fallback.
3. **SDK host is a child process.** The parent SDK adapter spawns `process.execPath` with the compiled host-process entrypoint, sends the inline config and commands over stdin, and reads responses over stdout. The child gets a sanitized env built by `buildChildEnv` plus per-session `XDG_CONFIG_HOME`, `XDG_DATA_HOME` and `XDG_STATE_HOME`.
4. **Host protocol is line-delimited JSON.** Requests and responses are one JSON object per line. Child stderr is diagnostic only and is scrubbed/truncated by the parent before logging.
5. **Tracing parity.** Extract the existing trace-plugin entry builder from `opencode-config.ts` and use it in both `buildSessionConfig` (CLI) and `buildSdkInlineConfig` (SDK). This is configuration parity, not proof that the SDK host loads the plugin; confirm real trace export in staging before production rollout.
6. **Node 24 in production.** The SDK requires Node >= 24. The production Docker image moves from Node 22.14.0 to Node 24.22.3. The CLI remains available and default.
7. **SDK is a production dependency.** Add `@opencode/sdk@2.3.0` and `effect@4.1.0` to `dependencies`, not `devDependencies`, because the production `npm ci --omit=dev` install must include both and the Effect pin prevents npm from hoisting Prisma's 3.21 into the SDK peer slot.
8. **No experiment assets.** Do not copy `experiments/sdk-runtime-spike/`, `experiments/sdk-runtime-adversarial/`, `deploy/sdk/`, the SDK worker Dockerfile/compose files, the egress proxy, or the Phase 2a flag-based factory. Only the adapter/config/test logic is reference material.

## File Map

**Create**
- `src/agent/runtime-registry.ts` — plugin contract, registry, built-in OpenCode plugin, `createAgentRuntime`.
- `src/agent/opencode-sdk-runtime.ts` — SDK adapter implementing `AgentRuntime`.
- `src/agent/sdk/config.ts` — SDK inline config and ordered permission rules.
- `src/agent/sdk/types.ts` — structural SDK types; no package import.
- `src/agent/sdk/protocol.ts` — host request/response/log message types.
- `src/agent/sdk/host.ts` — in-child dispatcher over the SDK host API.
- `src/agent/sdk/host-process.ts` — child entrypoint and stdin/stdout loop.
- `src/agent/sdk/client.ts` — parent-side stdio client and host health probe.
- `test/agent-sdk-config.test.ts` — permission/config tests.
- `test/agent-sdk-host.test.ts` — dispatcher/protocol tests.
- `test/agent-sdk-client.test.ts` — stdio client tests.
- `test/agent-sdk-runtime.test.ts` — SDK adapter lifecycle/failure tests.
- `test/agent-runtime-registry.test.ts` — plugin selection/fail-closed tests.
- `test/deployment-node.test.ts` — Node 24/SDK dependency/Dockerfile invariants.
- `docs/agent-runtime-plugins.md` — operator and plugin API documentation.

**Modify**
- `src/agent/opencode-config.ts` — add `opencode-sdk` to the runtime type union; extract the tracing plugin entry builder; have the SDK config use it.
- `src/agent/opencode-runtime.ts` — export `buildPrompt` for shared prompt parity; remove the old `createAgentRuntime` factory; keep the CLI adapter and exports.
- `src/agent/index.ts` — export the registry factory, plugin API and SDK adapter types.
- `src/config/review-schema.ts` — add `opencode-sdk` to the runtime enum.
- `config/schemas/review-config-v1.schema.json` — mirror the enum.
- `package.json` — `engines.node: ">=24"`; add `@opencode/sdk` to dependencies.
- `package-lock.json` — generated by `npm install`.
- `Dockerfile` — both stages use `node:24.22.3-slim`.
- `test/review-config.test.ts` — runtime type/config mirror tests.
- `docs/architecture.md` — §2.2 table, §3.1 diagram, §8 runtime section, config example.
- `docs/deployment.md` — Node 24, SDK dependency, child-process memory note.
- `docs/how-pr-review-works.md` — runtime-selection note.
- `README.md` — local Node requirement.

**Do not touch**
- `src/review-engine/**`, `src/publishing/**`, `src/execution/**`, `src/worker.ts`, `src/scripts/*` other than their existing `createAgentRuntime` import continuing to work.
- `experiments/**`, `deploy/sdk/**`, `src/agent/factory.ts` from the experiment branch.
- The unrelated uncommitted files listed in Global Constraints.

---

### Task 1: Add the `opencode-sdk` runtime type

**Files:**
- Modify: `src/agent/opencode-config.ts:30`
- Modify: `src/config/review-schema.ts:206-214`
- Modify: `config/schemas/review-config-v1.schema.json:337-360`
- Test: `test/review-config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `AgentRuntimeConfigSource["agent"]["runtime"]["type"]` includes `"opencode-sdk"`; config validation accepts it and still defaults to `"opencode-cli"`.

- [ ] **Step 1: Write the failing config tests**

Add a `describe("agent runtime selection", ...)` block near the other `agent` config tests. Use the existing `validConfig()` helper and the already-imported `readFileSync`/`join`.

```ts
describe("agent runtime selection", () => {
  it("defaults to the OpenCode CLI runtime", () => {
    const parsed = reviewConfigSchema.parse(validConfig());
    expect(parsed.agent.runtime.type).toBe("opencode-cli");
  });

  it("accepts the OpenCode SDK runtime", () => {
    const parsed = reviewConfigSchema.parse(
      validConfig({ agent: { runtime: { type: "opencode-sdk" } } }),
    );
    expect(parsed.agent.runtime.type).toBe("opencode-sdk");
  });

  it("rejects an unknown runtime type", () => {
    expect(() =>
      reviewConfigSchema.parse(
        validConfig({ agent: { runtime: { type: "opencode-http" } } }),
      ),
    ).toThrow();
  });

  it("mirrors the runtime enum in the JSON Schema", () => {
    const schema = JSON.parse(
      readFileSync(
        join(__dirname, "../config/schemas/review-config-v1.schema.json"),
        "utf8",
      ),
    ) as {
      properties: {
        agent: {
          properties: {
            runtime: { properties: { type: { enum: string[] } } };
          };
        };
      };
    };
    expect(schema.properties.agent.properties.runtime.properties.type.enum).toEqual([
      "opencode-cli",
      "opencode-sdk",
      "opencode-server",
      "custom",
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/review-config.test.ts -t "agent runtime selection"`

Expected: FAIL because `opencode-sdk` is not in the Zod enum, and the JSON Schema assertion has only three values.

- [ ] **Step 3: Implement the type and schema change**

In `src/agent/opencode-config.ts`, change the runtime type union to:

```ts
type: "opencode-cli" | "opencode-sdk" | "opencode-server" | "custom";
```

In `src/config/review-schema.ts`, change the `type` enum to:

```ts
z.enum(["opencode-cli", "opencode-sdk", "opencode-server", "custom"]).default("opencode-cli")
```

In `config/schemas/review-config-v1.schema.json`, add `"opencode-sdk"` after `"opencode-cli"` in the runtime `type` enum. Keep `"opencode-server"` and `"custom"` reserved.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/review-config.test.ts -t "agent runtime selection"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/opencode-config.ts src/config/review-schema.ts \
  config/schemas/review-config-v1.schema.json test/review-config.test.ts
git commit -m "feat(config): add opencode-sdk runtime type"
```

---

### Task 2: Add the SDK inline config and share tracing configuration

**Files:**
- Create: `src/agent/sdk/config.ts`
- Modify: `src/agent/opencode-config.ts` (extract tracing plugin entry builder; add `buildAgentTracingPlugin`)
- Test: `test/agent-sdk-config.test.ts`
- Test: `test/agent-runtime.test.ts` (existing CLI tracing tests must still pass)

**Interfaces:**
- Consumes: `AgentRuntimeConfigSource`, `TOOL_ACTION_MAP`, `resolveModelId` from `opencode-config.ts`.
- Produces:
  - `SDK_PROVIDER_ID = "reviewer"`, `SDK_MODEL_KEY = "glm"`, `SDK_PROVIDER_PACKAGE = "@opencode/ai/providers/openai-compatible"`
  - `SdkPermissionEffect`, `SdkPermissionRule`
  - `buildSdkPermissions(config): SdkPermissionRule[]`
  - `evaluateSdkPermission(rules, action, resource): SdkPermissionEffect`
  - `SdkPermissionValidation`, `validateSdkPermissions(rules, options?)`
  - `SdkInlineConfigOptions { maxOutputTokens; reviewId?; repository?; pullRequestNumber? }`
  - `buildSdkInlineConfig(config, env, options): Record<string, unknown>`
  - `buildAgentTracingPlugin(input): { package: string; options: Record<string, unknown> } | undefined`

- [ ] **Step 1: Write the failing SDK config tests**

Create `test/agent-sdk-config.test.ts` with a local `baseConfig` fixture matching `AgentRuntimeConfigSource` (copy the fixture from `test/agent-runtime.test.ts`). Add these tests:

```ts
describe("SDK permission rules", () => {
  it("is deny-by-default with only mapped read-only actions allowed", () => {
    const rules = buildSdkPermissions(baseConfig);
    expect(evaluateSdkPermission(rules, "read", "src/app.ts")).toBe("allow");
    expect(evaluateSdkPermission(rules, "grep", "src/app.ts")).toBe("allow");
    expect(evaluateSdkPermission(rules, "glob", "src/**")).toBe("allow");
    expect(evaluateSdkPermission(rules, "edit", "src/app.ts")).toBe("deny");
    expect(evaluateSdkPermission(rules, "write", "pwned.txt")).toBe("deny");
    expect(evaluateSdkPermission(rules, "shell", "rm src/app.ts")).toBe("deny");
    expect(evaluateSdkPermission(rules, "external_directory", "/tmp/outside")).toBe("deny");
  });

  it("denies secret paths even though reads are allowed", () => {
    const rules = buildSdkPermissions(baseConfig);
    for (const path of [".env", "config/prod.env", "prod.env.local", "credentials/token.txt", ".git-credentials"]) {
      expect(evaluateSdkPermission(rules, "read", path)).toBe("deny");
    }
  });

  it("denies everything when permissionPolicy is none", () => {
    const rules = buildSdkPermissions({
      ...baseConfig,
      agent: {
        ...baseConfig.agent,
        tools: { ...baseConfig.agent.tools, permissionPolicy: "none" },
      },
    });
    expect(evaluateSdkPermission(rules, "read", "src/app.ts")).toBe("deny");
  });

  it("validates the generated ruleset structurally and behaviorally", () => {
    expect(validateSdkPermissions(buildSdkPermissions(baseConfig))).toEqual({
      ok: true,
      problems: [],
      evaluated: expect.any(Array),
    });
  });
});

describe("SDK inline config", () => {
  it("emits the verified provider shape with env-referenced credentials", () => {
    const config = buildSdkInlineConfig(baseConfig, { MODEL_NAME: "workers-ai/@cf/zai-org/glm-4.7-flash" }, {
      maxOutputTokens: 8192,
    });
    expect(config.model).toBe("reviewer/glm");
    expect(config.share).toBe("disabled");
    expect(config.snapshots).toBe(false);
    expect(config.permissions).toEqual(expect.any(Array));
    const provider = (config.providers as Record<string, any>).reviewer;
    expect(provider.package).toBe("@opencode/ai/providers/openai-compatible");
    expect(provider.settings.apiKey).toBe("{env:MODEL_API_KEY}");
    expect(JSON.stringify(config)).not.toContain("secret-key-value");
  });

  it("falls back to provider.model when MODEL_NAME is absent", () => {
    const config = buildSdkInlineConfig(baseConfig, {}, { maxOutputTokens: 8192 });
    const provider = (config.providers as Record<string, any>).reviewer;
    expect(provider.models.glm.modelID).toBe(baseConfig.provider.model);
  });

  it("includes the same tracing plugin entry as the CLI config when enabled", () => {
    const traced = {
      ...baseConfig,
      observability: { agentTracing: { enabled: true } },
    };
    const config = buildSdkInlineConfig(traced, {}, {
      maxOutputTokens: 8192,
      reviewId: "rev_123",
      repository: "acme/app",
      pullRequestNumber: 42,
    });
    expect(config.plugins).toEqual([
      {
        package: "@devtheops/opencode-plugin-otel@2.1.0",
        options: {
          enabled: true,
          tags: ["review:rev_123", "repository:acme/app", "pr:42"],
          spanAttributes: "review.id=rev_123,repository=acme/app,pr.number=42",
        },
      },
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/agent-sdk-config.test.ts`

Expected: FAIL because `src/agent/sdk/config.ts` does not exist.

- [ ] **Step 3: Extract the shared tracing plugin builder**

In `src/agent/opencode-config.ts`, add:

```ts
export interface AgentTracingInput {
  config: AgentRuntimeConfigSource;
  reviewId?: string;
  repository?: string;
  pullRequestNumber?: number;
}

export function buildAgentTracingPlugin(
  input: AgentTracingInput,
): { package: string; options: Record<string, unknown> } | undefined {
  const agentTracing = input.config.observability?.agentTracing;
  if (!agentTracing?.enabled) return undefined;

  const options: Record<string, unknown> = {
    ...agentTracing.options,
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
```

Change `buildSessionConfig` to call this builder and keep the existing `plugins` output identical:

```ts
const tracingPlugin = buildAgentTracingPlugin({
  config,
  reviewId: input.reviewId,
  repository: input.repository,
  pullRequestNumber: input.pullRequestNumber,
});
// ...
...(tracingPlugin ? { plugins: [tracingPlugin] } : {}),
```

- [ ] **Step 4: Implement the SDK config builder**

Create `src/agent/sdk/config.ts` by porting the reference file from `experiment/opencode-sdk-runtime` with these adjustments:

- Remove the Phase 2a wording from comments; describe the current behavior.
- Import `buildAgentTracingPlugin` from `../opencode-config.js`.
- `buildSdkInlineConfig` returns the same provider shape as the reference (`providers.reviewer`, package `@opencode/ai/providers/openai-compatible`, `settings.baseURL`, `settings.apiKey` as `{env:...}`, `settings.timeout`, `models.glm` with `modelID` and limits).
- Add `share: "disabled"`, `snapshots: false`, and `update: "disable"`.
- Add `...(tracingPlugin ? { plugins: [tracingPlugin] } : {})`.
- Keep `permissions` as the ordered array shape with last-match-wins evaluation.
- Map only `read`, `grep`, `glob` from the tools allowlist; ignore other mapped actions in the SDK path.

- [ ] **Step 5: Run the SDK config and CLI tracing tests**

Run: `npx vitest run test/agent-sdk-config.test.ts test/agent-runtime.test.ts`

Expected: PASS. The existing CLI tracing assertions must be unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/agent/sdk/config.ts src/agent/opencode-config.ts \
  test/agent-sdk-config.test.ts
git commit -m "feat(agent): add SDK inline config and share tracing setup"
```

---

### Task 3: Add the child-process SDK host protocol and client

**Files:**
- Create: `src/agent/sdk/protocol.ts`
- Create: `src/agent/sdk/host.ts`
- Create: `src/agent/sdk/host-process.ts`
- Create: `src/agent/sdk/client.ts`
- Create: `src/agent/sdk/types.ts` (structural SDK types; copy from the reference branch)
- Test: `test/agent-sdk-host.test.ts`
- Test: `test/agent-sdk-client.test.ts`

**Interfaces:**
- Consumes: `SdkModule`, `SdkHost`, `SdkSessionRow`, `SdkMessage`, `SdkCreateSessionInput`, `SdkPromptInput`, `SdkSessionRef`, `SdkLoader` from `./types.js`.
- Produces:
  - `SdkHostRequest`, `SdkHostResponse`, `SdkHostLogEvent`
  - `SdkHostClient` with `start()`, `createSession()`, `getSession()`, `prompt()`, `listMessages()`, `removeSession()`, `close()`, `kill()`
  - `SdkHostClientOptions`
  - `createStdioSdkHostClient(options): SdkHostClient`
  - `probeSdkHost(options): Promise<{ version: string }>`
  - `SdkHostDispatcher { handle(request): Promise<SdkHostResponse> }`
  - `createSdkHostDispatcher(loadSdk, onLog): SdkHostDispatcher`
  - `runHostProcess(options): Promise<void>`

- [ ] **Step 1: Write the failing host dispatcher tests**

Create `test/agent-sdk-host.test.ts` with a fake `SdkModule` (same shape as the reference test file's fake) and a `createSdkHostDispatcher` test. Cover:

- `create` calls `OpenCode.create` once with `config.content`, `database.path`, `models.fetch: false`, `fs.filewatcher: false`, and the supplied log emitter.
- `session.create` forwards `location.directory`, `metadata`, `title`, `model`.
- `session.prompt` and `session.get` forward the session id.
- `message.list` returns the fake host's messages.
- `session.remove` forwards the session id.
- `close` calls `host.close` and is idempotent.
- An SDK error is returned as `{ ok: false, error: { message } }` and does not throw out of the dispatcher.
- `health` reports the injected module version without creating a host.
- `runHostProcess` reads one request line from a `PassThrough` input, writes one response line to a `PassThrough` output, and resolves on `close`.
- A malformed request line produces an error response rather than crashing the process.

- [ ] **Step 2: Run the host tests to verify they fail**

Run: `npx vitest run test/agent-sdk-host.test.ts`

Expected: FAIL because the SDK host modules do not exist.

- [ ] **Step 3: Implement protocol and dispatcher**

`src/agent/sdk/protocol.ts`:

```ts
export type SdkHostMethod =
  | "create"
  | "session.create"
  | "session.get"
  | "session.prompt"
  | "message.list"
  | "session.remove"
  | "close"
  | "health";

export interface SdkHostRequest {
  id: number;
  method: SdkHostMethod;
  params?: unknown;
}

export type SdkHostResponse =
  | { id: number; ok: true; result?: unknown }
  | { id: number; ok: false; error: { message: string; code?: string } };

export interface SdkHostLogEvent {
  type: "log";
  level?: string;
  message?: string;
  cause?: string;
}
```

`src/agent/sdk/host.ts` implements `createSdkHostDispatcher(loadSdk, onLog)`:

- Lazy-load the SDK on the first `create`; cache the module.
- Keep `host` and `closed` state.
- `create` builds the host with `config: { content: string, project: false, claude: false }`, `database.path`, `models: { fetch: false }`, `fs: { filewatcher: false }`, and `log: { level: "error", emit: onLog }`.
- `close` calls `host.close()` once and clears the host.
- `health` loads the SDK, checks `OpenCode.create` exists, and returns `{ version: resolveSdkVersion() }`. `resolveSdkVersion` uses `createRequire` to read `@opencode/sdk/package.json`, falling back to `"unknown"`.
- Never import `@opencode/sdk` statically; use the injected loader.

`src/agent/sdk/host-process.ts`:

- Export `runHostProcess({ input, output, error, loadSdk })`.
- Read `input` as UTF-8 lines with a max line length of 1 MiB; ignore blank lines.
- Parse a request, call the dispatcher, write one JSON response line to `output`.
- Write SDK log entries as JSON lines to `error` with `{ type: "log", ... }`.
- On `close`, close the host and resolve.
- Default `loadSdk` is the variable-specifier dynamic import (`const specifier = "@opencode/sdk"; return await import(specifier)`).
- When executed directly (guard `process.argv[1]` before calling `pathToFileURL`), call `runHostProcess` with `process.stdin`, `process.stdout`, `process.stderr`.

- [ ] **Step 4: Write the failing stdio client tests**

Create `test/agent-sdk-client.test.ts` with a fake child process (extend `EventEmitter`, expose `stdout`/`stderr`/`stdin` as `EventEmitter` with `write`). Cover:

- `start()` spawns `process.execPath` with the host-process path, `shell: false`, the supplied env and `cwd`.
- `start()` sends a `create` request containing the inline config and database path.
- A response with the matching id resolves the pending call.
- Split/partial response lines are reassembled.
- A non-JSON stdout line rejects the pending call with a protocol error.
- Child `exit`/`error` rejects every pending call.
- stderr lines are forwarded to the supplied callback and never parsed as protocol.
- `kill()` sends SIGTERM and is idempotent.
- `probeSdkHost` spawns a temporary child, sends `health`, returns the version, and closes it.

- [ ] **Step 5: Run the client tests to verify they fail**

Run: `npx vitest run test/agent-sdk-client.test.ts`

Expected: FAIL because the client and probe do not exist.

- [ ] **Step 6: Implement the stdio client**

`src/agent/sdk/client.ts`:

```ts
export interface SdkHostClientOptions {
  configContent: string;
  databasePath: string;
  workspacePath: string;
  env: NodeJS.ProcessEnv;
  hostProcessPath: string;
  sessionId: string;
  reviewId: string;
  spawnImpl?: typeof spawn;
  requestTimeoutMs?: number;
  onStderr?: (line: string) => void;
}

export interface SdkHostClient {
  start(): Promise<void>;
  createSession(input: SdkCreateSessionInput): Promise<SdkSessionRow>;
  getSession(input: SdkSessionRef): Promise<SdkSessionRow>;
  prompt(input: SdkPromptInput): Promise<void>;
  listMessages(input: SdkSessionRef & { order?: "asc" | "desc" }): Promise<SdkMessage[]>;
  removeSession(input: SdkSessionRef): Promise<void>;
  close(): Promise<void>;
  kill(): void;
}

export function createStdioSdkHostClient(options: SdkHostClientOptions): SdkHostClient;
export function probeSdkHost(options: {
  env: NodeJS.ProcessEnv;
  hostProcessPath: string;
  spawnImpl?: typeof spawn;
  requestTimeoutMs?: number;
}): Promise<{ version: string }>;
```

Implementation notes:

- Use `StringDecoder("utf8")` per stream, buffer partial lines, cap a single protocol line at 1 MiB.
- Assign monotonically increasing request ids. Keep a `Map<number, { resolve, reject, timer }>`.
- `start()` spawns, wires stdout/stderr/exit/error, then sends `create`.
- `requestTimeoutMs` defaults to 60_000 for handshake/requests; the adapter's total deadline remains authoritative. On timeout reject with `AgentRuntimeError("timeout", ...)`.
- On unexpected exit, reject all pending with `AgentRuntimeError("crash", "opencode sdk host exited ...")`.
- `close()` sends `close`, waits for the response or a short 2 s timer, then resolves; `kill()` sends SIGTERM and a SIGKILL escalation after 2 s.
- `probeSdkHost` spawns with `stdio: ["pipe","pipe","ignore"]`, sends `health`, closes, and returns the version. It must always kill the child in `finally`.

- [ ] **Step 7: Run the host and client tests**

Run: `npx vitest run test/agent-sdk-host.test.ts test/agent-sdk-client.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/agent/sdk/protocol.ts src/agent/sdk/host.ts \
  src/agent/sdk/host-process.ts src/agent/sdk/client.ts src/agent/sdk/types.ts \
  test/agent-sdk-host.test.ts test/agent-sdk-client.test.ts
git commit -m "feat(agent): add isolated SDK host process and stdio client"
```

---

### Task 4: Implement the SDK runtime adapter

**Files:**
- Create: `src/agent/opencode-sdk-runtime.ts`
- Modify: `src/agent/opencode-runtime.ts` (export the existing `buildPrompt` so both adapters share the JSON output contract)
- Test: `test/agent-sdk-runtime.test.ts`

**Interfaces:**
- Consumes: `AgentRuntime`, `AgentRuntimeError`, `AgentSession`, `AgentTask`, `AgentResult`, `RuntimeHealth`; `buildChildEnv`; `buildSdkInlineConfig`; `buildPrompt`; `extractJson`; `SdkHostClient`, `createStdioSdkHostClient`, `probeSdkHost`.
- Produces:
  - `SdkRuntimeOptions` with `logger`, `createHostClient`, `probeSdkHost`, `nodeMajorVersion` (test seam for the Node >= 24 check), `hostProcessPath`, `spawnImpl`, `gitStatusImpl`, `rmImpl`, `sleepImpl`, `now`, `pollIntervalMs`, `defaultTimeoutMs`.
  - `OpenCodeSdkAgentRuntime implements AgentRuntime`.
  - `createSdkAgentRuntime(config, options?)`.

- [ ] **Step 1: Write the failing adapter tests**

Create `test/agent-sdk-runtime.test.ts` with a `FakeHostClient` that records calls and returns queued rows/messages. Use the same `baseConfig` fixture, but set `agent.runtime.type` to `"opencode-sdk"`. Cover:

- Constructor rejects a config with `runtime.type === "opencode-cli"` with `AgentRuntimeError` code `config`.
- `startSession` creates the session directory and does not create a host client.
- `execute` creates one client, starts it, creates one SDK session, prompts, polls `getSession` until `time.idle >= promptStarted`, and returns text.
- JSON output is extracted and validated; missing JSON and validator failures are `invalid_output`.
- The prompt sent for a `json` task includes the same "exactly one JSON object" contract as the CLI adapter.
- Multi-step output is not concatenated blindly: a partial assistant message followed by a complete JSON message still validates, matching the CLI adapter's newest-message-first behavior.
- `outcome: "failed"` maps to `provider_unavailable`.
- Prompt rejection maps to `crash`.
- A hung prompt or hung `getSession` is bounded by the total deadline, calls `client.kill()`, and throws `timeout`.
- A hung `close` during timeout does not delay the timeout rejection.
- `terminate` removes the session, closes the client, kills it, removes the directory, and is idempotent.
- Two concurrent sessions get two distinct clients and never share rows/messages.
- `healthCheck` reports unhealthy on Node < 24 (inject `nodeMajorVersion: () => 22`) and does not create a host client.
- `healthCheck` uses `probeSdkHost`, reports healthy with the version, and reports unhealthy when the probe throws.
- Provider key and tracing secrets are scrubbed from thrown details and logger output.
- Workspace changes fail with `workspace_modified`; unchanged/skipped git passes.

- [ ] **Step 2: Run the adapter tests to verify they fail**

Run: `npx vitest run test/agent-sdk-runtime.test.ts`

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement the adapter**

Port the reference `src/agent/opencode-sdk-runtime.ts` and replace direct SDK host calls with `SdkHostClient` calls:

- `startSession`: create `sessionDir` under `os.tmpdir()/opencode-sdk-sessions`, plus `config`, `data`, `state` subdirectories. Return the `AgentSession` without spawning.
- `ensureHost`:
  - Build the inline config with `buildSdkInlineConfig(this.config, process.env, { maxOutputTokens, reviewId, repository, pullRequestNumber })`.
  - Build `env = buildChildEnv(this.config, process.env, { reviewId: session.reviewId })`.
  - Set `env.XDG_CONFIG_HOME`, `env.XDG_DATA_HOME`, `env.XDG_STATE_HOME` to the session subdirectories.
  - Resolve `hostProcessPath` to `fileURLToPath(new URL("./sdk/host-process.js", import.meta.url))` unless supplied.
  - Call `createHostClient({ configContent: JSON.stringify(inlineConfig), databasePath: path.join(dir, "opencode.db"), workspacePath, env, hostProcessPath, spawnImpl, sessionId, reviewId, onStderr })`; `await client.start()`.
- Export the existing `buildPrompt(task)` from `opencode-runtime.ts` and import it in the SDK adapter; do not duplicate the JSON contract string.
- `execute`: total deadline timer; build the prompt with `buildPrompt(task)`; `client.prompt`; poll `client.getSession` every `pollIntervalMs`; `client.listMessages`; normalize usage; for JSON tasks, try assistant messages newest-first with `extractJson` and `task.validate` instead of concatenating all text; workspace guard.
- `terminate`: `client.removeSession` best effort, `client.close` best effort, `client.kill`, `rm`; idempotent.
- `healthCheck`: if `this.nodeMajorVersion() < 24`, return unhealthy with `opencode-sdk requires Node >= 24`; otherwise call the injected `probeSdkHost` with `buildChildEnv` and return `opencode-sdk <version>` or the normalized failure detail.
- Scrub provider/tracing secrets and truncate all details to 4 000 chars. Match the CLI adapter's scrubber: provider key value, `LANGFUSE_SECRET_KEY`, `OPENCODE_OTLP_HEADERS` and each header value, plus authorization/api-key patterns.
- Never log prompts, file contents or full message payloads.
- Export `createSdkAgentRuntime`.

- [ ] **Step 4: Run the adapter tests**

Run: `npx vitest run test/agent-sdk-runtime.test.ts`

Expected: PASS.

- [ ] **Step 5: Run the existing CLI adapter tests**

Run: `npx vitest run test/agent-runtime.test.ts`

Expected: PASS; no CLI behavior changed.

- [ ] **Step 6: Commit**

```bash
git add src/agent/opencode-sdk-runtime.ts src/agent/opencode-runtime.ts \
  test/agent-sdk-runtime.test.ts
git commit -m "feat(agent): add child-process OpenCode SDK adapter"
```

---

### Task 5: Add the runtime plugin registry and replace the old factory

**Files:**
- Create: `src/agent/runtime-registry.ts`
- Modify: `src/agent/opencode-runtime.ts` (remove `createAgentRuntime`)
- Modify: `src/agent/index.ts`
- Test: `test/agent-runtime-registry.test.ts`

**Interfaces:**
- Consumes: `OpenCodeAgentRuntime`, `OpenCodeRuntimeOptions`, `OpenCodeSdkAgentRuntime`, `SdkRuntimeOptions`, `AgentRuntimeError`, `AgentRuntimeConfigSource`.
- Produces:
  - `AgentRuntimePlugin { id: string; runtimeTypes: readonly string[]; create(runtimeType, config, options): AgentRuntime }`
  - `AgentRuntimeFactoryOptions = OpenCodeRuntimeOptions & SdkRuntimeOptions`
  - `registerAgentRuntimePlugin(plugin): void`
  - `listAgentRuntimePlugins(): Array<{ id: string; runtimeTypes: readonly string[] }>`
  - `openCodeRuntimePlugin`
  - `createAgentRuntime(config, options?): AgentRuntime`

- [ ] **Step 1: Write the failing registry tests**

Create `test/agent-runtime-registry.test.ts` with a local `baseConfig` fixture. Annotate every derived config fixture as `AgentRuntimeConfigSource` so the literal runtime types remain assignable. Import `AgentRuntimeError` from `../src/agent/types.js`, the adapters/types from `../src/agent/index.js` or their modules, and `vi` from Vitest. Cover:

```ts
it("selects the CLI adapter by default", () => {
  expect(createAgentRuntime(baseConfig)).toBeInstanceOf(OpenCodeAgentRuntime);
});

it("selects the SDK adapter when configured", () => {
  const sdkConfig = {
    ...baseConfig,
    agent: {
      ...baseConfig.agent,
      runtime: { ...baseConfig.agent.runtime, type: "opencode-sdk" },
    },
  };
  expect(createAgentRuntime(sdkConfig)).toBeInstanceOf(OpenCodeSdkAgentRuntime);
});

it("fails closed for a type with no plugin", () => {
  const config = {
    ...baseConfig,
    agent: {
      ...baseConfig.agent,
      runtime: { ...baseConfig.agent.runtime, type: "opencode-server" },
    },
  };
  try {
    createAgentRuntime(config);
    throw new Error("expected createAgentRuntime to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(AgentRuntimeError);
    expect((error as AgentRuntimeError).code).toBe("config");
  }
});

it("lets a plugin register a new runtime type", () => {
  const fakeRuntime = {
    startSession: vi.fn(),
    execute: vi.fn(),
    terminate: vi.fn(),
    healthCheck: vi.fn(),
  };
  const fake = {
    id: "test-plugin",
    runtimeTypes: ["test-runtime"],
    create: vi.fn(() => fakeRuntime),
  };
  registerAgentRuntimePlugin(fake);
  const runtime = createAgentRuntime({
    ...baseConfig,
    agent: {
      ...baseConfig.agent,
      runtime: { ...baseConfig.agent.runtime, type: "test-runtime" },
    },
  } as AgentRuntimeConfigSource);
  expect(runtime).toBe(fakeRuntime);
  expect(fake.create).toHaveBeenCalledWith(
    "test-runtime",
    expect.any(Object),
    expect.any(Object),
  );
});

it("rejects duplicate runtime-type registration", () => {
  expect(() =>
    registerAgentRuntimePlugin({
      id: "duplicate",
      runtimeTypes: ["opencode-cli"],
      create: vi.fn(),
    }),
  ).toThrow(/already registered/);
});

it("re-exports the factory and plugin API from the agent barrel", async () => {
  const barrel = await import("../src/agent/index.js");
  expect(typeof barrel.createAgentRuntime).toBe("function");
  expect(typeof barrel.registerAgentRuntimePlugin).toBe("function");
  expect(barrel.listAgentRuntimePlugins()).toContainEqual({
    id: "opencode",
    runtimeTypes: ["opencode-cli", "opencode-sdk"],
  });
});
```

The fake-plugin assertion must use the same fake instance; store it in a variable rather than calling `fake.create()` twice.

- [ ] **Step 2: Run the registry tests to verify they fail**

Run: `npx vitest run test/agent-runtime-registry.test.ts`

Expected: FAIL because `runtime-registry.ts` does not exist and `createAgentRuntime` still comes from `opencode-runtime.ts`.

- [ ] **Step 3: Implement the registry**

Create `src/agent/runtime-registry.ts`:

```ts
import { AgentRuntimeError, type AgentRuntime } from "./types.js";
import type { AgentRuntimeConfigSource } from "./opencode-config.js";
import {
  OpenCodeAgentRuntime,
  type OpenCodeRuntimeOptions,
} from "./opencode-runtime.js";
import {
  OpenCodeSdkAgentRuntime,
  type SdkRuntimeOptions,
} from "./opencode-sdk-runtime.js";

export type AgentRuntimeFactoryOptions = OpenCodeRuntimeOptions & SdkRuntimeOptions;

export interface AgentRuntimePlugin {
  readonly id: string;
  readonly runtimeTypes: readonly string[];
  create(
    runtimeType: string,
    config: AgentRuntimeConfigSource,
    options: AgentRuntimeFactoryOptions,
  ): AgentRuntime;
}

const registry = new Map<string, AgentRuntimePlugin>();

export function registerAgentRuntimePlugin(plugin: AgentRuntimePlugin): void {
  if (!plugin.id) throw new Error("agent runtime plugin id is required");
  for (const runtimeType of plugin.runtimeTypes) {
    if (registry.has(runtimeType)) {
      throw new Error(
        `agent runtime plugin already registered for type "${runtimeType}"`,
      );
    }
  }
  for (const runtimeType of plugin.runtimeTypes) {
    registry.set(runtimeType, plugin);
  }
}

export function listAgentRuntimePlugins(): Array<{
  id: string;
  runtimeTypes: readonly string[];
}> {
  const seen = new Set<string>();
  const plugins: Array<{ id: string; runtimeTypes: readonly string[] }> = [];
  for (const plugin of registry.values()) {
    if (seen.has(plugin.id)) continue;
    seen.add(plugin.id);
    plugins.push({ id: plugin.id, runtimeTypes: plugin.runtimeTypes });
  }
  return plugins;
}

export const openCodeRuntimePlugin: AgentRuntimePlugin = {
  id: "opencode",
  runtimeTypes: ["opencode-cli", "opencode-sdk"],
  create(runtimeType, config, options) {
    switch (runtimeType) {
      case "opencode-cli":
        return new OpenCodeAgentRuntime(config, options);
      case "opencode-sdk":
        return new OpenCodeSdkAgentRuntime(config, options);
      default:
        throw new AgentRuntimeError(
          "config",
          `opencode plugin does not implement runtime type "${runtimeType}"`,
        );
    }
  },
};

registerAgentRuntimePlugin(openCodeRuntimePlugin);

export function createAgentRuntime(
  config: AgentRuntimeConfigSource,
  options: AgentRuntimeFactoryOptions = {},
): AgentRuntime {
  const runtimeType = config.agent.runtime.type;
  const plugin = registry.get(runtimeType);
  if (!plugin) {
    throw new AgentRuntimeError(
      "config",
      `no agent runtime plugin registered for type "${runtimeType}"`,
    );
  }
  return plugin.create(runtimeType, config, options);
}
```

Remove the old `createAgentRuntime` function and `AgentRuntime` import if it becomes unused from `src/agent/opencode-runtime.ts`. Keep `OpenCodeAgentRuntime`, `buildPrompt`, `extractJson`, `AgentRuntimeLogger` and `OpenCodeRuntimeOptions`.

Update `src/agent/index.ts`. Keep the existing type and `opencode-config` export blocks, add `buildAgentTracingPlugin`/`AgentTracingInput` there, and add the registry/SDK blocks:

```ts
export {
  buildAgentTracingPlugin,
  buildChildEnv,
  buildPermissionRules,
  buildSessionConfig,
  resolveModelId,
  TOOL_ACTION_MAP,
  type AgentRuntimeConfigSource,
  type AgentTracingInput,
} from "./opencode-config.js";

export {
  buildPrompt,
  extractJson,
  OpenCodeAgentRuntime,
  type AgentRuntimeLogger,
  type OpenCodeRuntimeOptions,
} from "./opencode-runtime.js";

export {
  createAgentRuntime,
  listAgentRuntimePlugins,
  openCodeRuntimePlugin,
  registerAgentRuntimePlugin,
  type AgentRuntimeFactoryOptions,
  type AgentRuntimePlugin,
} from "./runtime-registry.js";

export {
  createSdkAgentRuntime,
  OpenCodeSdkAgentRuntime,
  type SdkRuntimeOptions,
} from "./opencode-sdk-runtime.js";
```

Keep the existing `types.js` export block. Do not export the internal SDK config/host/client modules from the barrel.

- [ ] **Step 4: Run the registry, CLI and barrel tests**

Run: `npx vitest run test/agent-runtime-registry.test.ts test/agent-runtime.test.ts`

Expected: PASS, including the existing `"factory createAgentRuntime returns the AgentRuntime abstraction"` test.

- [ ] **Step 5: Verify no stale factory remains**

Run: `grep -R "export function createAgentRuntime" src/agent`

Expected: exactly one match, in `src/agent/runtime-registry.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/agent/runtime-registry.ts src/agent/opencode-runtime.ts \
  src/agent/index.ts test/agent-runtime-registry.test.ts
git commit -m "feat(agent): add pluggable runtime registry"
```

---

### Task 6: Move production to Node 24 and install the SDK dependency

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json` (generated)
- Modify: `Dockerfile`
- Create: `test/deployment-node.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a production image and dependency graph where both adapters are available; `@opencode/sdk@2.3.0` is present in `npm ci --omit=dev`.

- [ ] **Step 1: Write the failing deployment tests**

Create `test/deployment-node.test.ts`:

```ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");

describe("production Node and SDK runtime", () => {
  it("uses the pinned Node 24 image in both Dockerfile stages", () => {
    const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");
    expect(dockerfile.match(/^FROM node:24\.22\.3-slim.*$/gm)).toHaveLength(2);
  });

  it("declares Node >= 24 and the SDK as a production dependency", () => {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    expect(pkg.engines.node).toBe(">=24");
    expect(pkg.dependencies["@opencode/sdk"]).toBe("2.3.0");
    expect(pkg.devDependencies?.["@opencode/sdk"]).toBeUndefined();
  });
});
```

The single regular expression must match both stage lines; there is no separate runtime-stage assertion.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/deployment-node.test.ts`

Expected: FAIL because the Dockerfile is still Node 22.14.0 and `@opencode/sdk` is absent.

- [ ] **Step 3: Add the dependency and update the image**

Run:

```bash
npm install --save-exact @opencode/sdk@2.3.0
```

Then edit `package.json`:

```json
"engines": {
  "node": ">=24"
}
```

`@opencode/sdk` must be under `dependencies`, not `devDependencies`. Do not hand-edit `package-lock.json`; let npm generate it. After editing the engine field, run `npm install --package-lock-only` so the lockfile root metadata stays in sync.

Edit `Dockerfile` so both stages use:

```dockerfile
FROM node:24.22.3-slim AS build
```

and

```dockerfile
FROM node:24.22.3-slim
```

Keep the existing OpenCode CLI `ARG OPENCODE_VERSION=2.2.6` and the tracing plugin pre-install unchanged.

- [ ] **Step 4: Run the deployment test and verify the production install**

Run:

```bash
npx vitest run test/deployment-node.test.ts
npm ls @opencode/sdk --omit=dev
npm run build
```

Expected: the test passes; `npm ls` lists `@opencode/sdk@2.3.0`; the build succeeds.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json Dockerfile test/deployment-node.test.ts
git commit -m "build: run production on Node 24 with the OpenCode SDK"
```

---

### Task 7: Document the runtime plugin and deployment change

**Files:**
- Create: `docs/agent-runtime-plugins.md`
- Modify: `docs/architecture.md` (§2.2 table, §3.1 diagram, §8.1–§8.4, config example)
- Modify: `docs/deployment.md` (Node 24, SDK dependency, memory, fail-closed)
- Modify: `docs/how-pr-review-works.md` (runtime selection note)
- Modify: `README.md` (local Node requirement)

**Interfaces:**
- Consumes: the implemented config, registry and adapter behavior.
- Produces: operator-facing documentation that matches the code.

- [ ] **Step 1: Write the operator and plugin guide**

Create `docs/agent-runtime-plugins.md` with these sections:

1. **What the runtime plugin is** — `agent.runtime.type` selects a registered plugin; the built-in `opencode` plugin provides `opencode-cli` and `opencode-sdk`.
2. **Configuration** — a JSON example for the SDK type (and a one-line equivalent for the CLI type):

```json
{
  "agent": {
    "runtime": {
      "type": "opencode-sdk",
      "sessionStrategy": "per-review",
      "timeoutMs": 900000
    }
  }
}
```

State that `opencode-cli` is the default and `opencode-sdk` is opt-in.

3. **Plugin API** — show the `AgentRuntimePlugin` interface and `registerAgentRuntimePlugin`; explain that duplicate runtime types are rejected and unknown types fail with `AgentRuntimeError("config", ...)`.
4. **CLI vs SDK** — table: CLI spawns `opencode run --format json`; SDK runs `@opencode/sdk` in a sanitized child process, uses inline config, polls `sessions.get(...).time.idle`, and requires Node >= 24.
5. **Security boundary** — sanitized child env, deny-by-default permissions, workspace integrity guard, secret scrubbing; state that this is logical isolation, not a kernel sandbox.
6. **Tracing** — both paths emit the same `plugins` entry; the SDK child receives the same tracing env allowlist.
7. **Failure behavior** — fail closed, no fallback; list the normalized codes.
8. **Operations** — Node 24 image, SDK dependency, one child process per active SDK review, memory expectation, and how to verify with `npm ls @opencode/sdk --omit=dev`.

- [ ] **Step 2: Update the architecture document**

In `docs/architecture.md`:

- §2.2 table: change `Agent runtime` to `OpenCode CLI (default) or OpenCode SDK via runtime plugin`.
- §3.1 diagram: label the agent runtime node as `Agent Runtime Plugin (OpenCode CLI/SDK)`.
- §8.1: keep the CLI as the recommended initial implementation; add the SDK adapter as an opt-in child-process adapter behind the same contract.
- §8.2: add `AgentRuntimePlugin` and `createAgentRuntime` to the abstraction description.
- §8.3: state that both adapters use one isolated session per review; the SDK uses a child process.
- §8.4: state that both adapters fail closed and never fall back to another runtime.
- Configuration example around line 1125: keep `opencode-cli` as the default and add a one-line note that `opencode-sdk` is the opt-in alternative.

- [ ] **Step 3: Update deployment documentation**

In `docs/deployment.md`:

- Add a short `Runtime selection` section with the two config types and the fail-closed rule.
- State the production image is Node 24.22.3 and why (SDK requires Node >= 24).
- State `@opencode/sdk@2.3.0` is a production dependency and is installed by `npm ci --omit=dev`.
- Add a memory note: the SDK path adds a child Node process per active SDK review; the worker limit is 1536 MB and queue concurrency should stay at 1 unless measured otherwise.
- Keep the existing CLI/tracing sections unchanged except for the runtime-selection note.

- [ ] **Step 4: Update the teaching guide and README**

In `docs/how-pr-review-works.md`, add a short note near the runtime section: the CLI path is the default; `agent.runtime.type: "opencode-sdk"` selects the embedded SDK host in a sanitized child process.

In `README.md`, update the local development prerequisites to state Node >= 24.

- [ ] **Step 5: Run the docs-adjacent checks**

Run:

```bash
npm run config:validate
npx vitest run test/review-config.test.ts test/deployment-node.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Stage only the documentation files listed above. If `docs/deployment.md` or `README.md` already contains unrelated uncommitted changes, do **not** stage them wholesale:

```bash
git add docs/agent-runtime-plugins.md docs/architecture.md docs/how-pr-review-works.md
git add -p docs/deployment.md README.md
git commit -m "docs(agent): document pluggable CLI and SDK runtimes"
```

If pre-existing edits in those two files make a clean patch-add impossible, leave the runtime documentation in the new guide and `docs/architecture.md`, and report the pending README/deployment wording instead of committing someone else's work.

---

### Task 8: End-to-end verification and branch hygiene

**Files:**
- No new files.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: evidence that the plugin path, both adapters, config and deployment are consistent.

- [ ] **Step 1: Run the focused agent/config/deployment suite**

Run:

```bash
npx vitest run \
  test/review-config.test.ts \
  test/agent-runtime.test.ts \
  test/agent-sdk-config.test.ts \
  test/agent-sdk-host.test.ts \
  test/agent-sdk-client.test.ts \
  test/agent-sdk-runtime.test.ts \
  test/agent-runtime-registry.test.ts \
  test/deployment-node.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`

Expected: PASS. If an unrelated pre-existing failure appears, record it and confirm it also fails on the base commit; do not change unrelated code.

- [ ] **Step 3: Build and validate config**

Run:

```bash
npm run build
npm run config:validate
npm ls @opencode/sdk --omit=dev
```

Expected: build exits 0; config validation passes with the checked-in `config/review.json`; `npm ls` lists `@opencode/sdk@2.3.0`.

- [ ] **Step 4: Verify the experiment branch was not merged**

Run:

```bash
git status --short
find src -path '*sdk*' -maxdepth 5 -type f
grep -R -E "agent\.sdk|shadowMode|experiments/sdk-runtime|deploy/sdk" \
  src test docs package.json Dockerfile --exclude-dir=plans || true
```

Expected: no `agent.sdk`, `shadowMode`, experiment worker, proxy or separate compose files in the production tree. The only SDK files are `src/agent/opencode-sdk-runtime.ts` plus the adapter/config/host/client modules under `src/agent/sdk/`.

- [ ] **Step 5: Verify the working tree contains only intended changes**

Run: `git status --short`

Expected: the files listed by this plan are modified/created. Any pre-existing unrelated README/deploy/admin changes remain unstaged and untouched. If an unrelated file was accidentally staged, unstage it with `git restore --staged <path>`; do not discard it.

- [ ] **Step 6: Staging trace check (when tracing is enabled)**

Run one `opencode-sdk` review against a restricted repository with `observability.agentTracing.enabled: true`. Confirm the configured Phoenix/Langfuse backend receives a trace with `review.id`, `repository` and `pr.number`. If the SDK host does not load the plugin, record the failure and keep `opencode-cli` for traced reviews; do not claim tracing parity based only on config tests.

- [ ] **Step 7: Optional production image smoke test**

If Docker is available and the host has enough memory, run:

```bash
docker build -t probot-runtime-plugin-check .
```

Expected: build exits 0 and the final image uses the Node 24 base. This is optional because the test suite already checks the Dockerfile and dependency invariants; record the result if run.

- [ ] **Step 8: Final commit**

```bash
git add docs/plans/2026-11-14-opencode-runtime-plugin.md
git commit -m "docs(plan): add OpenCode runtime plugin implementation plan"
```

If the plan document should not be committed on this branch, leave it unstaged and report its path instead.

---

## Self-Review

**Spec coverage**

- Runtime selection by config: Task 1 and Task 5.
- OpenCode as a plugin with CLI and SDK adapters: Task 3, Task 4 and Task 5.
- SDK child-process isolation with sanitized env: Task 3 and Task 4.
- Fail-closed behavior: Task 4 (import/host/health failures) and Task 5 (unknown runtime type).
- Deny-by-default permissions and secret-path denials: Task 2.
- Tracing parity: Task 2 and Task 7.
- Node 24 and production dependency: Task 6.
- Documentation and operator guidance: Task 7.
- Verification: Task 8.

**Step scan**

Every code task (1-6) has a failing test, a run-to-fail step, an implementation step, a run-to-pass step and a commit. Task 7 is documentation and validates with config/deployment checks. Task 8 is verification. Tasks 3 and 4 use injected fakes so no real SDK or network call is required. The only environment-dependent step is the staging trace check and the optional Docker build in Task 8.

**Type consistency**

- `AgentRuntimeConfigSource["agent"]["runtime"]["type"]` gains `"opencode-sdk"` in Task 1 and is consumed by the registry in Task 5.
- `SdkHostClient` methods match the calls used by the SDK adapter in Task 4.
- `probeSdkHost` returns `{ version: string }` and is consumed by `healthCheck` in Task 4.
- `AgentRuntimeFactoryOptions` is the intersection of `OpenCodeRuntimeOptions` and `SdkRuntimeOptions`, so both adapters accept the factory options object.
- The registry's plugin `create` signature matches both concrete constructors.

**Review Focus mapping**

- Unknown runtime type: Task 5 registry test.
- SDK on Node < 24 / missing package: Task 4 health/execute tests.
- Child crash/non-protocol stdout: Task 3 client tests.
- Timeout/hung calls: Task 4 timeout tests.
- Secret leakage: Task 4 secret-hygiene test.
- Workspace modification: Task 4 workspace guard tests.
- Concurrent reviews: Task 4 concurrent-session test.
- Tracing parity: Task 2 tracing test.
- Config/JSON Schema drift: Task 1 mirror test.
- Existing CLI behavior: Task 4 Step 5 and Task 8 full suite.
