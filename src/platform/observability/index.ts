import type { Observability, ReviewMetrics } from "../../ports/observability.js";
import { getMetricsRegistry, recordProviderCall, recordReviewFindings } from "./metrics.js";
import { createReviewTracing } from "./tracing.js";

/**
 * Observability adapter for application modules.
 *
 * Wraps the process-wide Prometheus registry and the OpenTelemetry tracer
 * behind the dependency-free ports in `src/ports/observability.ts`. The
 * composition roots construct this once and inject it into the review
 * processor, pipeline, and reconciliation paths.
 */

function createReviewMetrics(): ReviewMetrics {
  const registry = () => getMetricsRegistry();
  return {
    recordReviewStarted(): void {
      registry().reviewsStarted.inc();
    },
    recordReviewCompleted(outcome: string): void {
      registry().reviewsCompleted.inc(1, { outcome });
    },
    recordReviewFailed(failureClass: string): void {
      registry().reviewsFailed.inc(1, { failure_class: failureClass });
    },
    observeQueueWait(seconds: number): void {
      registry().queueWait.observe(seconds);
    },
    observeReviewDuration(seconds: number): void {
      registry().reviewDuration.observe(seconds);
    },
    recordProviderCall,
    recordReviewFindings,
  };
}

export function createObservability(): Observability {
  return {
    metrics: createReviewMetrics(),
    tracing: createReviewTracing(),
  };
}
