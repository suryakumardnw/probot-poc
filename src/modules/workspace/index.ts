/**
 * Review workspace module barrel (ARCHITECTURE.md §5.1, §10.6, §11.3).
 *
 * Owns the review workspace lifecycle: shallow clone, exact-SHA checkout,
 * merge-base diffing, changed-file enumeration, installation-token handling,
 * workspace persistence and cleanup. Downstream modules import this entry
 * point only; git and filesystem internals stay private.
 */

export {
  CloneFailedError,
  DiffFailedError,
  ReviewRetrievalError,
  ReviewWorkspaceService,
  StaleCommitError,
  type PrepareInput,
  type ReviewWorkspaceOperations,
  type ReviewWorkspaceServiceOptions,
  type WorkspacePolicy,
  type WorkspaceResult,
} from "./workspace.js";
export {
  WORKSPACE_STATUSES,
  type CreateWorkspaceInput,
  type MarkWorkspaceCleanedInput,
  type WorkspaceRecord,
  type WorkspaceRepository,
  type WorkspaceStatus,
} from "./workspace.repository.js";
export { createPrismaWorkspaceRepository } from "./prisma-workspace.repository.js";
export {
  FileNotFoundError,
  FileTooLargeError,
  PathEscapeError,
  looksBinary,
  parseNameStatus,
  readWorkspaceFile,
  resolveWorkspacePath,
  type ChangeStatus,
  type ChangedFile,
  type FileContent,
} from "./files.js";
export { buildCloneUrl } from "./credentials.js";
export { redactCredentials, sanitizeGitUrl } from "./redact.js";
export { workspaceDirectorySizeBytes } from "./disk.js";
export { GIT_MAX_BUFFER, GIT_TIMEOUT_MS, GitCommandError, runGit, type RunGitOptions } from "./git.js";
export {
  ReviewJobRetryError,
  createReviewJobProcessor,
  processReviewJob,
  type ProcessOutcome,
  type ProcessReviewJobDeps,
} from "./processor.js";
