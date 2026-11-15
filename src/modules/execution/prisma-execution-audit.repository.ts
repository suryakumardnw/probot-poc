/**
 * Prisma adapter for command-execution audit records.
 *
 * The execution service builds a plain `ExecutionAuditEntry`; this repository
 * is the only place that knows the `command_execution_audits` column types.
 * stdout/stderr CONTENT is never passed here — the service records byte counts
 * only.
 */
import type { PrismaClient } from "@prisma/client";
import type { ExecutionAuditRepository } from "./service.js";

export function createPrismaExecutionAuditRepository(prisma: PrismaClient): ExecutionAuditRepository {
  return {
    async record(entry) {
      await prisma.commandExecutionAudit.create({
        data: {
          reviewId: entry.reviewId,
          actor: entry.actor,
          command: entry.command,
          args: entry.args,
          decision: entry.decision,
          reason: entry.reason,
          mode: entry.mode,
          sandboxed: entry.sandboxed,
          networkMode: entry.networkMode,
          exitCode: entry.exitCode,
          timedOut: entry.timedOut,
          diskQuotaExceeded: entry.diskQuotaExceeded,
          durationMs: entry.durationMs,
          stdoutBytes: entry.stdoutBytes,
          stderrBytes: entry.stderrBytes,
          ...(entry.detail !== undefined ? { metadata: { detail: entry.detail } } : {}),
        },
      });
    },
  };
}
