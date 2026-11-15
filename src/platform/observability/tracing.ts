import { SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import {
  reviewSpanAttributes,
  type ReviewSpan,
  type ReviewSpanAttributes,
  type ReviewSpanName,
  type ReviewTracing,
} from "../../ports/observability.js";

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

export { reviewSpanAttributes };
export type { ReviewSpanName };

export function getTracer() {
  return trace.getTracer(TRACER_NAME);
}

export interface SpanOptions {
  attributes?: ReviewSpanAttributes;
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

class OpenTelemetryReviewSpan implements ReviewSpan {
  constructor(private readonly span: Span) {}

  end(error?: unknown): void {
    endSpan(this.span, error);
  }
}

/** Port adapter used by application modules (injected by the composition root). */
export function createReviewTracing(): ReviewTracing {
  return {
    startSpan(name: ReviewSpanName, attributes?: ReviewSpanAttributes): ReviewSpan {
      return new OpenTelemetryReviewSpan(startSpan(name, { attributes }));
    },
  };
}
