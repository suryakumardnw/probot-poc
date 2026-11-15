import { readProcessEnv } from "../platform/config/env.js";
import { DEFAULT_CONFIG_PATH, loadReviewConfig, redactConfiguration } from "../platform/config/review-loader.js";

/**
 * Dry-run CLI: npm run config:dry-run [-- <path-to-review.json>]
 *
 * Loads and validates the configuration, then prints the *effective*
 * configuration (defaults applied, ${ENV_VAR} references resolved,
 * mandatory security policies applied) with all secret-adjacent fields
 * redacted. Secrets are never printed. Exit codes: 0 ok, 1 invalid.
 */

const pathArg = process.argv[2];
const path = pathArg ?? DEFAULT_CONFIG_PATH;

try {
  const { config, fromLastKnownGood } = loadReviewConfig(path, {
    env: readProcessEnv(),
    updateLastKnownGood: false,
  });
  if (fromLastKnownGood) {
    console.error(`[warn] '${path}' is invalid; showing the last-known-good configuration instead.`);
  }
  console.log(JSON.stringify(redactConfiguration(config), null, 2));
  process.exit(0);
} catch (error) {
  console.error(`Configuration INVALID (${path})`);
  console.error((error as Error).message);
  process.exit(1);
}
