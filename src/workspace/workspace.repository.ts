/**
 * Review workspace repository port (ARCHITECTURE.md §5.1, §10.6, §11.3).
 *
 * `workspace` owns the `ReviewWorkspace` aggregate: clone preparation persists
 * one row, cleanup transitions it to `cleaned` or `failed`, and the retention
 * sweep only reads active rows older than a cutoff. Recovery calls the service's
 * public sweep method; it never queries these rows itself.
 */

export const WORKSPACE_STATUSES = ["active", "cleaned", "failed"] as const;
export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number];

export interface WorkspaceRecord {
  id: string;
  reviewId: string;
  path: string;
  headSha: string;
  baseSha: string | null;
  mergeBaseSha: string | null;
  status: WorkspaceStatus;
  lastError: string | null;
  createdAt: Date;
  cleanedAt: Date | null;
}

export interface CreateWorkspaceInput {
  reviewId: string;
  path: string;
  headSha: string;
  baseSha: string | null;
  mergeBaseSha: string | null;
}

export interface MarkWorkspaceCleanedInput {
  /** Present when the sweep clears a stale error; omitted elsewhere. */
  lastError?: string | null;
}

export interface WorkspaceRepository {
  create(input: CreateWorkspaceInput): Promise<WorkspaceRecord>;
  /** Most recent active workspace for a review, newest first. */
  findLatestActive(reviewId: string): Promise<WorkspaceRecord | null>;
  /** Every active workspace for a review (failure cleanup marks all). */
  findActive(reviewId: string): Promise<WorkspaceRecord[]>;
  /** Active workspaces created before the retention cutoff, oldest first. */
  findActiveCreatedBefore(cutoff: Date): Promise<WorkspaceRecord[]>;
  markCleaned(workspaceId: string, input?: MarkWorkspaceCleanedInput): Promise<void>;
  markFailed(workspaceId: string, lastError: string | null): Promise<void>;
}
