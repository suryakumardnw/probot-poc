import { DEFAULT_CONFIG_PATH, loadReviewConfig } from "../platform/config/review-loader.js";

/**
 * Validation CLI: npm run config:validate [-- <path-to-review.json>]
 *
 * Validates a configuration strictly (including ${ENV_VAR} resolution and
 * secret hygiene) and refreshes the last-known-good snapshot on success.
 * Exit codes: 0 valid, 1 invalid.
 */

const pathArg = process.argv[2];
const path = pathArg ?? DEFAULT_CONFIG_PATH;

try {
  const { config, fromLastKnownGood, snapshot } = loadReviewConfig(path, {
    env: process.env,
    updateLastKnownGood: true,
  });
  if (fromLastKnownGood) {
    console.error(`[warn] '${path}' is invalid; the last-known-good configuration was kept.`);
  }
  console.log(`Configuration OK (${path})`);
  console.log(`  schemaVersion: ${config.schemaVersion}`);
  console.log(`  hash: ${snapshot.hash}`);
  process.exit(0);
} catch (error) {
  console.error(`Configuration INVALID (${path})`);
  console.error((error as Error).message);
  process.exit(1);
}
