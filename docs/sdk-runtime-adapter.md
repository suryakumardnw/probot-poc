# OpenCode SDK Runtime Adapter (Phase 2a)

> **Experimental — not authorized for production.** This document describes an
> isolated experiment behind `agent.sdk.enabled`, which defaults to `false`.
> The production runtime remains `opencode-cli`. Nothing here changes the
> production CLI path while the flag is off.

## What it is

`src/agent/opencode-sdk-runtime.ts` implements the existing `AgentRuntime`
contract (`startSession` / `execute` / `terminate` / `healthCheck`) on top of
`@opencode/sdk@2.2.7`. It is selected by the flag-aware factory in
`src/agent/factory.ts`; everything else in the review pipeline talks to the
same interface it already used.

Phase 2a scope:

- Inline SDK host configuration (`config.content`), no config file written.
- A custom OpenAI-compatible provider (`reviewer` / model `glm`) using the same
  base URL, API key env var and model resolution as the CLI runtime.
- An ordered, deny-by-default permission array (last match wins): read-only
  mapped tools only, secret paths denied, `external_directory` denied.
- Host-per-review: one host is created lazily on the first `execute` and
  closed by `terminate`. The long-lived host is Phase 3.
- Polling completion via `sessions.get(...).time.idle` (Phase 0 showed the
  `session.idle` event stream is unreliable), plus the existing
  `git status --porcelain` workspace integrity guard.
- A single total deadline per `execute` bounds the **entire** lifecycle: host
  creation, SDK session creation, prompt admission, idle polling and output
  collection. On expiry the host is closed and the call fails with `timeout`
  (polling alone would let a hung host or prompt escape the deadline).
- Secret scrubbing and truncated diagnostics, never logging prompts or file
  contents.

Not in Phase 2a:

- Model egress / proxy evidence and the adversarial §7 suite (Phase 2b).
- Persistent multi-review hosts and context continuity (Phase 3).
- Application-owned review tools (`review_read_file`, …) (Phase 4).
- Independent verification sessions (Phase 5), metrics/benchmarks (Phase 6),
  shadow evaluation (Phase 7) and publishing (Phase 8).

## Node requirement

`@opencode/sdk@2.2.7` depends on `@opencode/util`, which uses `await using`.
The SDK **cannot be imported on Node 20.18 or Node 22.14** (the production CLI
image). The SDK worker requires **Node ≥ 24**. This is an isolated experiment
deployment unit, not a change to the production image.

## Feature flag and fail-closed behavior

```json
{
  "agent": {
    "sdk": {
      "enabled": false,
      "shadowMode": true
    }
  }
}
```

- Absent or `enabled: false` → `OpenCodeAgentRuntime` (existing CLI adapter),
  exactly as before.
- `enabled: true` → `OpenCodeSdkAgentRuntime`.
- Enabling the SDK does not silently fall back to the CLI. If the SDK cannot be
  imported (including Node < 24), `healthCheck()` reports unhealthy and
  `execute()` fails with a normalized error (`config` for an unsupported Node,
  `spawn` for import/host/session failures). Failing closed avoids accidental
  mixed-runtime behavior.

## Dependency mechanism

`@opencode/sdk@2.2.7` is an **exact devDependency** in the root
`package.json`. It is intentionally absent from the production runtime install
path: the production image uses `npm ci --omit=dev`, so the SDK is not installed
there. It is loaded only through a dynamic import with a variable specifier
behind an injectable loader (`SdkLoader`), and no `import type` from the package
is used — local structural types live in `src/agent/sdk/types.ts`. As a result
`tsc` and the production runtime do not require the SDK package.

Verify:

```bash
npm ls @opencode/sdk --omit=dev   # must not list 2.2.7 (or exit non-zero)
npm ls @opencode/sdk              # must list 2.2.7
```

## Phase 2b egress hook

`SdkRuntimeOptions.fetchImpl` accepts a proxy-aware
`(input, init) => Promise<Response>` and is forwarded to
`OpenCode.create({ ..., fetch })`. This is the seam for a future egress
allowlist proxy: the SDK worker supplies the implementation (for example a
proxy-enforcing `fetch`); the adapter does not choose or configure a proxy. When
no implementation is supplied the property is omitted and the SDK uses its
normal fetch. No proxy dependency (e.g. `undici`) is added to the root package.

## Tests

```bash
npm run build
npx vitest run test/agent-sdk-runtime.test.ts test/agent-sdk-config.test.ts \
  test/agent-runtime.test.ts test/review-config.test.ts
```

The SDK tests inject a fake `SdkModule`; they never import the real SDK and make
no network calls.

## Limitations

- Host-per-review in Phase 2a; there is no shared long-lived host yet (Phase 3).
- No custom review tools until Phase 4.
- Completion relies on polling, not events.
- The total deadline is enforced by racing the lifecycle against a timer plus a
  clock check in the polling loop. The underlying SDK call cannot be force
  cancelled, so the adapter closes the host to stop in-flight work; a truly hung
  SDK promise may linger until the host is torn down.
- Session/instance separation is logical only; the container boundary and
  model-level adversarial tests remain mandatory (Phase 2b/§7).
- The workspace integrity guard detects modifications *after* execution; it is
  not a preventive sandbox.
