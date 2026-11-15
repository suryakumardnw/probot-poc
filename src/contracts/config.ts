import { z } from "zod";

/**
 * Configuration contracts: environment variables and the central review
 * configuration (review.json, ARCHITECTURE.md §11).
 *
 * Zod is the source of truth for validation; the JSON Schema at
 * config/schemas/review-config-v1.schema.json mirrors it for editor support.
 *
 * This module is a contract only: it describes shapes and defaults. Loading,
 * environment-reference resolution, secret scanning and last-known-good
 * handling stay in `src/config/` until the platform move in Phase 3.
 *
 * Security invariants enforced here:
 * - `schemaVersion` must be an explicitly supported version.
 * - Secrets are NEVER stored in review.json: the provider section references
 *   an environment variable *name* (`apiKeyEnv`), never a key value. A deep
 *   scan (see review-loader.ts) rejects any embedded secret-looking keys.
 * - Environment values are validated for shape; failure messages name the
 *   variable but never echo its value.
 */

// ---------------------------------------------------------------------------
// Environment configuration
// ---------------------------------------------------------------------------

const urlSchema = z
  .string()
  .min(1)
  .url()
  .refine((value) => value.startsWith("postgres://") || value.startsWith("postgresql://"), {
    message: "must be a postgres:// or postgresql:// URL",
  });

const redisUrlSchema = z
  .string()
  .min(1)
  .url()
  .refine((value) => value.startsWith("redis://") || value.startsWith("rediss://"), {
    message: "must be a redis:// or rediss:// URL",
  });

const logLevelSchema = z.enum(["fatal", "error", "warn", "info", "debug", "trace"]);

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: logLevelSchema.default("info"),

  // Dependency endpoints. Optional with local defaults so the app can boot
  // and report degraded readiness when Postgres/Redis are not running.
  DATABASE_URL: urlSchema.optional().default("postgres://postgres:postgres@localhost:5432/reviewer"),
  REDIS_URL: redisUrlSchema.optional().default("redis://localhost:6379"),

  // HTTP surface for Probot + health endpoints.
  PORT: z.coerce.number().int().min(1).max(65535).optional().default(3000),
  HOST: z.string().min(1).optional().default("0.0.0.0"),

  // Admin API (ticket 10, §14.2). The admin API is optional: when the OAuth
  // app + session secret are absent it reports 503 "admin disabled" and the
  // rest of the application boots normally (same degraded philosophy).
  ADMIN_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  ADMIN_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  ADMIN_OAUTH_CALLBACK_URL: z.string().url().optional(),
  // HMAC key for session cookie signing (secret — never logged).
  SESSION_SECRET: z.string().min(16).optional(),
  // GitHub organization whose members may authenticate (membership gate).
  ADMIN_GITHUB_ORG: z.string().min(1).optional(),
  // Admin allowlist: comma-separated GitHub logins. When non-empty it IS the
  // admin policy; when empty, org-role policy (ADMIN_ORG_ADMIN_ROLES) applies.
  ADMIN_GITHUB_LOGINS: z.string().optional().default(""),
  // Organization roles that grant admin when no allowlist is configured.
  ADMIN_ORG_ADMIN_ROLES: z.string().optional().default("admin"),
  SESSION_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).optional().default(28_800),
  ADMIN_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).optional().default(60),
});

export type Env = z.infer<typeof envSchema>;

// ---------------------------------------------------------------------------
// Review configuration (review.json)
// ---------------------------------------------------------------------------

export const SUPPORTED_SCHEMA_VERSIONS = [1] as const;
export const CURRENT_SCHEMA_VERSION = 1;

const nonNegativeInt = z.number().int().min(0);

const percentSchema = z.number().min(0).max(1);

/** Review types (§4.1): standard, skill, handbook (default). */
const reviewTypeOptions = z.enum(["standard", "skill", "handbook"]);

const envVarName = z
  .string()
  .regex(/^[A-Z_][A-Z0-9_]*$/, "must be an environment variable NAME (e.g. CLOUDFLARE_API_KEY), not a secret value");

const envTemplateString = z
  .string()
  .min(1)
  .refine((value) => !value.includes("\n"), {
    message: "must not contain newlines",
  });

const applicationSchema = z.object({
  name: z.string().min(1).max(64).default("ai-pr-reviewer"),
  environment: z.enum(["development", "test", "staging", "production"]).default("development"),
  timezone: z.string().min(1).max(64).default("UTC"),
});

const githubSchema = z.object({
  organization: z.string().min(1).max(128),
  installationScope: z.enum(["organization", "repository"]).default("organization"),
  events: z
    .array(z.enum(["opened", "synchronize", "ready_for_review", "issue_comment"]))
    .min(1)
    .default(["opened", "synchronize", "ready_for_review"]),
  manualCommand: z.string().min(2).max(32).default("/review"),
  /** Which review type automatic and bare `/review` reviews use. */
  defaultReviewType: reviewTypeOptions.default("handbook"),
  draftPullRequests: z
    .object({
      enabled: z.boolean().default(false),
    })
    .default({ enabled: false }),
  permissions: z
    .object({
      readContents: z.boolean().default(true),
      readPullRequests: z.boolean().default(true),
      readChecks: z.boolean().default(true),
      writePullRequests: z.boolean().default(true),
      writeReviewComments: z.boolean().default(true),
    })
    .prefault({}),
});

const categoriesSchema = z
  .object({
    functional: z.boolean().default(true),
    regression: z.boolean().default(true),
    security: z.boolean().default(true),
    performance: z.boolean().default(true),
    concurrency: z.boolean().default(true),
    dataIntegrity: z.boolean().default(true),
    errorHandling: z.boolean().default(true),
    apiCompatibility: z.boolean().default(true),
    maintainability: z.boolean().default(true),
    testing: z.boolean().default(true),
  })
  .prefault({});

/**
 * Review types (ARCHITECTURE.md §4.1): on-demand review methodologies that
 * can be compared against the same PR/head SHA.
 * - `standard` — the adaptive engine with no extra instructions.
 * - `skill` — same engine, plus the code-review playbook fetched into the
 *   boot-time knowledge cache and injected into the review instructions.
 * - `handbook` — same engine, plus relevant standards/conventions injected
 *   from the boot-time knowledge cache (see the `knowledge` section below);
 *   per review the content is pinned via the Review.knowledgeSnapshot.
 *
 * `publish` is the decision-7 gate: only types whose flag is true post to
 * GitHub; the others run, persist findings and still reach a terminal state
 * (publishSkipped records that publication was intentionally skipped).
 */
const reviewTypesSchema = z
  .object({
    standard: z
      .object({
        enabled: z.boolean().default(true),
        publish: z.boolean().default(true),
      })
      .prefault({}),
    skill: z
      .object({
        enabled: z.boolean().default(true),
        publish: z.boolean().default(false),
      })
      .prefault({}),
    handbook: z
      .object({
        enabled: z.boolean().default(true),
        publish: z.boolean().default(false),
        /** Handbook repository as "owner/repo". Empty = not configured. */
        repository: z.string().max(200).default(""),
        /** Branch/ref to read the handbook from. */
        branch: z.string().min(1).max(200).default("main"),
        /** Optional subdirectory or single file inside the handbook repo (legacy). */
        path: z.string().max(500).default(""),
        /** Character budget for the injected handbook excerpt (legacy; knowledge.handbook.maxChars is canonical). */
        maxChars: z.number().int().min(500).max(100_000).default(20_000),
      })
      .prefault({}),
  })
  .prefault({});

const reviewSchema = z.object({
  enabled: z.boolean().default(true),
  triggers: z
    .object({
      automatic: z.boolean().default(true),
      manual: z.boolean().default(true),
    })
    .prefault({}),
  strategy: z
    .object({
      mode: z.enum(["adaptive", "fixed"]).default("adaptive"),
      maxStages: z.number().int().min(1).max(8).default(4),
      verifyFindings: z.boolean().default(true),
    })
    .prefault({}),
  categories: categoriesSchema,
  types: reviewTypesSchema,
  severity: z
    .array(z.enum(["critical", "high", "medium", "low", "informational"]))
    .min(1)
    .default(["critical", "high", "medium", "low", "informational"]),
  confidence: z
    .object({
      minimumInline: percentSchema.default(0.85),
      minimumVerified: percentSchema.default(0.8),
    })
    .prefault({}),
  findings: z
    .object({
      deduplication: z.boolean().default(true),
      trackAcrossCommits: z.boolean().default(true),
      lifecycleManagement: z.boolean().default(true),
      publishUncertainInSummary: z.boolean().default(true),
    })
    .prefault({}),
  reporting: z
    .object({
      summary: z.boolean().default(true),
      inlineComments: z.boolean().default(true),
      publishCleanReview: z.boolean().default(true),
      publishApproval: z.boolean().default(false),
    })
    .prefault({}),
  conventions: z
    .object({
      detectAutomatically: z.boolean().default(true),
      customInstructions: z.string().max(10_000).default(""),
    })
    .prefault({}),
  // §5.4 adaptive complexity scoring: per-factor weights and tier thresholds.
  // The weighted score (0..10) drives investigation depth, model-call limits,
  // retrieval budget, token allocation, timeout and verification effort.
  complexity: z
    .object({
      weights: z
        .object({
          diffSize: z.number().min(0).max(10).default(1),
          changedFiles: z.number().min(0).max(10).default(1),
          structural: z.number().min(0).max(10).default(1.5),
          dependencyImpact: z.number().min(0).max(10).default(1),
          riskyCode: z.number().min(0).max(10).default(2),
          concurrency: z.number().min(0).max(10).default(1.5),
          dataIntegrity: z.number().min(0).max(10).default(2),
        })
        .prefault({}),
      thresholds: z
        .object({
          // Score below `low` → "low" tier; below `medium` → "medium";
          // otherwise "high".
          low: z.number().min(0).max(10).default(1.5),
          medium: z.number().min(0).max(10).default(3.5),
        })
        .prefault({}),
    })
    .prefault({}),
});

const agentSchema = z.object({
  runtime: z
    .object({
      type: z.enum(["opencode-cli", "opencode-sdk", "opencode-server", "custom"]).default("opencode-cli"),
      sessionStrategy: z.enum(["per-review", "per-stage", "shared"]).default("per-review"),
      timeoutMs: z.number().int().min(1_000).max(3_600_000).default(900_000),
    })
    .prefault({}),
  context: z
    .object({
      adaptive: z.boolean().default(true),
      maxFiles: z.number().int().min(1).max(10_000).default(100),
      maxRetrievalCalls: z.number().int().min(1).max(1_000).default(40),
      maxInputTokens: z.number().int().min(1_000).max(2_000_000).default(60_000),
      maxOutputTokens: z.number().int().min(256).max(200_000).default(8192),
    })
    .prefault({}),
  tools: z
    .object({
      enabled: z
        .array(z.string().min(1).max(64))
        .max(64)
        .default(["read_file", "search_code", "list_files", "inspect_symbols", "get_diff"]),
      permissionPolicy: z.enum(["allowlist", "none"]).default("allowlist"),
    })
    .prefault({}),
});

const providerSchema = z.object({
  type: z.enum(["openai-compatible"]).default("openai-compatible"),
  // May contain environment-variable references such as ${MODEL_BASE_URL}.
  baseURL: envTemplateString,
  // Name of the environment variable holding the API key — never the key itself.
  apiKeyEnv: envVarName,
  model: z.string().min(1).max(128),
  temperature: z.number().min(0).max(2).default(0.1),
  maxOutputTokens: z.number().int().min(256).max(200_000).default(8192),
  timeoutMs: z.number().int().min(1_000).max(600_000).default(120_000),
  failurePolicy: z.enum(["fail-immediately", "retry-once"]).default("fail-immediately"),
});

const executionSchema = z.object({
  mode: z.enum(["read-only", "static-analysis", "sandbox"]).default("static-analysis"),
  commands: z
    .object({
      allowlist: z.array(z.string().min(1).max(64)).max(64).default(["git", "grep", "find"]),
      allowTests: z.boolean().default(false),
      allowBuilds: z.boolean().default(false),
      allowPackageScripts: z.boolean().default(false),
    })
    .prefault({}),
  sandbox: z
    .object({
      enabled: z.boolean().default(false),
      networkMode: z.enum(["none", "allowlist", "open"]).default("allowlist"),
      allowedDomains: z.array(z.string().min(1).max(253)).max(128).default([]),
      runAsNonRoot: z.boolean().default(true),
    })
    .prefault({}),
  resources: z
    .object({
      cpuLimit: z
        .string()
        .regex(/^\d+(\.\d+)?$/, 'must be a CPU count such as "2"')
        .default("2"),
      memoryLimit: z
        .string()
        .regex(/^\d+(Gi|Mi|G|M)$/, 'must be a quantity such as "2Gi"')
        .default("2Gi"),
      diskLimit: z
        .string()
        .regex(/^\d+(Gi|Mi|G|M)$/, 'must be a quantity such as "5Gi"')
        .default("5Gi"),
      executionTimeoutMs: z.number().int().min(1_000).max(3_600_000).default(900_000),
    })
    .prefault({}),
});

const repositorySchema = z.object({
  clone: z
    .object({
      strategy: z.enum(["shallow", "full"]).default("shallow"),
      depth: z.number().int().min(1).max(50).default(1),
    })
    .prefault({}),
  workspace: z
    .object({
      retentionHours: nonNegativeInt.max(8_760).default(0),
      cleanupAfterReview: z.boolean().default(true),
    })
    .prefault({}),
  files: z
    .object({
      // Configurable per-file size limit for file content retrieval (§5.2).
      maxFileBytes: nonNegativeInt.max(50_000_000).default(1_000_000),
      maxFilesPerReview: nonNegativeInt.max(10_000).default(2_000),
    })
    .prefault({}),
});

const retryPolicySchema = z.object({
  enabled: z.boolean(),
  maxAttempts: z.number().int().min(1).max(10).default(3),
  backoff: z.enum(["fixed", "exponential"]).default("exponential"),
});

const queueSchema = z.object({
  concurrency: z.number().int().min(1).max(8).default(1),
  newCommitPolicy: z.enum(["supersede", "append"]).default("supersede"),
  retry: z
    .object({
      infrastructure: retryPolicySchema.default({ enabled: true, maxAttempts: 3, backoff: "exponential" }),
      providerUnavailable: z
        .object({
          enabled: z.boolean().default(false),
        })
        .default({ enabled: false }),
    })
    .prefault({}),
});

const persistenceSchema = z.object({
  reviewHistoryRetentionDays: nonNegativeInt.max(3650).default(365),
  findingRetentionDays: nonNegativeInt.max(3650).default(365),
  auditRetentionDays: nonNegativeInt.max(3650).default(365),
  artifactRetentionDays: nonNegativeInt.max(3650).default(30),
});

/**
 * Knowledge sources (boot-time initialization): the code-review skill
 * playbook and the engineering handbook are fetched ONCE per worker boot
 * into a persistent cache (never per review). Per-review reproducibility is
 * achieved by copying the resolved files into each review's workspace and
 * persisting the snapshot identity on the Review row (§4).
 *
 * `ref` should be a pinned commit SHA. Prod MUST pin via env overrides
 * (KNOWLEDGE_SKILL_REF / KNOWLEDGE_HANDBOOK_REF); a branch name is resolved
 * to its current commit SHA at boot so the cache/snapshot identity is still
 * SHA-keyed.
 */
const knowledgeSchema = z
  .object({
    /** Persistent cache directory. Empty = resolved at boot (env/default). */
    cacheDir: z.string().max(500).default(""),
    /** Per-source fetch deadline (covers all retry attempts). */
    fetchTimeoutMs: nonNegativeInt.max(120_000).default(30_000),
    skill: z
      .object({
        /** Source repository as "owner/repo". */
        repo: z
          .string()
          .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'must be "owner/repo"')
          .default("vercel-labs/open-agents"),
        /** Pinned commit SHA (or tag resolved to a SHA at boot). */
        ref: z.string().min(1).max(200).default("cf865e94de7729751c747171785b6ce57e7b178c"),
        /** Directory inside the repo holding the skill markdown. */
        skillDir: z.string().max(500).default(".agents/skills/code-review"),
        /** Total byte budget for the fetched skill content. */
        maxBytes: nonNegativeInt.max(10_000_000).default(200_000),
        /**
         * Token budget for the injected skill playbook (§4.1, ≈4 chars/token).
         * Separate from, and usually much smaller than, the handbook budget.
         */
        maxTokens: z.number().int().min(250).max(20_000).default(1_500),
      })
      .prefault({}),
    handbook: z
      .object({
        /** Source repository as "owner/repo". Empty disables handbook reviews. */
        repo: z.string().max(200).default("nativewit/engineering-handbook"),
        /** Ref to read from; branch names are resolved to a SHA at boot. */
        ref: z.string().min(1).max(200).default("main"),
        /**
         * Per-technology refs: when a PR's changed files are detected as one of
         * the listed technologies (e.g. `.ts` → typescript/nodejs), that ref's
         * handbook content is fetched at boot and injected instead of `ref`.
         * Useful for language guidelines that live on a separate branch.
         */
        technologyRefs: z
          .array(
            z.object({
              /** Detected technology keywords (case-insensitive). */
              technologies: z.array(z.string().min(1).max(50)).min(1),
              /** Ref to read for those technologies; branches resolve to a SHA at boot. */
              ref: z.string().min(1).max(200),
            }),
          )
          .max(20)
          .default([]),
        /** Subdirectory (repo root recursively when empty). */
        path: z.string().max(500).default(""),
        /** Total byte budget for the fetched handbook content. */
        maxBytes: nonNegativeInt.max(50_000_000).default(2_000_000),
        /**
         * Token budget for the injected handbook guidelines (§4.1, retrieval
         * layer; ≈4 chars/token). The per-stage instruction overhead is fixed
         * and separate. `maxChars` below remains a byte-level backstop.
         */
        maxTokens: z.number().int().min(500).max(20_000).default(3_000),
        /** Character budget backstop for the injected handbook excerpt. */
        maxChars: z.number().int().min(500).max(100_000).default(20_000),
      })
      .prefault({}),
  })
  .prefault({});

const repositoryOverridesSchema = z.object({
  enabled: z.boolean().default(true),
  allowedSections: z
    .array(z.string().min(1).max(128))
    .default(["review.categories", "review.severity", "review.reporting", "review.strategy"]),
});

const configurationSchema = z.object({
  reloadStrategy: z.enum(["manual", "restart"]).default("manual"),
  repositoryOverrides: repositoryOverridesSchema.prefault({}),
  validation: z
    .object({
      strict: z.boolean().default(true),
      dryRun: z.boolean().default(true),
    })
    .prefault({}),
  rollbackEnabled: z.boolean().default(true),
});

const observabilitySchema = z
  .object({
    logs: z
      .object({
        level: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
        format: z.enum(["json", "pretty"]).default("json"),
      })
      .prefault({}),
    metrics: z.object({ enabled: z.boolean().default(true) }).prefault({}),
    tracing: z.object({ enabled: z.boolean().default(true) }).prefault({}),
    // Agent-level tracing is delegated to an OpenCode plugin package. This
    // application only enables the plugin and supplies correlation/credentials
    // through the isolated child environment — no custom trace schema/DB.
    agentTracing: z
      .object({
        enabled: z.boolean().default(false),
        plugin: z.string().min(1).max(200).default("@devtheops/opencode-plugin-otel@2.1.0"),
        // Free-form, scalar plugin options (endpoint, protocol, headers policy,
        // etc.). Credentials belong in the child environment, never here.
        options: z
          .record(
            z.string().min(1).max(100),
            z.union([z.string().max(2_000), z.number(), z.boolean(), z.array(z.string().min(1).max(200)).max(50)]),
          )
          .default({}),
      })
      .prefault({}),
    alerts: z
      .object({
        reviewFailure: z.boolean().default(true),
        queueBacklog: z.boolean().default(true),
        providerUnavailable: z.boolean().default(true),
        resourceLimitExceeded: z.boolean().default(true),
      })
      .prefault({}),
  })
  .strict();

const evaluationSchema = z.object({
  enabled: z.boolean().default(true),
  benchmarkSuite: z.string().min(1).max(64).default("default"),
  trackFalsePositives: z.boolean().default(true),
  trackPrecision: z.boolean().default(true),
  trackReviewLatency: z.boolean().default(true),
  minimumQualityThreshold: percentSchema.default(0.85),
});

export const reviewConfigSchema = z
  .object({
    schemaVersion: z.union([
      z.literal(1),
      z
        .number()
        .int()
        .refine((v) => (SUPPORTED_SCHEMA_VERSIONS as readonly number[]).includes(v), {
          message: `unsupported schemaVersion; supported versions: ${SUPPORTED_SCHEMA_VERSIONS.join(", ")}`,
        }),
    ]),
    application: applicationSchema.prefault({}),
    github: githubSchema,
    review: reviewSchema.prefault({}),
    agent: agentSchema.prefault({}),
    provider: providerSchema,
    execution: executionSchema.prefault({}),
    repository: repositorySchema.prefault({}),
    knowledge: knowledgeSchema,
    queue: queueSchema.prefault({}),
    persistence: persistenceSchema.prefault({}),
    configuration: configurationSchema.prefault({}),
    observability: observabilitySchema.prefault({}),
    evaluation: evaluationSchema.prefault({}),
  })
  .strict()
  .superRefine((config, ctx) => {
    // Invalid combination: inline publishing must not be more permissive than
    // verification (a finding should not be published inline unless it would
    // also count as verified).
    if (config.review.confidence.minimumInline < config.review.confidence.minimumVerified) {
      ctx.addIssue({
        code: "custom",
        path: ["review", "confidence", "minimumInline"],
        message: "review.confidence.minimumInline must be >= review.confidence.minimumVerified",
      });
    }
    // Sandbox mode requires an explicit sandbox policy.
    if (config.execution.mode === "sandbox" && !config.execution.sandbox.enabled) {
      ctx.addIssue({
        code: "custom",
        path: ["execution", "mode"],
        message: "execution.mode 'sandbox' requires execution.sandbox.enabled = true",
      });
    }
  });

export type ReviewConfig = z.infer<typeof reviewConfigSchema>;
