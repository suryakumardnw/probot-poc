import { envSchema, type Env } from "../../contracts/config.js";

/**
 * Environment configuration loading.
 *
 * The schema lives in `src/contracts/config.ts`; this adapter owns reading the
 * process environment. Secrets are read from the environment and are NEVER
 * logged: validation reports variable *names* only.
 */

export type { Env };

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

/**
 * Read one raw environment variable without validating the whole environment.
 *
 * This module is the only production reader of `process.env` (enforced by
 * `no-restricted-syntax`); adapters and composition roots use this accessor.
 */
export function readEnv(name: string): string | undefined {
  return process.env[name];
}

/**
 * Raw process environment for adapters that must pass the whole environment
 * to a child process or a plugin. The returned object is the live process
 * environment, matching the pre-refactor behavior.
 */
export function readProcessEnv(): NodeJS.ProcessEnv {
  return process.env;
}
