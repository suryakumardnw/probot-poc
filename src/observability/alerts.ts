import type pino from "pino";
import { getMetricsRegistry } from "./metrics.js";

/**
 * Configurable alert evaluation (§16.4).
 *
 * Alerts are evaluated periodically (worker loop) from live signals:
 * queue backlog, repeated review failures, provider unavailability,
 * GitHub API auth failures, DB/Redis connectivity, worker resource
 * exhaustion and disk-space pressure.
 *
 * Surfacing: every state change is logged as a structured `alert` record
 * (level warn) and mirrored into the `ai_pr_reviewer_alerts_active` gauge so
 * Prometheus can alert on it directly. External integrations (webhook/PagerDuty)
 * register via `onAlert()` — the hook receives every raise/resolve event.
 * Shipping a concrete webhook target is out of scope here (ticket 13).
 *
 * Thresholds come from the environment so deployments tune without a config
 * reload: ALERT_QUEUE_BACKLOG, ALERT_MAX_CONSECUTIVE_FAILURES,
 * ALERT_PROVIDER_ERROR_THRESHOLD, ALERT_MEMORY_LIMIT_BYTES,
 * ALERT_DISK_LIMIT_BYTES, ALERT_DISK_USAGE_FRACTION (all optional).
 */

export type AlertName =
  | "queue_backlog"
  | "repeated_review_failures"
  | "provider_unavailable"
  | "github_auth_failures"
  | "database_connectivity"
  | "redis_connectivity"
  | "worker_resource_exhaustion"
  | "disk_approaching_limit";

export type AlertSignal = {
  queueDepth: number;
  consecutiveReviewFailures: number;
  recentProviderErrors: number;
  recentGithubAuthErrors: number;
  postgresOk: boolean;
  redisOk: boolean;
  memoryUsageBytes: number;
  workspaceDiskUsageBytes: number;
};

export type AlertThresholds = {
  queueBacklog: number;
  consecutiveReviewFailures: number;
  providerErrorThreshold: number;
  memoryLimitBytes: number;
  diskLimitBytes: number;
  diskUsageFraction: number;
};

export type AlertEvent = {
  alert: AlertName;
  action: "raised" | "resolved";
  message: string;
  value: number;
  threshold: number;
  at: string;
};

export const DEFAULT_ALERT_THRESHOLDS: AlertThresholds = {
  queueBacklog: numEnv("ALERT_QUEUE_BACKLOG", 10),
  consecutiveReviewFailures: numEnv("ALERT_MAX_CONSECUTIVE_FAILURES", 5),
  providerErrorThreshold: numEnv("ALERT_PROVIDER_ERROR_THRESHOLD", 5),
  // 75% of the worker's 1536M container limit (deploy/docker-compose.yml).
  // Keep this below the cgroup limit or the OOM killer fires before the alert.
  memoryLimitBytes: numEnv("ALERT_MEMORY_LIMIT_BYTES", 1.125 * 1024 * 1024 * 1024),
  diskLimitBytes: numEnv("ALERT_DISK_LIMIT_BYTES", 5 * 1024 * 1024 * 1024),
  diskUsageFraction: numEnv("ALERT_DISK_USAGE_FRACTION", 0.8),
};

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function loadAlertThresholds(): AlertThresholds {
  return {
    queueBacklog: numEnv("ALERT_QUEUE_BACKLOG", DEFAULT_ALERT_THRESHOLDS.queueBacklog),
    consecutiveReviewFailures: numEnv(
      "ALERT_MAX_CONSECUTIVE_FAILURES",
      DEFAULT_ALERT_THRESHOLDS.consecutiveReviewFailures,
    ),
    providerErrorThreshold: numEnv("ALERT_PROVIDER_ERROR_THRESHOLD", DEFAULT_ALERT_THRESHOLDS.providerErrorThreshold),
    memoryLimitBytes: numEnv("ALERT_MEMORY_LIMIT_BYTES", DEFAULT_ALERT_THRESHOLDS.memoryLimitBytes),
    diskLimitBytes: numEnv("ALERT_DISK_LIMIT_BYTES", DEFAULT_ALERT_THRESHOLDS.diskLimitBytes),
    diskUsageFraction: numEnv("ALERT_DISK_USAGE_FRACTION", DEFAULT_ALERT_THRESHOLDS.diskUsageFraction),
  };
}

export class AlertManager {
  private readonly active = new Map<AlertName, AlertEvent>();
  private hooks: Array<(event: AlertEvent) => void> = [];

  constructor(
    private readonly logger: pino.Logger,
    private readonly thresholds: AlertThresholds = loadAlertThresholds(),
  ) {}

  /** Register an external alert sink (webhook, PagerDuty bridge, ...). */
  onAlert(hook: (event: AlertEvent) => void): void {
    this.hooks.push(hook);
  }

  currentlyActive(): AlertEvent[] {
    return [...this.active.values()];
  }

  /**
   * Evaluate the current signals, raise/resolve alerts and emit structured
   * log records + metrics. Never throws.
   */
  evaluate(signals: AlertSignal): AlertEvent[] {
    const gauge = getMetricsRegistry().alertsActive;
    const raised: AlertEvent[] = [];

    const check = (name: AlertName, breach: boolean, value: number, threshold: number, message: string): void => {
      const wasActive = this.active.has(name);
      if (breach && !wasActive) {
        const event: AlertEvent = {
          alert: name,
          action: "raised",
          message,
          value,
          threshold,
          at: new Date().toISOString(),
        };
        this.active.set(name, event);
        raised.push(event);
        this.logger.warn({ alert: event }, "Alert raised");
      } else if (!breach && wasActive) {
        const previous = this.active.get(name)!;
        const event: AlertEvent = { ...previous, action: "resolved", at: new Date().toISOString() };
        this.active.delete(name);
        raised.push(event);
        this.logger.info({ alert: event }, "Alert resolved");
      }
      gauge.set(this.active.has(name) ? 1 : 0, { alert: name });
    };

    check(
      "queue_backlog",
      signals.queueDepth > this.thresholds.queueBacklog,
      signals.queueDepth,
      this.thresholds.queueBacklog,
      `Queue backlog ${signals.queueDepth} exceeds ${this.thresholds.queueBacklog}`,
    );
    check(
      "repeated_review_failures",
      signals.consecutiveReviewFailures >= this.thresholds.consecutiveReviewFailures,
      signals.consecutiveReviewFailures,
      this.thresholds.consecutiveReviewFailures,
      `${signals.consecutiveReviewFailures} consecutive review failures`,
    );
    check(
      "provider_unavailable",
      signals.recentProviderErrors >= this.thresholds.providerErrorThreshold,
      signals.recentProviderErrors,
      this.thresholds.providerErrorThreshold,
      `${signals.recentProviderErrors} recent provider errors`,
    );
    check(
      "github_auth_failures",
      signals.recentGithubAuthErrors >= this.thresholds.providerErrorThreshold,
      signals.recentGithubAuthErrors,
      this.thresholds.providerErrorThreshold,
      `${signals.recentGithubAuthErrors} recent GitHub auth failures`,
    );
    check("database_connectivity", !signals.postgresOk, signals.postgresOk ? 1 : 0, 1, "PostgreSQL is unreachable");
    check("redis_connectivity", !signals.redisOk, signals.redisOk ? 1 : 0, 1, "Redis is unreachable");

    const memoryBreach = signals.memoryUsageBytes > this.thresholds.memoryLimitBytes;
    check(
      "worker_resource_exhaustion",
      memoryBreach,
      signals.memoryUsageBytes,
      this.thresholds.memoryLimitBytes,
      `Worker RSS ${signals.memoryUsageBytes} exceeds ${this.thresholds.memoryLimitBytes}`,
    );
    const diskBreach =
      signals.workspaceDiskUsageBytes >= this.thresholds.diskLimitBytes * this.thresholds.diskUsageFraction;
    check(
      "disk_approaching_limit",
      diskBreach,
      signals.workspaceDiskUsageBytes,
      this.thresholds.diskLimitBytes,
      `Workspace disk usage ${signals.workspaceDiskUsageBytes} approaching limit ${this.thresholds.diskLimitBytes}`,
    );

    for (const event of raised) {
      for (const hook of this.hooks) {
        try {
          hook(event);
        } catch {
          // Alert sinks must never break the evaluation loop.
        }
      }
    }
    return raised;
  }
}
