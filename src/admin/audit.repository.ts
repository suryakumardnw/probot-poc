/**
 * Audit repository port (ARCHITECTURE.md §13.1 `audit_logs`).
 *
 * Audit writes are best-effort but awaited. The adapter logs a failed write and
 * rethrows it, so a broken audit trail fails the administrative request while
 * the failure itself is still observable.
 */

export type AuditAction =
  | "admin.login"
  | "admin.login_denied"
  | "admin.logout"
  | "config.update"
  | "config.update_rejected"
  | "config.reload"
  | "config.rollback"
  | "config.rollback_failed"
  | "review.trigger";

/**
 * Scalar metadata only: audit callers must never place secrets or nested
 * free-form payloads in an audit row.
 */
export type AuditMetadata = Record<string, string | number | boolean | null | undefined>;

export interface AuditEntry {
  actor: string;
  action: AuditAction;
  resource: string;
  metadata?: AuditMetadata;
}

export interface AuditRecord {
  id: string;
  actor: string;
  /** Stored as free-form text; history predates the current action union. */
  action: string;
  resource: string;
  metadata: unknown;
  createdAt: Date;
}

export interface AuditPage {
  total: number;
  rows: AuditRecord[];
}

export interface AuditListInput {
  limit: number;
  offset: number;
}

export interface AuditRepository {
  /** Persist one audit entry; throws (after logging) when the write fails. */
  record(entry: AuditEntry): Promise<void>;
  /** Newest-first page of audit history. */
  listPage(input: AuditListInput): Promise<AuditPage>;
}
