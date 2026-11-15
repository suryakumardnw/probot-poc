import { existsSync, readFileSync } from "node:fs";
import type {
  LastKnownGoodStatus,
  LoadReviewConfigOptions,
  LoadedReviewConfig,
  ReviewConfigStore,
  ReviewConfigUpdateResult,
  ReviewConfigValidation,
} from "../../ports/review-config.js";
import {
  DEFAULT_CONFIG_PATH,
  LAST_KNOWN_GOOD_SUFFIX,
  checkForEmbeddedSecrets,
  createConfigurationSnapshot,
  loadReviewConfig,
  redactConfiguration,
  resolveEnvReferences,
  restoreLastKnownGood,
  updateReviewConfig,
  validateRawConfig,
} from "./review-loader.js";

/**
 * Review-config store adapter.
 *
 * Pins the store's path and environment, so callers cannot accidentally read a
 * different file or the ambient process environment. Modules depend on the
 * `ReviewConfigStore` port; only composition roots and scripts see this
 * adapter.
 */

export interface ReviewConfigStoreOptions {
  /** Configuration file path. Defaults to `config/review.json`. */
  path?: string;
  /** Environment used for `${VAR}` resolution. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export function createReviewConfigStore(options: ReviewConfigStoreOptions = {}): ReviewConfigStore {
  const path = options.path ?? DEFAULT_CONFIG_PATH;
  const env = options.env ?? process.env;

  return {
    load(loadOptions: LoadReviewConfigOptions = {}): LoadedReviewConfig {
      const loaded = loadReviewConfig(path, { env, ...loadOptions });
      return {
        config: loaded.config,
        fromLastKnownGood: loaded.fromLastKnownGood,
        snapshot: loaded.snapshot,
      };
    },

    validate(candidate: unknown): ReviewConfigValidation {
      checkForEmbeddedSecrets(candidate);
      const resolved = resolveEnvReferences(candidate, env);
      const config = validateRawConfig(resolved);
      return { config, snapshot: createConfigurationSnapshot(config) };
    },

    update(candidate: unknown): ReviewConfigUpdateResult {
      const result = updateReviewConfig(path, candidate, { env });
      return {
        previous: {
          config: result.previous.config,
          fromLastKnownGood: result.previous.fromLastKnownGood,
          snapshot: result.previous.snapshot,
        },
        next: {
          config: result.next.config,
          fromLastKnownGood: result.next.fromLastKnownGood,
          snapshot: result.next.snapshot,
        },
      };
    },

    restoreLastKnownGood(): LoadedReviewConfig {
      const restored = restoreLastKnownGood(path);
      return {
        config: restored.config,
        fromLastKnownGood: restored.fromLastKnownGood,
        snapshot: restored.snapshot,
      };
    },

    lastKnownGoodStatus(): LastKnownGoodStatus {
      const snapshotPath = `${path}${LAST_KNOWN_GOOD_SUFFIX}`;
      if (!existsSync(snapshotPath)) {
        return "missing";
      }
      try {
        JSON.parse(readFileSync(snapshotPath, "utf8"));
        return "available";
      } catch {
        return "unreadable";
      }
    },

    redact<T>(value: T): T {
      return redactConfiguration(value);
    },
  };
}
