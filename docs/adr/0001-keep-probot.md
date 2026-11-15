# ADR 0001 — Keep Probot for the GitHub App

Status: Accepted · 2026-11-15

## Context

The service is a GitHub App. It must verify webhook signatures, receive
installation and pull-request events, authenticate as an App installation, and
call the GitHub API. Probot already provides those concerns, and the existing
deployment (`probot run ./lib/index.js`, `probot` Compose service, webhook URL
at `/`) is built around it.

The handbook's default backend stack is NestJS. Adopting Nest would mean
replacing the GitHub App framework, duplicating webhook/HTTP/container
concerns, and rewriting the composition roots without changing product
behavior.

## Decision

Keep **Probot 14** as the GitHub App framework and webhook middleware.

- `src/index.ts` exports the Probot app function and registers thin event
  adapters from `src/modules/webhooks`.
- `src/server.ts` composes Probot's Node middleware with a plain Node HTTP
  surface for health, readiness, metrics, manual review, and the admin
  API/panel.
- Dependency injection is constructor/options injection from
  `src/bootstrap/*`, not a framework container.

## Consequences

- Webhook verification, App authentication, and GitHub API integration stay on
  a maintained library instead of custom code.
- Handlers remain thin: they validate, translate, and call ingestion; they
  never run inference inline.
- There is no NestJS module/DI system. Modules expose a public `index.ts` and
  receive ports from the composition roots; ESLint enforces the boundaries.
- The admin/health HTTP surface is deliberately small and framework-free, so
  it can be tested with a plain `http.Server`.
- A future move to Nest or another framework is possible but would be a
  separate replatform decision.

## Alternatives considered

- **NestJS + a webhook library** — duplicates Probot's App lifecycle and
  webhook verification, adds a container and decorators to a two-process
  service, and has no product benefit.
- **Hand-rolled Octokit app + HTTP router** — re-implements signature
  verification, installation auth, and event dispatch that Probot already
  maintains.
- **Probot plus Nest for admin only** — two frameworks and two DI styles in one
  small service; rejected as unnecessary complexity.

## References

- [../architecture.md](../architecture.md) §1, §5
- [../module-boundaries.md](../module-boundaries.md)
- [../agent-runtime-plugins.md](../agent-runtime-plugins.md)
- `src/index.ts`, `src/server.ts`, `src/bootstrap/server.ts`
