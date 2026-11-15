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
