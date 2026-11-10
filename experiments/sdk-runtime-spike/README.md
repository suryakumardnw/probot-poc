# OpenCode SDK Phase 0 spike

**Throwaway experiment. Not production code. Do not import from `src/`.**

This package answers the Phase 0 go/no-go questions from
`docs/architecture-sdk-runtime.md` §12–13: can `@opencode/sdk@2.2.7` run with
inline configuration, route to the existing OpenAI-compatible GLM provider,
enforce the review permission model, register a review-scoped Promise plugin,
keep concurrent reviews logically separate, and clean up reliably?

> **Node requirement: `@opencode/sdk@2.2.7` requires Node >= 24.**
> Its `@opencode/util` dependency uses `await using` syntax, which Node 20.18.1
> and Node 22.14.0 cannot parse (raw `SyntaxError`). This spike therefore
> refuses to import the SDK below Node 24, records an `unsupported` result and
> exits `3`. Node 20.18 and the current production Node 22.14.0 are
> **unsupported**; the production image must be upgraded to Node >= 24 (or the
> SDK avoided) before Phase 1.

It is a standalone npm package so root `package.json` / `package-lock.json`
stay untouched.

## What it does

1. Checks the Node major version **before** importing `@opencode/sdk`
   (dynamic `await import(...)`). Node < 24 writes an `unsupported` result and
   exits `3` without a raw `SyntaxError` or model calls; supported runs record
   the actual Node version.
2. Creates one embedded host with **inline** config (`config.content`), not a
   config file, plus a temp SQLite database.
3. Builds the existing `reviewer` provider shape from
   `src/agent/opencode-config.ts`: package
   `@opencode/ai/providers/openai-compatible`, `settings.baseURL`,
   `settings.apiKey: "{env:MODEL_API_KEY}"` and `models.glm.modelID = MODEL_NAME`.
4. Verifies the ordered v2.2.7 `permissions` array: deny everything, allow
   `read`/`grep`/`glob`, deny `.env`/`*.env` reads, deny `external_directory`.
5. Registers a Promise plugin per review through `instances` keyed by
   `session.metadata.reviewId`. The plugin adds the `review_read_file` tool and
   an `execute.before` audit hook. Workspace root and `reviewId` come from the
   plugin closure; the model only supplies a relative path. The safe reader
   rejects `.env`, `.env.*`, any basename containing `.env.` (e.g.
   `prod.env.local`, `config.prod.env.bak`), `credential`/`credentials` anywhere
   in the relative path, and `.git-credentials`.
6. Creates one investigation session per review
   (`host.sessions.create({ location: { directory }, metadata: { reviewId } })`).
7. Runs a structured JSON request, extracts/validates the JSON, and checks the
   custom tool call and audit entry.
8. Prompts the model to create `pwned.txt`, overwrite tracked `src/app.js`,
   delete `src/app.js`, read `.env`, and write outside the workspace. It then
   checks the filesystem, SHA-256 hashes and `git status --porcelain`, and
   records each tool-call result (expected permission errors).
9. Runs two sessions concurrently in separate workspace directories and
   different `reviewId`s. Each workspace has a unique marker file
   (`REVIEW_MARKER_A` / `REVIEW_MARKER_B`); both sessions must complete their own
   `review_read_file` call, and each tool result must contain its own marker and
   not the other session's marker. Zero tool calls fail the check (one retry is
   attempted). Outputs and audits must not cross.
10. Measures host create/close time, per-session create time, sampled peak RSS
    (authoritative `peakRssBytes`) and `process.resourceUsage().maxRSS` (kept as
    a secondary cross-check only).
11. Removes sessions, closes the host with an explicit `close()` in `finally`,
    and deletes temp workspaces unless `SPIKE_KEEP_WORKSPACE=1`.

## Run it

**Requires Node >= 24.** On older Node the spike exits `3` with an
`unsupported` `node-runtime` result instead of crashing.

From this directory:

```bash
npm install                 # already done in this checkout
npm run spike:offline       # no model calls
npm run spike               # real GLM/OpenAI-compatible calls
```

`spike:offline` sets `SPIKE_SKIP_MODEL=1`. It exercises host lifecycle, inline
config, permission-rule validation, plugin unit setup, path/symlink/size probes
and cleanup without credentials or model traffic. Missing `MODEL_*` values fall
back to offline placeholders.

Node matrix (offline probes):

```bash
npm run spike:offline                                             # current Node (26.x)
SPIKE_SKIP_MODEL=1 npx -y node@24.0.0 src/spike.mjs               # exit 0
SPIKE_SKIP_MODEL=1 npx -y node@20.18.1 src/spike.mjs              # exit 3, unsupported
SPIKE_SKIP_MODEL=1 npx -y node@22.14.0 src/spike.mjs              # exit 3, unsupported
```

`npm run spike` reads the repository root `.env` (never printed). Required:

| Variable | Purpose |
| --- | --- |
| `MODEL_BASE_URL` | OpenAI-compatible base URL |
| `MODEL_NAME` | Upstream model id used as `models.glm.modelID` |
| `MODEL_API_KEY` | Bearer key, referenced only as `{env:MODEL_API_KEY}` |

Optional environment variables:

- `SPIKE_PROMPT_TIMEOUT_MS` — per-prompt completion timeout, default `300000`.
- `SPIKE_KEEP_WORKSPACE=1` — keep `.work/run-*` for debugging.
- `SPIKE_SKIP_MODEL=1` — same as `spike:offline`.

The GLM reasoning calls are slow. The real run makes four model turns (one
structured, one adversarial, two concurrent) and typically takes 30–120 seconds
with the observed endpoint; allow several minutes. Each prompt has its own
timeout. If the concurrency pair does not both complete their required
`review_read_file` call, the pair is retried once before the check fails.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Every critical check passed |
| `1` | Security or isolation failure |
| `2` | Provider/GLM or compatibility failure |
| `3` | Missing required env/configuration, or unsupported Node (< 24) |

## Reading the results

Console output is a compact PASS/FAIL/SKIP list. The full machine-readable
evidence is written to:

```
.work/results-<timestamp>.json
```

Key fields:

- `meta` — Node version, `nodeMajor`, `nodeRequired` (`>=24`),
  `nodeSupported`, platform, SDK version, offline/real mode.
- `nodeRuntime` — present on unsupported Node:
  `{check:"node-runtime", status:"unsupported", required:">=24", actual:...}`.
- `provider` — provider id, package, base-URL host, model name, key presence
  (never the key value).
- `inlineConfig` — serialized config size and provider shape.
- `permissionConfig.evaluated` — wildcard last-match-wins decisions for read,
  edit, write, shell and external-directory cases.
- `workspaces.mainBeforeAdversarial` / `mainAfterAdversarial` — git status,
  hashes, `pwned.txt` existence.
- `adversarial.attempts` — every model tool attempt with status/error.
- `rounds` — the original `prompt` string, duration, idle detection source,
  assistant text (`assistantText`), reasoning, tool calls and results for each
  turn. `prompt` is never overwritten with model output.
- `isolation` — concurrent session attempts, per-review audit counts, tool-call
  marker evidence, cross-check results. `mode` is always `logical-only`.
- `plugin.directProbes` — allowed read plus traversal, absolute path, directory
  symlink escape, file symlink escape, `.env`, `prod.env.local`,
  `config.prod.env.bak`, `credentials/token.txt`, `.git-credentials`, and 64 KiB
  truncation probes.
- `plugin.setupCalls` / `plugin.audits` — per-review plugin setup count and
  closure-local audit entries.
- `metrics` — timings, sampled `peakRssBytes` (authoritative), and `maxRssKb`
  (secondary cross-check only).
- `cleanup` — removed sessions, host close result, workspace deletion.
- `summary` — pass/fail/skip counts, critical and security failure counts. An
  unsupported-Node run records `status: "unsupported"` on the critical
  `node-runtime` check and exits `3`.

All strings are scrubbed against the loaded API key and the spike's fake secret
markers before being written or logged. Model output is stored for evidence.

## Check semantics (short)

| Check | Meaning |
| --- | --- |
| `node-runtime` | Node >= 24 before SDK import; `< 24` → `unsupported`, exit 3 |
| `esm-import`, `host-created` | ESM import and `OpenCode.create` work |
| `inline-config-built` | config is inline and targets `reviewer/glm` |
| `permission-config-shape` | ordered rules serialize and evaluate as intended |
| `plugin-*` | safe reader rejects escapes/secrets, caps size |
| `plugin-unit-setup` | offline-only direct `plugin.setup` registration probe |
| `instances-key-configure` | `reviewId` keys map to independent plugin closures |
| `structured-json` | assistant JSON extracted and fields validated |
| `custom-tool-call` | model actually called `review_read_file`, audit recorded |
| `adversarial-filesystem-integrity` | no file changes, no secret leak, clean git |
| `adversarial-permission-enforcement` | each forbidden model attempt errored |
| `concurrent-isolation` | both sessions completed a tool call with own marker only, no cross leakage |
| `host-closed`, `sessions-removed`, `workspace-cleanup` | cleanup completed |

## Known limitations / observations

- **`@opencode/sdk@2.2.7` requires Node >= 24.** `@opencode/util` uses
  `await using`, which Node 20.18.1 and Node 22.14.0 cannot parse. This spike
  checks the major version before importing the SDK and reports `unsupported`
  (`node-runtime`, exit 3) below 24. The current production Dockerfile is Node
  22.14.0, so it **cannot run this SDK**; upgrade the production image to Node
  >= 24 (or avoid the SDK) before Phase 1. Verified on Node 26.12.0 and 24.0.0
  (supported) and 20.18.1 / 22.14.0 (gracefully unsupported).
- **Event-driven completion was not observed.** `session.idle` events were not
  seen reliably even though turns completed. The spike subscribes to
  `session.idle` / `session.execution.failed` but polls
  `sessions.get(...).time.idle` as the actual completion mechanism. Results
  record `idle.via` as `event` or `poll-session`. Persistent-session continuity
  (multiple turns in the same session) is demonstrated, but event-driven
  completion remains **unproven** on this SDK version. Polling remains the
  implementation.
- `host.message.list` does **not** initialise per-session instances/plugins.
  Plugin setup happens when the session first executes a turn, so offline mode
  uses a direct `plugin.setup` unit probe.
- The v2.2.7 permission schema is the ordered `permissions` **array**
  (`{action, resource, effect}`), not the older `permission` object. The
  wildcard matcher is anchored, so `*.env` also covers bare `.env`.
- The custom tool must declare `options.permission: "read"`; otherwise the
  catch-all deny makes it appear wholly disabled and it is hidden from the
  model.
- **Concurrent isolation is logical only.** It uses separate Location
  directories and `reviewId`-keyed instances. Both sessions must complete their
  own `review_read_file` call and return only their own marker; this is not a
  hard security boundary. The Phase 1 container boundary is still required.
- **Memory measurement caveat.** `peakRssBytes` is the authoritative value,
  sampled from `process.memoryUsage().rss` at 50 ms intervals. `maxRssKb`
  (`process.resourceUsage().maxRSS`) is kept only as a secondary kernel
  cross-check; it is a high-water mark, not a sampled time series, and the two
  can legitimately differ.
- An early real run saw a transient `invalid_token` 401 from the provider; a
  later run with the same environment succeeded. Provider-side availability is
  outside this spike's control.
- The adversarial model falsely claimed `write pwned.txt` succeeded while the
  tool returned `Permission denied: edit`. Filesystem evidence, not model text,
  is authoritative.

## Do not

- Do not build production code on this package.
- Do not import `review_read_file`/plugin helpers into `src/`.
- Do not treat this as an approval to enable the SDK runtime.
- Do not commit `.work/` results (gitignored).
