/**
 * Observability ports (ARCHITECTURE.md §16).
 *
 * Modules record review metrics and spans through these interfaces; the
 * concrete Prometheus registry and OpenTelemetry tracer live in
 * `src/platform/observability` and are injected by the composition root.
 * Keeping the ports dependency-free means a module never imports a platform
 * adapter or an SDK.
 */

export type ReviewSpanName =
  | "webhook.received"
  | "job.created"
  | "worker.started"
  | "clone.completed"
  | "agent.started"
  | "model.request"
  | "finding.validation"
  | "github.publishing"
  | "review.process";

/** Span attributes are scalars: identifiers, counts, names, booleans. */
export type ReviewSpanAttributes = Record<string, string | number | boolean>;

/** Opaque span handle. Closing it records status/exception like the adapter. */
export interface ReviewSpan {
  end(error?: unknown): void;
}

export interface ReviewTracing {
  startSpan(name: ReviewSpanName, attributes?: ReviewSpanAttributes): ReviewSpan;
}

export interface ProviderCallRecord {
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  errorCode?: string;
}

export interface ReviewFindingsRecord {
  findings: Array<{ severity: string; category: string }>;
  uncertainCount: number;
}

export interface ReviewMetrics {
  recordReviewStarted(): void;
  recordReviewCompleted(outcome: string): void;
  recordReviewFailed(failureClass: string): void;
  observeQueueWait(seconds: number): void;
  observeReviewDuration(seconds: number): void;
  recordProviderCall(call: ProviderCallRecord): void;
  recordReviewFindings(result: ReviewFindingsRecord): void;
}

export interface Observability {
  metrics: ReviewMetrics;
  tracing: ReviewTracing;
}

/** Standard review-correlation span attributes (§16.3 lifecycle). */
export function reviewSpanAttributes(corr: {
  review_id?: string;
  job_id?: string;
  repository?: string;
  pull_request_number?: number;
  head_sha?: string;
}): ReviewSpanAttributes {
  const attrs: ReviewSpanAttributes = {};
  if (corr.review_id) {
    attrs["review.id"] = corr.review_id;
  }
  if (corr.job_id) {
    attrs["job.id"] = corr.job_id;
  }
  if (corr.repository) {
    attrs["repository"] = corr.repository;
  }
  if (typeof corr.pull_request_number === "number") {
    attrs["pull_request.number"] = corr.pull_request_number;
  }
  if (corr.head_sha) {
    attrs["head_sha"] = corr.head_sha;
  }
  return attrs;
}
