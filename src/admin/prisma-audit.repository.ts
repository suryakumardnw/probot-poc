import type { AuditLog, PrismaClient } from "@prisma/client";
import type { AuditEntry, AuditListInput, AuditPage, AuditRecord, AuditRepository } from "./audit.repository.js";

/**
 * Prisma audit repository — the only admin file that touches Prisma.
 *
 * `metadata` crosses the boundary as `unknown`: the column is free-form JSON
 * and the panel only stringifies it for display.
 */

function mapAuditRecord(row: AuditLog): AuditRecord {
  return {
    id: row.id,
    actor: row.actor,
    action: row.action,
    resource: row.resource,
    metadata: row.metadata,
    createdAt: row.createdAt,
  };
}

export interface AuditLogger {
  warn?: (obj: object, msg: string) => void;
}

export function createPrismaAuditRepository(prisma: PrismaClient, logger?: AuditLogger): AuditRepository {
  return {
    async record(entry: AuditEntry): Promise<void> {
      try {
        await prisma.auditLog.create({
          data: {
            actor: entry.actor,
            action: entry.action,
            resource: entry.resource,
            metadata: entry.metadata ?? undefined,
          },
        });
      } catch (error) {
        // Never log metadata contents blindly — callers must already keep
        // secrets out of metadata. Report only the failure itself.
        logger?.warn?.(
          { err: error instanceof Error ? error.message : String(error), action: entry.action },
          "Audit log write failed",
        );
        throw error;
      }
    },

    async listPage(input: AuditListInput): Promise<AuditPage> {
      const [total, rows] = await Promise.all([
        prisma.auditLog.count(),
        prisma.auditLog.findMany({
          orderBy: { createdAt: "desc" },
          skip: input.offset,
          take: input.limit,
        }),
      ]);
      return { total, rows: rows.map(mapAuditRecord) };
    },
  };
}
