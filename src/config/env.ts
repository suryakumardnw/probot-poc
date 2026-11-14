import { z } from "zod";

/**
 * Environment configuration loading.
 *
 * Secrets are read from the environment and are NEVER logged: this module
 * only validates shape and reports variable *names* on failure.
 */

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

const envSchema = z.object({
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

export class EnvValidationError extends Error {
  constructor(details: string) {
    super(`Invalid environment configuration:\n${details}`);
    this.name = "EnvValidationError";
  }
}

/** Load and validate environment configuration. Throws on invalid values. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`).join("\n");
    throw new EnvValidationError(details);
  }
  return parsed.data;
}
