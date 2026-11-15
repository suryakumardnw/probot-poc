# ADR 0006 — One error family and one failure classifier

Status: Accepted · 2026-11-15

## Context

Before the refactor, 28 bespoke error classes extended `Error` independently.
The admin API hand-built `{ error: string }` bodies with ad-hoc status codes,
and retry behavior was spread across queue and outbox call sites using message
patterns. Callers could not reliably branch on a failure, and the same failure
could be retried in one path and dropped in another.

The service has two different failure surfaces: HTTP requests (never retried
server-side) and queue/outbox attempts (retried under a configured policy).

## Decision

Use the **`AppError` family** for every application failure and a **single
classifier** for retry decisions.

- `AppError` carries a stable `code`, an HTTP `statusCode`, a `retryable`
  default, an optional `retryableReason`, safe `details`, and a `cause` kept
  only for logs.
- Shared subclasses supply sensible defaults: `ValidationError` (400),
  `AuthError` (401), `ForbiddenError` (403), `NotFoundError` (404),
  `ConflictError` (409), `InvalidStateTransitionError` (409), `RateLimitError`
  (429), `ProviderError` (502/503), `InternalError` (500). Domain errors extend
  the closest subclass and pass a domain code; there is no parallel hierarchy.
- `statusCode` and `retryable` are independent axes. `ProviderError` and
  `InternalError` may override retryability only with an explicit reason.
- `classifyAppFailure(error, context)` is the family-level mapping for
  `http`/`queue`/`outbox`; unknown errors fail closed as `INTERNAL_ERROR`.
- `classifyQueueFailure` (`src/shared/retry.ts`) is the **only** place that
  decides whether a failed queue attempt may retry. It composes
  `classifyAppFailure` with `classifyFailure` + `retryPolicyFor` (failure class
  and configured attempt budget) rather than re-implementing either.
- For an `AppError`, the normalized code is authoritative. A message-pattern
  fallback supplies the failure class for metrics but never overrides the
  `retryable` flag. `AgentRuntimeError("unknown")` is therefore terminal.
- The HTTP edge maps errors to `{ code, message, statusCode, details? }`
  through `toHttpEnvelope`; 5xx envelopes collapse to a generic
  `INTERNAL_ERROR` and never expose SQL, paths, stack traces, or identifiers.

## Consequences

- Callers branch on stable codes, not message text.
- Retry policy has one decision point and one test surface
  (`test/characterization/queue-retry.test.ts`,
  `src/shared/errors/classify.test.ts`).
- Failure metrics can record a failure class even when retryability is
  governed by the `AppError` flag.
- An unclassified error is never retried blindly. This matches the
  fail-immediately policy for the agent runtime; strict parity with the old
  message-matching behavior is intentionally not preserved.
- HTTP and queue semantics stay separate even though they share the family.

## Alternatives considered

- **Keep per-module error classes** — the original problem: inconsistent codes,
  statuses, and retry policy.
- **Retry based on message patterns** — brittle, language-dependent, and can
  retry permanent failures.
- **Use HTTP status as the only retry signal** — conflates transport with
  recoverability and cannot express a retryable provider failure behind a 5xx.
- **A separate queue-only error type** — duplicates the family and forces
  adapters to convert errors at every boundary.

## References

- [../architecture.md](../architecture.md) §3, §7, §11
- [../queue-reliability.md](../queue-reliability.md)
- [../typescript-profile.md](../typescript-profile.md)
- `src/shared/errors/`, `src/shared/retry.ts`
