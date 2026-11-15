# Agent Runtime Plugins

This guide describes how the review worker selects and runs its agent runtime,
how the built-in plugin is structured, and what changes when you opt into the
OpenCode SDK adapter instead of the default OpenCode CLI.

Related documents:

- [`docs/architecture.md`](architecture.md) §9 — agent runtime and model
  provider.
- [`docs/deployment.md`](deployment.md) — production Node version, image and
  memory limits.
- [`docs/how-pr-review-works.md`](how-pr-review-works.md) Step 7 — how a review
  drives the runtime stage by stage.

---

## 1. What the runtime plugin is

The application never constructs a concrete agent adapter directly.
`agent.runtime.type` in `config/review.json` names a **runtime type**, and the
runtime registry maps that type to the registered plugin that creates it.

The built-in plugin has id `opencode` and owns the two active runtime types
(plus two reserved names it does not register):

| Runtime type | Status | Behavior |
| --- | --- | --- |
| `opencode-cli` | Default | Spawns the `opencode` CLI (`opencode run --format json`). |
| `opencode-sdk` | Opt-in | Runs `@opencode/sdk` inside an isolated child Node process. |
| `opencode-server` | Reserved | Allowed by the config schema, but no plugin registers it. Fails closed. |
| `custom` | Reserved | Allowed by the config schema, but no plugin registers it. Fails closed. |

Selecting a reserved type does not silently pick another runtime: runtime
construction throws `AgentRuntimeError` with code `config`, and the worker does
not start.

## 2. Configuration

Runtime selection lives in the `agent.runtime` block. The SDK form is:

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

The CLI equivalent is one line inside the same block:

```json
{ "agent": { "runtime": { "type": "opencode-cli" } } }
```

`opencode-cli` is the default, including when `type` is omitted. `opencode-sdk`
is opt-in and requires Node >= 24 (see §8).

`timeoutMs` bounds the whole review agent execution. The schema accepts
`sessionStrategy`, but the current adapters implement one isolated session per
review only; other values do not change their behavior.

> `npm run config:validate` checks the JSON Schema, which accepts all four
> runtime type names. It cannot prove that a type has a registered plugin.
> `opencode-server` and `custom` therefore pass schema validation but fail at
> runtime construction with `AgentRuntimeError("config", ...)`.

## 3. Plugin API

The registry is implemented in `src/platform/agents/runtime-registry.ts`. A plugin
declares one or more runtime types and creates an adapter for each:

```typescript
export interface AgentRuntimePlugin {
  readonly id: string;
  readonly runtimeTypes: readonly string[];
  create(
    runtimeType: string,
    config: AgentRuntimeConfigSource,
    options: AgentRuntimeFactoryOptions,
  ): AgentRuntime;
}

export function registerAgentRuntimePlugin(plugin: AgentRuntimePlugin): void;

export function createAgentRuntime(
  config: AgentRuntimeConfigSource,
  options: AgentRuntimeFactoryOptions = {},
): AgentRuntime;
```

Rules enforced by the registry:

- The built-in `opencode` plugin registers `opencode-cli` and `opencode-sdk`
  when the module is imported.
- Registering a plugin whose runtime type is already registered throws. The
  registry never overwrites an existing type.
- `createAgentRuntime` looks up `config.agent.runtime.type` once. If no plugin
  owns the type, it throws `AgentRuntimeError("config", ...)`. There is no
  fallback to another adapter.
- The plugin's `create` must still honor the requested type. The built-in
  plugin rejects a type it does not implement with the same `config` code.

Application code depends only on the `AgentRuntime` interface
(`startSession`, `execute`, `terminate`, `healthCheck`), not on CLI- or
SDK-specific types. Plugins are registered in-process; the configuration
schema currently names only the four runtime types above, so a genuinely new
runtime type also needs a schema change before it can be selected.

## 4. CLI vs SDK

| Concern | `opencode-cli` (default) | `opencode-sdk` (opt-in) |
| --- | --- | --- |
| Execution | Spawns `opencode run --format json --print-logs <prompt>` | Spawns a child Node process that hosts `@opencode/sdk@2.3.0` |
| Process model | One CLI process per stage execution | One host child process per active review session (one session per review) |
| Configuration | Writes a per-session `opencode.json` | Passes inline config (`config.content`); no config file on disk |
| Session storage | Per-session config/data directories | Per-session XDG config/data/state directories and a per-session SDK database |
| Completion detection | Parses newline-delimited JSON events from the CLI | Polls `sessions.get(...).time.idle` (event stream is not reliable enough) |
| Node requirement | Runs in the Node 24 worker image (the CLI binary itself is standalone) | Node >= 24, enforced by the adapter health check |
| Model access | OpenAI-compatible provider through the CLI config | Same provider through inline SDK provider config; provider key is an `{env:NAME}` reference |
| Tracing | Emits the shared `plugins` entry | Emits the same `plugins` entry |
| Isolation | Sanitized env, deny-by-default permissions, workspace guard | Sanitized env, deny-by-default permissions, workspace guard, per-session host |

Both adapters use the same prompt builder, JSON extraction, output validation,
timeout normalization and secret scrubbing helpers (`src/platform/agents`), so
review logic is unchanged by the selection.

The CLI adapter remains the recommended initial implementation. The SDK
adapter is an opt-in alternative behind the same contract; it exists so the
runtime can move off spawning the CLI without redesigning the review engine.

## 5. Security boundary

Both adapters treat repository content and PR diffs as untrusted. Defenses:

- **Sanitized child environment.** The agent does not inherit the worker's
  environment. `buildChildEnv` passes only `PATH`, `HOME`, `TMPDIR`, `LANG`,
  `LC_ALL`, `TERM`, the configured model-provider credential
  (`provider.apiKeyEnv`) plus `MODEL_BASE_URL` / `MODEL_NAME`, and the tracing
  variables relevant to the selected tracing plugin. GitHub credentials and
  other application secrets are never visible to the agent.
- **Deny-by-default permissions.** The SDK inline config starts with catch-all
  `deny` rules, re-allows only the read-only actions mapped from
  `agent.tools.enabled` (`read`, `grep`, `glob`), then denies secret paths
  (`.env`, `*.env`, `*.env.*`, credential-like names, `.git-credentials`) and
  `external_directory` access. Write, edit and shell actions stay denied. The
  CLI adapter applies the equivalent permission policy in its session config.
- **Workspace integrity guard.** The runtime snapshots
  `git status --porcelain` before and after each execution and fails with
  `AgentRuntimeError("workspace_modified")` if the agent changed the review
  workspace. This compensates for permission-enforcement gaps, notably the
  CLI versions whose `run` mode does not fully enforce `permission` rules.
- **Secret scrubbing.** Error details and log lines are scrubbed for the model
  API key, the Langfuse secret key, OTLP header values and generic
  authorization/API-key patterns, then truncated.
- **Per-session isolation.** Each review gets its own working directory,
  session directories and (for the SDK) its own host process and database. No
  conversation state is shared between reviews or repositories.

This is **logical isolation, not a kernel sandbox**. The SDK host is a child
process running as the same OS user, with a sanitized environment and
per-session XDG directories; it is not a container. The deployment's wider
isolation model is described in [`docs/deployment.md`](deployment.md) §5.
Treat this boundary as defense-in-depth: it limits what the agent can read and
do, but it does not make the child process equivalent to a VM or a dedicated
sandbox container.

## 6. Tracing

When `observability.agentTracing.enabled` is true, both adapters call the same
`buildAgentTracingPlugin` helper. The resulting `plugins` entry — pinned
`@devtheops/opencode-plugin-otel@2.1.0` by default, or the configured
Langfuse plugin — is written identically into the CLI session config and the
SDK inline config, with the same secret-free correlation tags
(`review:<id>`, `repository:<owner/name>`, `pr:<number>`).

The SDK host child receives the same tracing environment allowlist as the CLI
child through `buildChildEnv`, and only the credentials for the selected
backend are forwarded (OTel child never receives Langfuse keys, and vice
versa). Credentials stay in the child environment and are never serialized
into configuration.

The CLI image pre-installs the tracing plugin and loads it in `opencode run`
mode (see [`docs/deployment.md`](deployment.md) §3). The SDK path emits the
same plugin entry, but real plugin loading in the SDK host still needs
confirmation in a staging deployment; verify that the child logs show the
plugin being loaded and that traces reach Phoenix/Langfuse after switching
runtime types.

## 7. Failure behavior

Both adapters **fail closed**. There is no fallback to the other runtime, no
automatic model switch and no unbounded retry. A runtime or provider failure
fails the review.

Failures are normalized to `AgentRuntimeError` with one of these codes:

| Code | Meaning |
| --- | --- |
| `config` | Invalid runtime configuration, unknown/unregistered runtime type, or use of a terminated session. |
| `spawn` | The runtime binary or SDK host process could not be launched. |
| `crash` | The runtime process exited abnormally or the SDK execution failed outside a more specific code. |
| `timeout` | Execution exceeded the configured timeout (including host start, prompt, polling and output reads). |
| `provider_unavailable` | The model provider rejected or could not serve the request. |
| `invalid_output` | Missing, malformed or schema-invalid structured output. |
| `permission_denied` | A mandatory tool permission blocked the task. |
| `workspace_modified` | The post-run integrity guard detected workspace changes. |
| `unknown` | Unclassified runtime failure. |

Selecting `opencode-sdk` on Node < 24 does not run: `healthCheck()` reports
`opencode-sdk requires Node >= 24`, and the host cannot load the SDK on older
Node versions. There is no automatic downgrade to the CLI.

## 8. Operations

- **Node version.** The production image pins `node:24.22.3-slim` in both
  Dockerfile stages, and `package.json` declares `engines.node >= 24`. The SDK
  requires Node >= 24; do not run the SDK runtime on an older host.
- **SDK dependency.** `@opencode/sdk@2.3.0` is a production dependency. The
  runtime image installs it with `npm ci --omit=dev`. Verify an installed
  deployment with:

  ```sh
  npm ls @opencode/sdk --omit=dev
  ```

  The CLI binary remains in the image (`OPENCODE_VERSION` in the Dockerfile)
  because `opencode-cli` is still the default and the rollback path.
- **Effect peer dependency.** `effect@4.1.0` is pinned as a direct production
  dependency. The OpenCode SDK packages peer-depend on Effect 4.1, while
  Prisma 6.19.3 depends on Effect 3.21. Without the root pin, npm hoists
  Prisma's 3.21 into the SDK's peer slot and real session creation fails with
  an internal `session.created` schema error. Prisma keeps its own 3.21 copy
  nested. Do not remove this pin without re-running the live SDK smoke test.
- **Memory.** Each active SDK review adds a child Node process (the SDK host)
  on top of the worker. The worker container limit is 1536 MB. Keep
  `queue.concurrency` at 1 unless you have measured a higher concurrency with
  `docker stats` / the worker memory metric; the CLI path uses one CLI process
  per stage, while the SDK keeps one host process per active review.
- **Switching runtime.** Change `agent.runtime.type` in `config/review.json`,
  redeploy, and confirm a review completes. SDK runs log
  `agent_sdk_session_created` / `agent_sdk_execute_completed`; failures log
  `agent_sdk_execute_failed` with a normalized code. Confirm tracing in
  staging before relying on it (§6).
- **Rolling back.** Set `agent.runtime.type` back to `opencode-cli` and
  redeploy. No data migration is involved; each path uses its own per-session
  temporary directories.
- **Fail-closed checks.** A reserved type (`opencode-server`, `custom`) or a
  missing plugin stops runtime construction with `config`. Watch worker
  startup logs after a configuration change rather than assuming
  `npm run config:validate` covers plugin availability.
