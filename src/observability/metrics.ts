import type { FindingSeverity } from "../review-engine/types.js";

/**
 * Minimal hand-rolled Prometheus-compatible metrics registry (§16.2).
 *
 * Deliberately dependency-free: counters, gauges and histograms with a
 * text-format exposition endpoint (GET /metrics). No prom-client, no pull
 * infrastructure — the render() output is plain Prometheus text format.
 */

const SEVERITIES: readonly FindingSeverity[] = ["critical", "high", "medium", "low", "informational"];

class Counter {
  readonly values = new Map<string, number>();
  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: readonly string[],
  ) {}

  inc(value = 1, labels: Record<string, string | number> = {}): void {
    const key = this.key(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + value);
  }

  private key(labels: Record<string, string | number>): string {
    const parts = this.labelNames.map((n) => `${n}="${String(labels[n] ?? "")}"`);
    return parts.length ? `{${parts.join(",")}}` : "";
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [key, value] of this.values) {
      lines.push(`${this.name}${key} ${value}`);
    }
    if (this.values.size === 0) {
      lines.push(`${this.name} 0`);
    }
    return lines.join("\n");
  }
}

class Gauge {
  private value = 0;
  private labeled = new Map<string, number>();
  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: readonly string[] = [],
  ) {}

  set(value: number, labels: Record<string, string | number> = {}): void {
    if (this.labelNames.length === 0) {
      this.value = value;
      return;
    }
    const key = this.labelNames.map((n) => `${n}="${String(labels[n] ?? "")}"`).join(",");
    this.labeled.set(`{${key}}`, value);
  }

  get(): number {
    return this.value;
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    if (this.labelNames.length === 0) {
      lines.push(`${this.name} ${this.value}`);
    } else {
      for (const [key, value] of this.labeled) {
        lines.push(`${this.name}${key} ${value}`);
      }
      if (this.labeled.size === 0) {
        lines.push(`${this.name} 0`);
      }
    }
    return lines.join("\n");
  }
}

class Histogram {
  readonly buckets: number[];
  private bucketCounts: number[];
  private count = 0;
  private sum = 0;
  constructor(
    readonly name: string,
    readonly help: string,
    buckets: number[] = [1, 5, 10, 30, 60, 120, 300, 600],
  ) {
    this.buckets = [...buckets].sort((a, b) => a - b);
    this.bucketCounts = new Array(this.buckets.length).fill(0);
  }

  observe(value: number): void {
    for (const [index, upperBound] of this.buckets.entries()) {
      if (value <= upperBound) {
        this.bucketCounts[index] = (this.bucketCounts[index] ?? 0) + 1;
      }
    }
    this.count += 1;
    this.sum += value;
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [index, upperBound] of this.buckets.entries()) {
      lines.push(`${this.name}_bucket{le="${upperBound}"} ${this.bucketCounts[index] ?? 0}`);
    }
    lines.push(`${this.name}_bucket{le="+Inf"} ${this.count}`);
    lines.push(`${this.name}_count ${this.count}`);
    lines.push(`${this.name}_sum ${this.sum}`);
    return lines.join("\n");
  }
}

export class MetricsRegistry {
  readonly reviewsStarted = new Counter("ai_pr_reviewer_reviews_started_total", "Total reviews started", []);
  readonly reviewsCompleted = new Counter(
    "ai_pr_reviewer_reviews_completed_total",
    "Total reviews completed successfully",
    ["outcome"],
  );
  readonly reviewsFailed = new Counter("ai_pr_reviewer_reviews_failed_total", "Total reviews failed", [
    "failure_class",
  ]);
  readonly reviewDuration = new Histogram(
    "ai_pr_reviewer_review_duration_seconds",
    "End-to-end review duration in seconds",
    [1, 5, 10, 30, 60, 120, 300, 600, 1200],
  );
  readonly queueWait = new Histogram(
    "ai_pr_reviewer_queue_wait_seconds",
    "Time a review job spent waiting in the queue before processing",
    [1, 5, 10, 30, 60, 120, 300, 600],
  );
  readonly queueDepth = new Gauge(
    "ai_pr_reviewer_queue_depth",
    "Current BullMQ review-jobs queue depth (waiting + active + delayed)",
    [],
  );
  readonly findingsTotal = new Counter("ai_pr_reviewer_findings_total", "Total verified findings produced", [
    "category",
  ]);
  readonly findingsBySeverity = new Counter("ai_pr_reviewer_findings_by_severity", "Findings by severity", [
    "severity",
  ]);
  readonly uncertainFindings = new Counter(
    "ai_pr_reviewer_uncertain_findings_total",
    "Total uncertain findings produced",
    [],
  );
  readonly providerLatency = new Histogram(
    "ai_pr_reviewer_provider_latency_seconds",
    "Model provider call latency in seconds",
    [1, 5, 10, 30, 60, 120, 300],
  );
  readonly providerErrors = new Counter(
    "ai_pr_reviewer_provider_errors_total",
    "Model provider / agent runtime errors",
    ["error_code"],
  );
  readonly inputTokens = new Counter("ai_pr_reviewer_input_tokens_total", "Total model input tokens consumed", []);
  readonly outputTokens = new Counter("ai_pr_reviewer_output_tokens_total", "Total model output tokens produced", []);
  readonly workspaceDiskUsage = new Gauge(
    "ai_pr_reviewer_workspace_disk_usage_bytes",
    "Workspace root disk usage in bytes",
    [],
  );
  readonly workerMemoryUsage = new Gauge(
    "ai_pr_reviewer_worker_memory_usage_bytes",
    "Worker process RSS memory in bytes",
    [],
  );
  readonly alertsActive = new Gauge("ai_pr_reviewer_alerts_active", "Active alert count by alert name (§16.4)", [
    "alert",
  ]);

  /** Render every metric in Prometheus text exposition format (§16.2). */
  render(): string {
    const parts: string[] = [];
    for (const metric of this.allMetrics()) {
      parts.push(metric.render());
    }
    return parts.join("\n") + "\n";
  }

  /** Reset all values (tests only). */
  reset(): void {
    for (const metric of this.allMetrics()) {
      const m = metric as unknown as { values?: Map<string, number>; labeled?: Map<string, number> };
      m.values?.clear();
      m.labeled?.clear();
      if (typeof (metric as unknown as { value?: number }).value === "number") {
        (metric as unknown as { value: number }).value = 0;
      }
      if ("buckets" in metric && "bucketCounts" in metric) {
        const h = metric as unknown as { bucketCounts: number[]; count: number; sum: number };
        h.bucketCounts = new Array(h.bucketCounts.length).fill(0);
        h.count = 0;
        h.sum = 0;
      }
    }
  }

  private allMetrics(): Array<Counter | Gauge | Histogram> {
    return [
      this.reviewsStarted,
      this.reviewsCompleted,
      this.reviewsFailed,
      this.reviewDuration,
      this.queueWait,
      this.queueDepth,
      this.findingsTotal,
      this.findingsBySeverity,
      this.uncertainFindings,
      this.providerLatency,
      this.providerErrors,
      this.inputTokens,
      this.outputTokens,
      this.workspaceDiskUsage,
      this.workerMemoryUsage,
      this.alertsActive,
    ];
  }
}

// ---------------------------------------------------------------------------
// Domain recording helpers
// ---------------------------------------------------------------------------

let registry: MetricsRegistry | undefined;

export function getMetricsRegistry(): MetricsRegistry {
  if (!registry) {
    registry = new MetricsRegistry();
  }
  return registry;
}

/** Replace the singleton (tests). */
export function setMetricsRegistry(r: MetricsRegistry | undefined): void {
  registry = r;
}

export type ProviderCallRecord = {
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  errorCode?: string;
};

/** Record one model/agent provider call: latency + token usage + errors. */
export function recordProviderCall(call: ProviderCallRecord): void {
  const m = getMetricsRegistry();
  m.providerLatency.observe(Math.max(0, call.durationMs / 1000));
  if (typeof call.inputTokens === "number") {
    m.inputTokens.inc(call.inputTokens);
  }
  if (typeof call.outputTokens === "number") {
    m.outputTokens.inc(call.outputTokens);
  }
  if (call.errorCode) {
    m.providerErrors.inc(1, { error_code: call.errorCode });
  }
}

export function recordReviewFindings(result: {
  findings: Array<{ severity: string; category: string }>;
  uncertainCount: number;
}): void {
  const m = getMetricsRegistry();
  for (const finding of result.findings) {
    const severity = (SEVERITIES as readonly string[]).includes(finding.severity) ? finding.severity : "unknown";
    m.findingsBySeverity.inc(1, { severity });
    m.findingsTotal.inc(1, { category: finding.category || "unknown" });
  }
  m.uncertainFindings.inc(result.uncertainCount);
}
