/**
 * Field descriptors for the server-rendered admin panel (ticket 14).
 *
 * Every editable field in the panel is declared here, with the configuration
 * path it maps to, its input type and (for enums) the allowed options. The
 * panel NEVER invents a write path: each descriptor path is applied to a
 * cloned copy of the current configuration with getPath/setPath from the
 * ticket-02 loader, and the whole candidate is re-validated by
 * updateReviewConfig before anything is persisted.
 *
 * Secrets are not editable: the AI Model section exposes provider.apiKeyEnv
 * (the NAME of the environment variable), never a key value. Values rendered
 * in forms additionally pass through redactConfiguration (see panel.ts).
 */

export type PanelFieldType = "text" | "textarea" | "number" | "boolean" | "enum" | "list";

export interface PanelField {
  /** Dot path within the review configuration object. */
  path: string;
  label: string;
  type: PanelFieldType;
  options?: readonly string[];
  help?: string;
  /** Requires the confirmation interstitial before Save applies the change. */
  sensitive?: boolean;
  /** Read-only display (value present but not editable). */
  readonly?: boolean;
}

export const PANEL_SECTIONS = ["general", "ai-model", "review-rules", "execution", "github", "storage"] as const;

export type PanelSection = (typeof PANEL_SECTIONS)[number];

export const SECTION_LABELS: Record<PanelSection, string> = {
  general: "General",
  "ai-model": "AI Model",
  "review-rules": "Review Rules",
  execution: "Execution",
  github: "GitHub",
  storage: "Storage",
};

const REVIEW_CATEGORIES = [
  "functional",
  "regression",
  "security",
  "performance",
  "concurrency",
  "dataIntegrity",
  "errorHandling",
  "apiCompatibility",
  "maintainability",
  "testing",
] as const;

export const PANEL_FIELDS: Record<PanelSection, readonly PanelField[]> = {
  general: [
    { path: "application.name", label: "Application name", type: "text" },
    {
      path: "application.environment",
      label: "Environment",
      type: "enum",
      options: ["development", "test", "staging", "production"],
    },
    { path: "application.timezone", label: "Timezone", type: "text" },
    { path: "review.enabled", label: "Reviews enabled", type: "boolean" },
    { path: "review.triggers.automatic", label: "Automatic review events", type: "boolean" },
    { path: "review.triggers.manual", label: "Manual review trigger", type: "boolean" },
    { path: "queue.concurrency", label: "Max concurrent reviews", type: "number", help: "BullMQ worker concurrency" },
    {
      path: "queue.newCommitPolicy",
      label: "New-commit policy",
      type: "enum",
      options: ["supersede", "append"],
    },
    {
      path: "agent.runtime.timeoutMs",
      label: "Review timeout (ms)",
      type: "number",
      help: "Per-review agent runtime timeout",
    },
    { path: "configuration.reloadStrategy", label: "Reload strategy", type: "enum", options: ["manual", "restart"] },
    { path: "configuration.rollbackEnabled", label: "Rollback enabled", type: "boolean" },
  ],
  "ai-model": [
    {
      path: "provider.type",
      label: "Provider type",
      type: "enum",
      options: ["openai-compatible"],
      readonly: true,
    },
    {
      path: "provider.baseURL",
      label: "Base URL",
      type: "text",
      help: "May be an ${ENV_VAR} reference; the API key value is never stored here",
    },
    {
      path: "provider.apiKeyEnv",
      label: "API key environment variable",
      type: "text",
      readonly: true,
      help: "Secrets are env-only. This names the environment variable the API key is read from; the key value itself is never displayed or editable",
    },
    { path: "provider.model", label: "Model", type: "text" },
    { path: "provider.temperature", label: "Temperature", type: "number" },
    { path: "provider.maxOutputTokens", label: "Provider max output tokens", type: "number" },
    { path: "provider.timeoutMs", label: "Provider timeout (ms)", type: "number" },
    {
      path: "provider.failurePolicy",
      label: "Failure policy",
      type: "enum",
      options: ["fail-immediately", "retry-once"],
    },
    { path: "agent.context.maxInputTokens", label: "Agent max input tokens", type: "number" },
    { path: "agent.context.maxOutputTokens", label: "Agent max output tokens", type: "number" },
  ],
  "review-rules": [
    { path: "review.strategy.mode", label: "Strategy mode", type: "enum", options: ["adaptive", "fixed"] },
    { path: "review.strategy.maxStages", label: "Max stages", type: "number" },
    { path: "review.strategy.verifyFindings", label: "Verify findings", type: "boolean" },
    {
      path: "review.severity",
      label: "Severities (comma-separated)",
      type: "list",
      help: "Allowed: critical, high, medium, low, informational",
    },
    { path: "review.confidence.minimumInline", label: "Minimum inline confidence", type: "number" },
    { path: "review.confidence.minimumVerified", label: "Minimum verified confidence", type: "number" },
    ...REVIEW_CATEGORIES.map((category) => ({
      path: `review.categories.${category}`,
      label: `Category: ${category}`,
      type: "boolean" as const,
    })),
    { path: "review.findings.deduplication", label: "Findings deduplication", type: "boolean" },
    { path: "review.findings.trackAcrossCommits", label: "Track findings across commits", type: "boolean" },
    { path: "review.findings.lifecycleManagement", label: "Findings lifecycle management", type: "boolean" },
    {
      path: "review.findings.publishUncertainInSummary",
      label: "Publish uncertain findings in summary",
      type: "boolean",
    },
    { path: "review.reporting.summary", label: "Summary section", type: "boolean" },
    { path: "review.reporting.inlineComments", label: "Inline comments", type: "boolean" },
    { path: "review.reporting.publishCleanReview", label: "Publish clean reviews", type: "boolean" },
    { path: "review.reporting.publishApproval", label: "Publish approvals", type: "boolean" },
    { path: "review.conventions.detectAutomatically", label: "Detect conventions automatically", type: "boolean" },
    { path: "review.conventions.customInstructions", label: "Custom instructions", type: "textarea" },
    // Review types (§4.1): standard (default), skill (playbook) and handbook
    // (retrieved standards). publish is the decision-7 GitHub gate.
    { path: "review.types.standard.enabled", label: "Review type: standard enabled", type: "boolean" },
    { path: "review.types.standard.publish", label: "Review type: standard publish to GitHub", type: "boolean" },
    { path: "review.types.skill.enabled", label: "Review type: skill enabled", type: "boolean" },
    { path: "review.types.skill.publish", label: "Review type: skill publish to GitHub", type: "boolean" },
    { path: "review.types.handbook.enabled", label: "Review type: handbook enabled", type: "boolean" },
    { path: "review.types.handbook.publish", label: "Review type: handbook publish to GitHub", type: "boolean" },
    { path: "review.types.handbook.repository", label: "Handbook repository (owner/repo)", type: "text" },
    { path: "review.types.handbook.branch", label: "Handbook branch", type: "text" },
    { path: "review.types.handbook.path", label: "Handbook subpath (dir or file)", type: "text" },
    { path: "review.types.handbook.maxChars", label: "Handbook excerpt max chars", type: "number" },
  ],
  execution: [
    {
      path: "execution.mode",
      label: "Execution mode",
      type: "enum",
      options: ["read-only", "static-analysis", "sandbox"],
      sensitive: true,
      help: "Changes what repository commands the agent may run",
    },
    {
      path: "execution.commands.allowlist",
      label: "Command allowlist (comma-separated)",
      type: "list",
      sensitive: true,
    },
    { path: "execution.commands.allowTests", label: "Allow test commands", type: "boolean", sensitive: true },
    { path: "execution.commands.allowBuilds", label: "Allow build commands", type: "boolean", sensitive: true },
    {
      path: "execution.commands.allowPackageScripts",
      label: "Allow package scripts",
      type: "boolean",
      sensitive: true,
    },
    { path: "execution.sandbox.enabled", label: "Docker sandbox enabled", type: "boolean", sensitive: true },
    {
      path: "execution.sandbox.networkMode",
      label: "Sandbox network mode",
      type: "enum",
      options: ["none", "allowlist", "open"],
      sensitive: true,
    },
    {
      path: "execution.sandbox.allowedDomains",
      label: "Allowed domains (comma-separated)",
      type: "list",
      sensitive: true,
    },
    { path: "execution.sandbox.runAsNonRoot", label: "Run sandbox as non-root", type: "boolean" },
    { path: "execution.resources.cpuLimit", label: "CPU limit", type: "text" },
    { path: "execution.resources.memoryLimit", label: "Memory limit", type: "text" },
    { path: "execution.resources.diskLimit", label: "Disk limit", type: "text" },
    { path: "execution.resources.executionTimeoutMs", label: "Execution timeout (ms)", type: "number" },
  ],
  github: [
    { path: "github.organization", label: "Organization", type: "text" },
    {
      path: "github.installationScope",
      label: "Installation scope",
      type: "enum",
      options: ["organization", "repository"],
    },
    {
      path: "github.events",
      label: "Events (comma-separated)",
      type: "list",
      help: "Allowed: opened, synchronize, ready_for_review, issue_comment",
    },
    { path: "github.manualCommand", label: "Manual command", type: "text" },
    {
      path: "github.defaultReviewType",
      label: "Default review type",
      type: "enum",
      options: ["standard", "skill", "handbook"],
    },
    { path: "github.draftPullRequests.enabled", label: "Review draft pull requests", type: "boolean" },
    { path: "github.permissions.readContents", label: "Permission: read contents", type: "boolean" },
    { path: "github.permissions.readPullRequests", label: "Permission: read pull requests", type: "boolean" },
    { path: "github.permissions.readChecks", label: "Permission: read checks", type: "boolean" },
    { path: "github.permissions.writePullRequests", label: "Permission: write pull requests", type: "boolean" },
    { path: "github.permissions.writeReviewComments", label: "Permission: write review comments", type: "boolean" },
  ],
  storage: [
    {
      path: "repository.clone.strategy",
      label: "Clone strategy",
      type: "enum",
      options: ["shallow", "full"],
    },
    { path: "repository.clone.depth", label: "Clone depth", type: "number" },
    { path: "repository.workspace.retentionHours", label: "Workspace retention (hours)", type: "number" },
    { path: "repository.workspace.cleanupAfterReview", label: "Cleanup workspace after review", type: "boolean" },
    { path: "repository.files.maxFileBytes", label: "Max file bytes", type: "number" },
    { path: "repository.files.maxFilesPerReview", label: "Max files per review", type: "number" },
    { path: "persistence.reviewHistoryRetentionDays", label: "Review history retention (days)", type: "number" },
    { path: "persistence.findingRetentionDays", label: "Finding retention (days)", type: "number" },
    { path: "persistence.auditRetentionDays", label: "Audit retention (days)", type: "number" },
    { path: "persistence.artifactRetentionDays", label: "Artifact retention (days)", type: "number" },
  ],
};

/** Fields whose change requires the confirmation interstitial (execution policy). */
export function sensitiveFieldsFor(section: PanelSection): readonly PanelField[] {
  return PANEL_FIELDS[section].filter((field) => field.sensitive);
}
