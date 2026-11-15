import type {
  ConfigDryRunResponse,
  ConfigReadResponse,
  ConfigReloadResponse,
  ConfigRollbackResponse,
  ConfigUpdateResponse,
  ConfigValidateResponse,
} from "../../contracts/admin.js";
import { ERROR_CODES } from "../../contracts/errors.js";
import { ConfigValidationError, type ReviewConfigStore } from "../../ports/review-config.js";
import { ConflictError } from "../../shared/errors/index.js";
import type { AuditAction, AuditMetadata, AuditRepository } from "./audit.repository.js";

/**
 * Admin configuration use cases (ARCHITECTURE.md §11.5, §15).
 *
 * Every write goes through the same `ReviewConfigStore` primitives as before,
 * so atomicity, validation-before-write and last-known-good guarantees are
 * unchanged. Audit side effects live beside the operation that causes them.
 */

export interface AdminConfigServiceDeps {
  audit: AuditRepository;
  config: ReviewConfigStore;
}

export interface AdminConfigService {
  readConfig(): ConfigReadResponse;
  validateConfig(candidate: unknown): ConfigValidateResponse;
  dryRunConfig(candidate: unknown): ConfigDryRunResponse;
  updateConfig(candidate: unknown, actor: string): Promise<ConfigUpdateResponse>;
  reloadConfig(actor: string): Promise<ConfigReloadResponse>;
  rollbackConfig(actor: string): Promise<ConfigRollbackResponse>;
}

export function createAdminConfigService(deps: AdminConfigServiceDeps): AdminConfigService {
  async function audit(actor: string, action: AuditAction, resource: string, metadata?: AuditMetadata): Promise<void> {
    await deps.audit.record({ actor, action, resource, metadata });
  }

  function readConfig(): ConfigReadResponse {
    const loaded = deps.config.load();
    return {
      fromLastKnownGood: loaded.fromLastKnownGood,
      hash: loaded.snapshot.hash,
      schemaVersion: loaded.snapshot.schemaVersion,
      configuration: deps.config.redact(loaded.config),
    };
  }

  function validateConfig(candidate: unknown): ConfigValidateResponse {
    try {
      const validated = deps.config.validate(candidate);
      return {
        valid: true,
        hash: validated.snapshot.hash,
        configuration: deps.config.redact(validated.config),
      };
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        // Zod/embedded-secret messages name property paths, never secret values.
        return { valid: false, error: error.message };
      }
      throw error;
    }
  }

  function dryRunConfig(candidate: unknown): ConfigDryRunResponse {
    try {
      const validated = deps.config.validate(candidate);
      return {
        valid: true,
        hash: validated.snapshot.hash,
        schemaVersion: validated.snapshot.schemaVersion,
        configuration: deps.config.redact(validated.config),
        applied: false,
      };
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        return { valid: false, applied: false, error: error.message };
      }
      throw error;
    }
  }

  async function updateConfig(candidate: unknown, actor: string): Promise<ConfigUpdateResponse> {
    try {
      const result = deps.config.update(candidate);
      await audit(actor, "config.update", "configuration", {
        previousHash: result.previous.snapshot.hash,
        nextHash: result.next.snapshot.hash,
        nextCapturedAt: result.next.snapshot.capturedAt,
      });
      return {
        updated: true,
        previousHash: result.previous.snapshot.hash,
        hash: result.next.snapshot.hash,
        configuration: deps.config.redact(result.next.config),
      };
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        // Atomic guarantee: the store validated BEFORE any write, so
        // review.json and the last-known-good snapshot are untouched here.
        await audit(actor, "config.update_rejected", "configuration", { reason: "validation failed" });
      }
      throw error;
    }
  }

  async function reloadConfig(actor: string): Promise<ConfigReloadResponse> {
    // §11.5: re-read from disk, validate before activation, keep the previous
    // configuration available (the store's LKG protection covers the case of
    // a file that no longer validates: it reports fromLastKnownGood=true).
    const loaded = deps.config.load({ updateLastKnownGood: true });
    await audit(actor, "config.reload", "configuration", {
      fromLastKnownGood: loaded.fromLastKnownGood,
      hash: loaded.snapshot.hash,
    });
    return {
      reloaded: true,
      fromLastKnownGood: loaded.fromLastKnownGood,
      hash: loaded.snapshot.hash,
      configuration: deps.config.redact(loaded.config),
    };
  }

  async function rollbackConfig(actor: string): Promise<ConfigRollbackResponse> {
    if (deps.config.lastKnownGoodStatus() !== "available") {
      await audit(actor, "config.rollback_failed", "configuration", { reason: "no last-known-good snapshot" });
      throw new ConflictError("no last-known-good configuration available", {
        code: ERROR_CODES.CONFIG_ROLLBACK_UNAVAILABLE,
      });
    }
    try {
      // Restores from the validated snapshot even when the active file is
      // broken (that is the whole point of rollback), so we must not use
      // update here: it refuses to write over an invalid file.
      const restored = deps.config.restoreLastKnownGood();
      await audit(actor, "config.rollback", "configuration", {
        restoredHash: restored.snapshot.hash,
      });
      return {
        rolledBack: true,
        hash: restored.snapshot.hash,
        configuration: deps.config.redact(restored.config),
      };
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        await audit(actor, "config.rollback_failed", "configuration", {
          reason: "last-known-good snapshot failed validation",
        });
        throw new ConflictError("last-known-good snapshot failed validation", {
          code: ERROR_CODES.CONFIG_ROLLBACK_INVALID,
        });
      }
      throw error;
    }
  }

  return { readConfig, validateConfig, dryRunConfig, updateConfig, reloadConfig, rollbackConfig };
}
