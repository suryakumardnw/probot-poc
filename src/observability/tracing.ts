import { SpanStatusCode, trace, type Attributes, type Span } from "@opentelemetry/api";

/**
 * OpenTelemetry tracing for the review lifecycle (§16.3).
 *
 * Uses @opentelemetry/api only. When no SDK provider is registered the API
 * falls back to its built-in no-op tracer: spans are still created (cheap,
 * context propagation stays consistent) but nothing is exported.
 *
 * Plugging in a real exporter (ticket 13 / production):
 *
 *   import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
 *   import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
 *   import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
 *   const provider = new NodeTracerProvider();
 *   provider.addSpanProcessor(new SimpleSpanProcessor(new OTLPTraceExporter()));
 *   provider.register();
 *
 * Because we only touch the API surface, any registered provider is picked up
 * automatically — no code change required here.
 */

export const TRACER_NAME = "ai-pr-reviewer";

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

export function getTracer() {
  return trace.getTracer(TRACER_NAME);
}

export interface SpanOptions {
  attributes?: Attributes;
}

/** Start (and return) a span on the always-active tracer. */
export function startSpan(name: ReviewSpanName, options: SpanOptions = {}): Span {
  return getTracer().startSpan(name, { attributes: options.attributes ?? {} });
}

export function endSpan(span: Span, error?: unknown): void {
  if (error) {
    span.recordException(error instanceof Error ? error : new Error(String(error)));
    span.setStatus({ code: SpanStatusCode.ERROR });
  } else {
    span.setStatus({ code: SpanStatusCode.OK });
  }
  span.end();
}

/**
 * Run `fn` inside a synchronous span scope. Async callers should prefer
 * `withSpanAsync` so context propagation works.
 */
export function withSpanSync<T>(name: ReviewSpanName, fn: () => T, options: SpanOptions = {}): T {
  const span = startSpan(name, options);
  try {
    const result = fn();
    endSpan(span);
    return result;
  } catch (error) {
    endSpan(span, error);
    throw error;
  }
}

export async function withSpanAsync<T>(
  name: ReviewSpanName,
  fn: () => Promise<T>,
  options: SpanOptions = {},
): Promise<T> {
  const span = startSpan(name, options);
  try {
    const result = await fn();
    endSpan(span);
    return result;
  } catch (error) {
    endSpan(span, error);
    throw error;
  }
}

/** Standard review-correlation span attributes (§16.3 lifecycle). */
export function reviewSpanAttributes(corr: {
  review_id?: string;
  job_id?: string;
  repository?: string;
  pull_request_number?: number;
  head_sha?: string;
}): Attributes {
  const attrs: Attributes = {};
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
