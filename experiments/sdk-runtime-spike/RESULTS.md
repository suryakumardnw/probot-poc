# Phase 0 results

**Date:** 2026-11-11
**Verdict:** **CONDITIONAL GO — requires Node ≥ 24.**
**Scope:** throwaway spike; no production runtime, root dependency, config or schema changes.

Machine-readable evidence is written to `.work/results-<timestamp>.json` (gitignored).
This file is the committed summary.

## Node matrix (offline suite)

| Node | Result | Exit |
| --- | --- | --- |
| 20.18.1 | Unsupported: SDK 2.2.7 import fails before use (`await using`) | 3 |
| 22.14.0 (current production image) | Unsupported: same | 3 |
| 24.0.0 | 20 pass / 0 fail / 1 skip | 0 |
| 26.12.0 | 20 pass / 0 fail / 1 skip | 0 |

The spike checks the Node major version before importing the SDK, so Node < 24 produces a
clean `node-runtime: unsupported` result instead of a raw `SyntaxError`.

## Real run (Node 24.0.0)

`summary: pass 27, fail 0, skip 0, criticalFailures 0, securityFailures 0`

| Area | Evidence |
| --- | --- |
| Inline config | `config.content`, 11 ordered permission rules; no config file |
| Provider | `reviewer` / `@opencode/ai/providers/openai-compatible`; GLM routed via `llm.nativewit.app`; `workers-ai/@cf/zai-org/glm-4.7-flash` |
| Structured output | JSON extracted and validated |
| Custom tool | model called `review_read_file`; audit hook fired |
| Adversarial | 6 model attempts; write/edit/shell-delete/`.env`/external access denied by the SDK; hashes and `git status` unchanged |
| Secret paths | `.env`, `prod.env.local`, `config.prod.env.bak`, `credentials/token.txt`, `.git-credentials` rejected |
| Path escapes | `..`, absolute paths, file symlink, directory symlink rejected |
| Size cap | 65,536 / 81,920 bytes, `truncated: true` |
| Concurrency | both sessions called their own tool; `a=1`, `b=1` audits; each output contained only its own marker; mode is `logical-only` |
| Lifecycle | host close in `finally`; 3/3 sessions removed; host closed; workspace deleted |

## Measurements

| Metric | Value |
| --- | --- |
| Host create | ~51.7 ms |
| Host close | ~80.5 ms |
| Session create | ~62.2 / 24.4 / 27.2 ms |
| Sampled peak RSS (authoritative) | 443,416,576 bytes (~423 MiB), 3 sessions |
| `maxRSS` (secondary) | 435,888 KB |
| Structured prompt | ~10.2 s |
| Adversarial prompt | ~31.3 s |
| Concurrent pair | ~9.6 s total |

No concurrency or memory threshold is claimed yet; the CLI baseline must be measured first.

## Caveats

- **`session.idle` events were not observed.** Completion used polling of
  `sessions.get(...).time.idle`. Persistent multi-turn sessions work, but event-driven
  completion is unproven.
- Isolation is **logical only**. The Phase 1 container boundary and adversarial deployment
  tests are still required.
- The adversarial model falsely claimed a write succeeded; tool results and filesystem
  evidence are authoritative.
- Provider availability is external; one earlier run saw a transient `invalid_token` 401.
