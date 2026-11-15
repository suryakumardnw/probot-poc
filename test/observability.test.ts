import http from "node:http";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AgentRuntimeError } from "../src/agent/types.js";
import { reviewConfigSchema } from "../src/config/review-schema.js";
import { ReviewRetrievalError } from "../src/modules/workspace/workspace.js";
import { AlertManager, loadAlertThresholds, type AlertSignal } from "../src/observability/alerts.js";
import {
  createReviewLogger,
  withRuntimeIdentity,
  startStage,
  type ReviewCorrelation,
} from "../src/observability/correlation.js";
import {
  metricsHandler,
  startMetricsServer,
  metricsServerPort,
  METRICS_CONTENT_TYPE,
} from "../src/observability/metrics-endpoint.js";
import {
  MetricsRegistry,
  getMetricsRegistry,
  setMetricsRegistry,
  recordProviderCall,
  recordReviewFindings,
} from "../src/observability/metrics.js";
import {
  classifyFailure,
  classifyQueueFailure,
  retryPolicyFor,
  DEFAULT_RETRY_POLICY_CONFIG,
  retryPolicyConfigFromReviewConfig,
} from "../src/observability/retry.js";
import { startSpan, endSpan, reviewSpanAttributes, withSpanSync } from "../src/observability/tracing.js";
import { ProviderError, RateLimitError, ValidationError } from "../src/shared/errors/index.js";

/**
 * Ticket 12 unit tests: metrics registry, correlation logging, tracing,
 * alert evaluation and retry classification. No external services required.
 */

function silentLogger() {
  return pino({ level: "silent" });
}

function bufferedLogger() {
  const lines: Array<Record<string, unknown>> = [];
  const logger = pino(
    { level: "info" },
    {
      write(chunk: string) {
        lines.push(JSON.parse(chunk) as Record<string, unknown>);
      },
    },
  );
  return { logger, lines };
}

// ---------------------------------------------------------------------------
// Metrics registry
// ---------------------------------------------------------------------------

describe("MetricsRegistry", () => {
  let registry: MetricsRegistry;
  beforeEach(() => {
    registry = new MetricsRegistry();
    registry.reset();
    setMetricsRegistry(registry);
  });
  afterEach(() => setMetricsRegistry(undefined));

  test("renders counters, gauges and histograms in Prometheus text format", () => {
    registry.reviewsStarted.inc(2);
    registry.reviewsCompleted.inc(1, { outcome: "success" });
    registry.queueDepth.set(7);
    registry.reviewDuration.observe(4);
    registry.reviewDuration.observe(40);

    const text = registry.render();
    expect(text).toContain("# TYPE ai_pr_reviewer_reviews_started_total counter");
    expect(text).toContain("ai_pr_reviewer_reviews_started_total 2");
    expect(text).toContain('ai_pr_reviewer_reviews_completed_total{outcome="success"} 1');
    expect(text).toContain("# TYPE ai_pr_reviewer_queue_depth gauge");
    expect(text).toContain("ai_pr_reviewer_queue_depth 7");
    expect(text).toContain('ai_pr_reviewer_review_duration_seconds_bucket{le="5"} 1');
    expect(text).toContain('ai_pr_reviewer_review_duration_seconds_bucket{le="+Inf"} 2');
    expect(text).toContain("ai_pr_reviewer_review_duration_seconds_count 2");
    expect(text).toContain("ai_pr_reviewer_review_duration_seconds_sum 44");
  });

  test("findings metrics are counted by category and severity", () => {
    registry.findingsTotal.inc(2, { category: "functional" });
    registry.findingsBySeverity.inc(1, { severity: "critical" });
    registry.findingsBySeverity.inc(1, { severity: "low" });

    const text = registry.render();
    expect(text).toContain('ai_pr_reviewer_findings_total{category="functional"} 2');
    expect(text).toContain('ai_pr_reviewer_findings_by_severity{severity="critical"} 1');
    expect(text).toContain('ai_pr_reviewer_findings_by_severity{severity="low"} 1');
  });

  test("reset() clears every value", () => {
    registry.reviewsStarted.inc(5);
    registry.queueDepth.set(3);
    registry.reviewDuration.observe(2);
    registry.reset();

    const text = registry.render();
    expect(text).toContain("ai_pr_reviewer_reviews_started_total 0");
    expect(text).toContain("ai_pr_reviewer_queue_depth 0");
    expect(text).toContain("ai_pr_reviewer_review_duration_seconds_count 0");
  });

  test("getMetricsRegistry returns a stable singleton", () => {
    expect(getMetricsRegistry()).toBe(getMetricsRegistry());
  });

  test("recordProviderCall tracks latency, tokens and errors", () => {
    recordProviderCall({ durationMs: 2500, inputTokens: 120, outputTokens: 30 });
    recordProviderCall({ durationMs: 500, errorCode: "rate_limit" });

    const text = registry.render();
    expect(text).toContain('ai_pr_reviewer_provider_latency_seconds_bucket{le="5"} 2');
    expect(text).toContain("ai_pr_reviewer_input_tokens_total 120");
    expect(text).toContain("ai_pr_reviewer_output_tokens_total 30");
    expect(text).toContain('ai_pr_reviewer_provider_errors_total{error_code="rate_limit"} 1');
  });

  test("recordReviewFindings tracks category/severity/uncertain counts", () => {
    recordReviewFindings({
      findings: [
        { severity: "high", category: "functional" },
        { severity: "critical", category: "security" },
      ],
      uncertainCount: 3,
    });

    const text = registry.render();
    expect(text).toContain('ai_pr_reviewer_findings_total{category="functional"} 1');
    expect(text).toContain('ai_pr_reviewer_findings_total{category="security"} 1');
    expect(text).toContain('ai_pr_reviewer_findings_by_severity{severity="high"} 1');
    expect(text).toContain('ai_pr_reviewer_findings_by_severity{severity="critical"} 1');
    expect(text).toContain("ai_pr_reviewer_uncertain_findings_total 3");
  });
});

// ---------------------------------------------------------------------------
// Correlation logging (§16.1)
// ---------------------------------------------------------------------------

describe("correlation logging", () => {
  const correlation: ReviewCorrelation = {
    review_id: "rev_123",
    job_id: "job_123",
    repository: "octo-org/widget",
    pull_request_number: 42,
    head_sha: "aaaa1111",
  };

  test("review logger carries every correlation field", () => {
    const { logger, lines } = bufferedLogger();
    const reviewLogger = createReviewLogger(logger, correlation);
    reviewLogger.info("processing review");

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 30,
      review_id: "rev_123",
      job_id: "job_123",
      repository: "octo-org/widget",
      pull_request_number: 42,
      head_sha: "aaaa1111",
      msg: "processing review",
    });
  });

  test("withRuntimeIdentity appends provider/model without clobbering ids", () => {
    const enriched = withRuntimeIdentity(correlation, {
      runtime: "opencode",
      provider: "openai-compat",
      model: "glm-4.7-flash",
    });
    expect(enriched).toEqual({
      ...correlation,
      runtime: "opencode",
      provider: "openai-compat",
      model: "glm-4.7-flash",
    });
    expect(correlation).not.toHaveProperty("model");
  });

  test("startStage emits stage start and completion with duration", () => {
    const { logger, lines } = bufferedLogger();
    const tracker = startStage(logger, "clone");
    const elapsed = tracker.end({ head_sha: "aaaa1111" });

    expect(elapsed).toBeGreaterThanOrEqual(0);
    expect(lines[0]).toMatchObject({
      event: "review_stage_started",
      stage: "clone",
      msg: "Review stage started: clone",
    });
    expect(lines[1]).toMatchObject({
      event: "review_stage_completed",
      stage: "clone",
      msg: "Review stage completed: clone",
    });
    expect(lines[1].duration_ms).toBeTypeOf("number");
  });

  test("startStage.fail emits a stage failure and only logs caller-sanitized error text", () => {
    const { logger, lines } = bufferedLogger();
    const tracker = startStage(logger, "analyze");
    const elapsed = tracker.fail(new Error("provider rejected: bad key"), {
      error: "provider rejected: bad key",
    });

    expect(elapsed).toBeGreaterThanOrEqual(0);
    expect(lines[1]).toMatchObject({
      event: "review_stage_failed",
      stage: "analyze",
      error_name: "Error",
      error: "provider rejected: bad key",
    });
  });
});

// ---------------------------------------------------------------------------
// Tracing (§16.3) — @opentelemetry/api noop, no SDK required
// ---------------------------------------------------------------------------

describe("tracing", () => {
  const correlation: ReviewCorrelation = {
    review_id: "rev_123",
    job_id: "job_123",
    repository: "octo-org/widget",
    pull_request_number: 42,
    head_sha: "aaaa1111",
  };

  test("startSpan returns a usable (non-recording) span without an SDK", () => {
    const span = startSpan("review.process", { attributes: reviewSpanAttributes(correlation) });
    expect(span).toBeDefined();
    expect(() => endSpan(span)).not.toThrow();
    expect(() => endSpan(span, new Error("boom"))).not.toThrow();
  });

  test("reviewSpanAttributes maps correlation fields to span attributes", () => {
    const attrs = reviewSpanAttributes(correlation);
    expect(attrs).toEqual({
      "review.id": "rev_123",
      "job.id": "job_123",
      repository: "octo-org/widget",
      "pull_request.number": 42,
      head_sha: "aaaa1111",
    });
    expect(Object.keys(reviewSpanAttributes({}))).toHaveLength(0);
  });

  test("withSpanSync propagates return value and records errors", () => {
    expect(withSpanSync("review.process", () => 7)).toBe(7);
    expect(() =>
      withSpanSync("review.process", () => {
        throw new Error("kaput");
      }),
    ).toThrow("kaput");
  });
});

// ---------------------------------------------------------------------------
// Alerts (§16.4)
// ---------------------------------------------------------------------------

function signals(overrides: Partial<AlertSignal> = {}): AlertSignal {
  return {
    queueDepth: 0,
    consecutiveReviewFailures: 0,
    recentProviderErrors: 0,
    recentGithubAuthErrors: 0,
    postgresOk: true,
    redisOk: true,
    memoryUsageBytes: 100,
    workspaceDiskUsageBytes: 100,
    ...overrides,
  };
}

describe("AlertManager", () => {
  const thresholds = {
    queueBacklog: 5,
    consecutiveReviewFailures: 2,
    providerErrorThreshold: 1,
    memoryLimitBytes: 1000,
    diskLimitBytes: 1000,
    diskUsageFraction: 0.5,
  };

  test("raises queue_backlog above the threshold and resolves when it drains", () => {
    const { logger, lines } = bufferedLogger();
    const manager = new AlertManager(logger, thresholds);
    const events: string[] = [];
    manager.onAlert((event) => events.push(`${event.alert}:${event.action}`));

    const raised = manager.evaluate(signals({ queueDepth: 10 }));
    expect(raised.map((e) => `${e.alert}:${e.action}`)).toEqual(["queue_backlog:raised"]);
    expect(lines[0].msg).toBe("Alert raised");
    expect(events).toEqual(["queue_backlog:raised"]);

    const stillActive = manager.evaluate(signals({ queueDepth: 10 }));
    expect(stillActive).toHaveLength(0);
    expect(manager.currentlyActive().map((e) => e.alert)).toEqual(["queue_backlog"]);

    const resolved = manager.evaluate(signals({ queueDepth: 1 }));
    expect(resolved.map((e) => `${e.alert}:${e.action}`)).toEqual(["queue_backlog:resolved"]);
    expect(manager.currentlyActive()).toHaveLength(0);
  });

  test("raises connectivity and resource alerts", () => {
    const manager = new AlertManager(silentLogger(), thresholds);
    const raised = manager.evaluate(
      signals({
        postgresOk: false,
        redisOk: false,
        memoryUsageBytes: 2000,
        workspaceDiskUsageBytes: 2000,
      }),
    );
    const names = raised.map((e) => e.alert).sort();
    expect(names).toContain("database_connectivity");
    expect(names).toContain("redis_connectivity");
    expect(names).toContain("worker_resource_exhaustion");
    expect(names).toContain("disk_approaching_limit");
  });

  test("alerts_active gauge reflects the live alert count", () => {
    const registry = new MetricsRegistry();
    registry.reset();
    setMetricsRegistry(registry);
    try {
      const manager = new AlertManager(silentLogger(), thresholds);
      manager.evaluate(signals({ queueDepth: 10, postgresOk: false }));
      expect(manager.currentlyActive()).toHaveLength(2);

      const text = registry.render();
      expect(text).toContain('ai_pr_reviewer_alerts_active{alert="queue_backlog"} 1');
      expect(text).toContain('ai_pr_reviewer_alerts_active{alert="database_connectivity"} 1');
    } finally {
      setMetricsRegistry(undefined);
    }
  });

  test("loadAlertThresholds honors env overrides", () => {
    process.env.ALERT_QUEUE_BACKLOG = "42";
    try {
      expect(loadAlertThresholds().queueBacklog).toBe(42);
    } finally {
      delete process.env.ALERT_QUEUE_BACKLOG;
    }
    expect(loadAlertThresholds().queueBacklog).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Retry classification (§11.3, §12.4)
// ---------------------------------------------------------------------------

describe("failure classification", () => {
  test("durable error codes map to failure classes", () => {
    expect(classifyFailure({ errorCode: "stale_commit" })).toBe("stale_commit");
    expect(classifyFailure({ errorCode: "github_403" })).toBe("github_api_transient");
    expect(classifyFailure({ errorCode: "rate_limit" })).toBe("github_api_transient");
    expect(classifyFailure({ errorCode: "redis_connect" })).toBe("redis_unavailable");
    expect(classifyFailure({ errorCode: "findings_persist" })).toBe("postgres_unavailable");
    expect(classifyFailure({ errorCode: "clone_failed" })).toBe("clone_failure");
    expect(classifyFailure({ errorCode: "provider_timeout" })).toBe("model_unavailable");
    expect(classifyFailure({ errorCode: "invalid_model_output" })).toBe("invalid_model_output");
    expect(classifyFailure({ errorCode: "resource_quota" })).toBe("resource_limit_exceeded");
  });

  test("agent runtime error codes map to failure classes", () => {
    // `AgentRuntimeError.code` values (§8.4) arrive verbatim from the runtime.
    expect(classifyFailure({ errorCode: "crash" })).toBe("agent_crash");
    expect(classifyFailure({ errorCode: "spawn" })).toBe("agent_crash");
    expect(classifyFailure({ errorCode: "timeout" })).toBe("resource_limit_exceeded");
    expect(classifyFailure({ errorCode: "provider_unavailable" })).toBe("model_unavailable");
    expect(classifyFailure({ errorCode: "invalid_output" })).toBe("invalid_model_output");
    // Exact matching must not steal composite codes like `provider_timeout`.
    expect(classifyFailure({ errorCode: "provider_timeout" })).toBe("model_unavailable");
    // Security/integrity failures stay unclassified (and therefore unretried).
    expect(classifyFailure({ errorCode: "workspace_modified" })).toBe("unknown");
  });

  test("unclassified errors fall back to message patterns", () => {
    expect(classifyFailure({ message: "connect ECONNREFUSED 127.0.0.1:6379" })).toBe("redis_unavailable");
    expect(classifyFailure({ message: "P1001 can't reach database server" })).toBe("postgres_unavailable");
    expect(classifyFailure({ message: "git clone failed: shallow fetch error" })).toBe("clone_failure");
    expect(classifyFailure({ message: "agent crashed with non-zero exit code" })).toBe("agent_crash");
    expect(classifyFailure({ message: "agent runtime exited with code 1" })).toBe("agent_crash");
    expect(classifyFailure({ message: "request failed: 502 bad gateway" })).toBe("github_api_transient");
    expect(classifyFailure({ message: "head moved since review started" })).toBe("stale_commit");
    expect(classifyFailure({ message: "????" })).toBe("unknown");
  });

  test("retry policy per failure class (§12.4)", () => {
    const policy = DEFAULT_RETRY_POLICY_CONFIG;

    expect(retryPolicyFor("github_api_transient", policy)).toMatchObject({
      retry: true,
      maxAttempts: 3,
      backoff: "exponential",
    });
    // Infrastructure outages keep durable state recoverable, never publish.
    expect(retryPolicyFor("postgres_unavailable", policy)).toMatchObject({
      retry: true,
      recoverState: true,
    });
    expect(retryPolicyFor("redis_unavailable", policy)).toMatchObject({
      retry: true,
      recoverState: true,
    });
    // Model unavailable is not retried by default (providerUnavailable disabled).
    expect(retryPolicyFor("model_unavailable", policy).retry).toBe(false);
    // Deterministic failures never retry.
    expect(retryPolicyFor("invalid_model_output", policy).retry).toBe(false);
    expect(retryPolicyFor("stale_commit", policy).retry).toBe(false);
    expect(retryPolicyFor("resource_limit_exceeded", policy).retry).toBe(false);
    expect(retryPolicyFor("unknown", policy).retry).toBe(false);
  });

  test("configuration drives the retry policy", () => {
    const config = reviewConfigSchema.parse({
      schemaVersion: 1,
      github: { organization: "fixture-org" },
      provider: {
        baseURL: "https://llm.example.test/compat",
        apiKeyEnv: "MODEL_API_KEY",
        model: "workers-ai/@cf/zai-org/glm-4.7-flash",
      },
      queue: {
        retry: {
          infrastructure: { enabled: true, maxAttempts: 5, backoff: "fixed" },
          providerUnavailable: { enabled: true },
        },
      },
    });
    const derived = retryPolicyConfigFromReviewConfig(config);
    expect(derived.infrastructure).toEqual({ enabled: true, maxAttempts: 5, backoff: "fixed" });
    expect(derived.providerUnavailable).toEqual({ enabled: true });

    expect(retryPolicyFor("model_unavailable", derived).retry).toBe(true);
    expect(retryPolicyFor("github_api_transient", derived)).toMatchObject({
      maxAttempts: 5,
      backoff: "fixed",
    });
  });

  test("the queue decision composes the shared AppError classifier with the policy", () => {
    const policy = DEFAULT_RETRY_POLICY_CONFIG;

    // Explicitly transient AppErrors retry within the configured budget.
    expect(
      classifyQueueFailure({ error: new RateLimitError("slow down"), message: "slow down", policy }),
    ).toMatchObject({ failureClass: "github_api_transient", retryable: true, maxAttempts: 3 });

    // Permanent AppErrors never retry.
    expect(
      classifyQueueFailure({ error: new ValidationError("bad input"), message: "bad input", policy }).retryable,
    ).toBe(false);

    // Operational errors use the §12.4 class policy.
    expect(
      classifyQueueFailure({
        error: new ReviewRetrievalError("git clone failed", "clone_failed"),
        errorCode: "clone_failed",
        message: "git clone failed",
        policy,
      }),
    ).toMatchObject({ failureClass: "clone_failure", retryable: true });
    expect(
      classifyQueueFailure({
        error: new AgentRuntimeError("invalid_output", "model returned invalid JSON"),
        errorCode: "invalid_output",
        message: "model returned invalid JSON",
        policy,
      }).retryable,
    ).toBe(false);

    // Both layers must agree: a retryable provider error still respects
    // providerUnavailable.enabled=false in the checked-in policy.
    expect(
      classifyQueueFailure({
        error: new ProviderError("network", "connection reset"),
        message: "connection reset",
        policy,
      }).retryable,
    ).toBe(false);

    // Unknown internal errors are not retried blindly.
    expect(
      classifyQueueFailure({ error: new Error("unclassified explosion"), message: "unclassified explosion", policy })
        .retryable,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Metrics endpoint
// ---------------------------------------------------------------------------

describe("metrics endpoint", () => {
  test("serves the registry over HTTP on GET /metrics", async () => {
    const registry = new MetricsRegistry();
    registry.reset();
    registry.reviewsStarted.inc(1);
    setMetricsRegistry(registry);
    try {
      const server = await startMetricsServer(0, "127.0.0.1");
      const port = metricsServerPort(server);
      expect(port).toBeGreaterThan(0);

      const body = await new Promise<string>((resolve, reject) => {
        http
          .get({ host: "127.0.0.1", port: port!, path: "/metrics" }, (res) => {
            expect(res.statusCode).toBe(200);
            expect(res.headers["content-type"]).toBe(METRICS_CONTENT_TYPE);
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => resolve(data));
          })
          .on("error", reject);
      });
      expect(body).toContain("ai_pr_reviewer_reviews_started_total 1");

      await new Promise<void>((resolve) => server.close(() => resolve()));
    } finally {
      setMetricsRegistry(undefined);
    }
  });

  test("rejects non-GET methods with 405", () => {
    const res = {
      statusCode: 0,
      headers: {} as Record<string, string>,
      end: () => {},
      setHeader(name: string, value: string) {
        this.headers[name] = value;
      },
    } as unknown as http.ServerResponse;
    const req = { method: "POST" } as http.IncomingMessage;
    metricsHandler(req, res);
    expect(res.statusCode).toBe(405);
    expect((res as unknown as { headers: Record<string, string> }).headers.Allow).toBe("GET, HEAD");
  });
});
