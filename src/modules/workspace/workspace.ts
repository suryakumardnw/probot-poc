import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../../ports/logger.js";
import { buildCloneUrl, type InstallationTokenProvider } from "./credentials.js";
import { parseNameStatus, type ChangedFile } from "./files.js";
import { runGit } from "./git.js";
import { redactCredentials, sanitizeGitUrl } from "./redact.js";
import type { WorkspaceRepository } from "./workspace.repository.js";

/**
 * Repository review workspace lifecycle (ARCHITECTURE.md §5.1, §10.6, §11.3).
 *
 * For one review job this service:
 *  1. shallow-clones the repository (config `repository.clone.depth`),
 *  2. verifies the PR head ref still matches the requested SHA
 *     (stale commit detection),
 *  3. fetches the PR head commit and checks out the EXACT SHA,
 *  4. resolves the base commit and computes the merge base,
 *  5. generates the PR diff and enumerates changed files,
 *  6. persists workspace metadata (ReviewWorkspace),
 *  7. cleans up the workspace per `repository.workspace` configuration
 *     (`cleanupAfterReview` / `retentionHours`).
 *
 * Credentials: the installation token is embedded in the git URL for
 * transport only. It never reaches the agent, is never persisted and every
 * message that can carry it is redacted before logging or throwing (§10.6).
 * All git invocations use structured argument arrays (§10.3).
 */

export interface WorkspacePolicy {
  cloneDepth: number;
  retentionHours: number;
  cleanupAfterReview: boolean;
  maxFilesPerReview: number;
  gitTimeoutMs: number;
}

export interface PrepareInput {
  reviewId: string;
  repositoryFullName: string;
  installationId: bigint | number;
  pullRequestNumber: number;
  headSha: string;
  /** Known base commit SHA from the webhook payload, when available. */
  baseSha?: string | null;
  /** Base branch name used when baseSha is unknown or unfetchable. */
  baseRef?: string | null;
}

export interface WorkspaceResult {
  workspacePath: string;
  headSha: string;
  baseSha: string | null;
  mergeBaseSha: string | null;
  /** Unified diff between the merge base and the head commit. */
  diff: string;
  changedFiles: ChangedFile[];
}

/**
 * The workspace operations the review worker depends on.
 *
 * Keeping this as a narrow interface (rather than the concrete service class)
 * lets callers inject a typed fake without an unsafe cast, and keeps the
 * processor independent of clone/git internals.
 */
export interface ReviewWorkspaceOperations {
  prepare(input: PrepareInput): Promise<WorkspaceResult>;
  cleanupAfterReview(reviewId: string): Promise<{ removed: boolean }>;
  cleanupAfterFailure(reviewId: string, errorMessage?: string): Promise<void>;
}

export class ReviewRetrievalError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "ReviewRetrievalError";
  }
}

export class StaleCommitError extends ReviewRetrievalError {
  constructor(message: string) {
    super(message, "stale_commit");
    this.name = "StaleCommitError";
  }
}

export class CloneFailedError extends ReviewRetrievalError {
  constructor(message: string) {
    super(message, "clone_failed");
    this.name = "CloneFailedError";
  }
}

export class DiffFailedError extends ReviewRetrievalError {
  constructor(message: string) {
    super(message, "diff_failed");
    this.name = "DiffFailedError";
  }
}

const FULL_NAME_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_PATTERN = /^[0-9a-fA-F]{40}$/;
/**
 * Production clone depth is 1. The merge base is usually not present yet, so
 * the fetch is deepened until `git merge-base` succeeds. Bounded to avoid
 * turning a stale PR into a full-history clone; after this the diff falls
 * back to the base tip and publication degrades to summary-only on a path
 * mismatch.
 */
const MAX_MERGE_BASE_DEPTH = 512;

export interface ReviewWorkspaceServiceOptions {
  policy: WorkspacePolicy;
  /** Directory under which all workspaces are created. */
  rootDir: string;
  tokenProvider: InstallationTokenProvider;
  /** Persistence for the ReviewWorkspace aggregate; absent = filesystem only. */
  workspaceRepository?: WorkspaceRepository;
  logger?: Logger;
  /** Test seam: override clone URL construction (e.g. local fixture path). */
  cloneUrlBuilder?: (ctx: { repositoryFullName: string; token: string }) => string;
}

function sanitizeNameComponent(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80);
}

export class ReviewWorkspaceService implements ReviewWorkspaceOperations {
  constructor(private readonly opts: ReviewWorkspaceServiceOptions) {
    fs.mkdirSync(opts.rootDir, { recursive: true });
  }

  /**
   * Resolve the workspace directory for a workspace path produced by this
   * service — guaranteed to sit inside the workspace root.
   */
  private assertInsideRoot(candidate: string): string {
    const root = path.resolve(this.opts.rootDir);
    const resolved = path.resolve(candidate);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new ReviewRetrievalError("Refusing to operate on a path outside the workspace root", "path_escape");
    }
    return resolved;
  }

  async prepare(input: PrepareInput): Promise<WorkspaceResult> {
    const { policy } = this.opts;
    const log = this.opts.logger;
    if (!FULL_NAME_PATTERN.test(input.repositoryFullName)) {
      throw new ReviewRetrievalError(`Invalid repository full name: ${input.repositoryFullName}`, "invalid_input");
    }
    if (!SHA_PATTERN.test(input.headSha)) {
      throw new ReviewRetrievalError("headSha must be a full 40-character commit SHA", "invalid_input");
    }
    if (input.baseSha && !SHA_PATTERN.test(input.baseSha)) {
      throw new ReviewRetrievalError("baseSha must be a full 40-character commit SHA", "invalid_input");
    }

    const headSha = input.headSha.toLowerCase();
    const dirName = `ws-${sanitizeNameComponent(input.repositoryFullName)}-${input.pullRequestNumber}-${headSha.slice(0, 12)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const workspacePath = this.assertInsideRoot(path.join(this.opts.rootDir, dirName));

    // Mint a short-lived installation token. Never logged, never persisted.
    const { token } = await this.opts.tokenProvider.getInstallationToken(
      input.installationId,
      input.repositoryFullName,
    );
    const cloneUrl = this.opts.cloneUrlBuilder
      ? this.opts.cloneUrlBuilder({ repositoryFullName: input.repositoryFullName, token })
      : buildCloneUrl(input.repositoryFullName, token);

    try {
      // 1. Shallow clone (§5.1 step 2).
      try {
        await runGit(["clone", "--depth", String(policy.cloneDepth), "--no-checkout", cloneUrl, workspacePath], {
          timeoutMs: policy.gitTimeoutMs,
          secret: token,
        });
        log?.debug({ repository: input.repositoryFullName, depth: policy.cloneDepth }, "Shallow clone complete");
      } catch (error) {
        throw new CloneFailedError(
          redactCredentials(`Shallow clone failed for ${input.repositoryFullName}: ${(error as Error).message}`, token),
        );
      }

      // 2. Stale commit detection: the PR head ref must still point at the
      //    requested SHA before we invest in a checkout (§5.1 / ticket scope).
      await this.assertHeadStillCurrent(cloneUrl, input.pullRequestNumber, headSha, token);

      // 3. Fetch the PR head commit and check out the exact SHA.
      try {
        await runGit(
          [
            "fetch",
            "--depth",
            String(policy.cloneDepth),
            "origin",
            `+refs/pull/${input.pullRequestNumber}/head:refs/review/head`,
          ],
          { cwd: workspacePath, timeoutMs: policy.gitTimeoutMs, secret: token },
        );
      } catch (error) {
        throw new CloneFailedError(redactCredentials(`Fetching PR head failed: ${(error as Error).message}`, token));
      }
      try {
        await runGit(["checkout", "--detach", headSha], { cwd: workspacePath, timeoutMs: policy.gitTimeoutMs });
      } catch (error) {
        throw new CloneFailedError(
          redactCredentials(`Checking out head SHA failed: ${(error as Error).message}`, token),
        );
      }
      const actualHead = (await runGit(["rev-parse", "HEAD"], { cwd: workspacePath })).trim().toLowerCase();
      if (actualHead !== headSha) {
        throw new StaleCommitError(`Checked-out HEAD ${actualHead} does not match requested head SHA ${headSha}`);
      }

      // 4. Base commit retrieval + merge-base (§5.1 steps 4/... resolution).
      const baseSha = await this.resolveBase(workspacePath, input, token);
      const mergeBaseSha = baseSha
        ? await this.resolveMergeBase(workspacePath, headSha, baseSha, input.pullRequestNumber, token)
        : null;
      if (baseSha && !mergeBaseSha) {
        log?.warn(
          { baseSha, headSha, maxDepth: MAX_MERGE_BASE_DEPTH },
          "merge-base unavailable after deepening; diffing against the base tip",
        );
      }

      // 5. PR diff generation + changed-file enumeration (§5.1 steps 5/6).
      //
      // GitHub's PR diff is merge-base...head, NOT base-tip..head. When the
      // base branch advanced after the PR branch was cut, diffing against the
      // base tip includes reverse changes for every base-branch commit absent
      // from the head. Those files are not part of the PR, so findings anchored
      // to them are rejected by the review API ("Path could not be resolved").
      const diffBase = mergeBaseSha ?? baseSha;
      const diffRange = diffBase ? `${diffBase}..${headSha}` : headSha;
      let diff: string;
      let nameStatus: string;
      try {
        diff = await runGit(["diff", "--find-renames", diffRange], {
          cwd: workspacePath,
          timeoutMs: policy.gitTimeoutMs,
        });
        nameStatus = await runGit(["diff", "--name-status", "--find-renames", diffRange], {
          cwd: workspacePath,
          timeoutMs: policy.gitTimeoutMs,
        });
      } catch (error) {
        throw new DiffFailedError(redactCredentials(`Diff generation failed: ${(error as Error).message}`, token));
      }
      let changedFiles = parseNameStatus(nameStatus);
      if (changedFiles.length > policy.maxFilesPerReview) {
        log?.warn(
          { total: changedFiles.length, limit: policy.maxFilesPerReview },
          "Changed-file count exceeds limit; truncating",
        );
        changedFiles = changedFiles.slice(0, policy.maxFilesPerReview);
      }

      // 6. Workspace metadata persistence (no credentials stored).
      if (this.opts.workspaceRepository) {
        await this.opts.workspaceRepository.create({
          reviewId: input.reviewId,
          path: workspacePath,
          headSha,
          baseSha,
          mergeBaseSha,
        });
      }

      log?.info(
        {
          reviewId: input.reviewId,
          workspace: sanitizeGitUrl(workspacePath),
          headSha,
          baseSha,
          mergeBaseSha,
          changedFiles: changedFiles.length,
        },
        "Review workspace prepared",
      );

      return { workspacePath, headSha, baseSha, mergeBaseSha, diff, changedFiles };
    } catch (error) {
      // Cleanup after failure: never leave a half-cloned workspace behind.
      await this.removeDirectory(workspacePath);
      throw error;
    }
  }

  /** Verify the live PR head ref still points at the requested SHA. */
  private async assertHeadStillCurrent(
    cloneUrl: string,
    pullRequestNumber: number,
    headSha: string,
    token: string,
  ): Promise<void> {
    let lsRemote: string;
    try {
      lsRemote = await runGit(["ls-remote", cloneUrl, `refs/pull/${pullRequestNumber}/head`], {
        timeoutMs: this.opts.policy.gitTimeoutMs,
        secret: token,
      });
    } catch (error) {
      throw new CloneFailedError(
        redactCredentials(`ls-remote for stale check failed: ${(error as Error).message}`, token),
      );
    }
    const remoteSha = lsRemote.split("\t")[0]?.trim().toLowerCase() ?? "";
    if (!remoteSha) {
      throw new StaleCommitError(`PR ref refs/pull/${pullRequestNumber}/head no longer exists on the remote`);
    }
    if (remoteSha !== headSha) {
      throw new StaleCommitError(`PR head moved: remote ${remoteSha} !== requested ${headSha} (review job is stale)`);
    }
  }

  /** Fetch and resolve the base commit. Returns the resolved base SHA or null. */
  private async resolveBase(workspacePath: string, input: PrepareInput, token: string): Promise<string | null> {
    const { policy } = this.opts;
    const fetchBase = async (spec: string, ref: string): Promise<string | null> => {
      try {
        await runGit(["fetch", "--depth", String(policy.cloneDepth), "origin", spec], {
          cwd: workspacePath,
          timeoutMs: policy.gitTimeoutMs,
          secret: token,
        });
        const sha = (await runGit(["rev-parse", ref], { cwd: workspacePath })).trim().toLowerCase();
        return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
      } catch (error) {
        this.opts.logger?.debug(
          { baseSpec: sanitizeGitUrl(spec), err: redactCredentials((error as Error).message, token) },
          "Base fetch attempt failed",
        );
        return null;
      }
    };

    if (input.baseSha) {
      // Exact base SHA from the webhook payload.
      const direct = await fetchBase(input.baseSha, input.baseSha);
      if (direct) {
        return direct;
      }
    }
    if (input.baseRef) {
      const fromRef = await fetchBase(`+refs/heads/${input.baseRef}:refs/review/base`, "refs/review/base");
      if (fromRef) {
        return fromRef;
      }
    }
    throw new DiffFailedError(
      `Could not resolve base commit (baseSha=${input.baseSha ?? "unknown"}, baseRef=${input.baseRef ?? "unknown"})`,
    );
  }

  /**
   * Resolve the PR merge base even with a depth-1 clone. `git merge-base`
   * needs the common ancestor in the object graph, so deepen the two fetched
   * tips in doubling steps until it is available.
   */
  private async resolveMergeBase(
    workspacePath: string,
    headSha: string,
    baseSha: string,
    pullRequestNumber: number,
    token: string,
  ): Promise<string | null> {
    const { policy } = this.opts;
    const tryMergeBase = async (): Promise<string | null> => {
      try {
        const out = (
          await runGit(["merge-base", headSha, baseSha], {
            cwd: workspacePath,
            timeoutMs: policy.gitTimeoutMs,
            secret: token,
          })
        )
          .trim()
          .toLowerCase();
        return /^[0-9a-f]{40}$/.test(out) ? out : null;
      } catch {
        return null;
      }
    };

    const direct = await tryMergeBase();
    if (direct) {
      return direct;
    }

    let depth = Math.max(1, policy.cloneDepth);
    while (depth < MAX_MERGE_BASE_DEPTH) {
      depth = Math.min(depth * 2, MAX_MERGE_BASE_DEPTH);
      try {
        await runGit(["fetch", `--deepen=${depth}`, "origin", baseSha], {
          cwd: workspacePath,
          timeoutMs: policy.gitTimeoutMs,
          secret: token,
        });
        await runGit(
          ["fetch", `--deepen=${depth}`, "origin", `+refs/pull/${pullRequestNumber}/head:refs/review/head`],
          { cwd: workspacePath, timeoutMs: policy.gitTimeoutMs, secret: token },
        );
      } catch (error) {
        this.opts.logger?.debug(
          { depth, err: redactCredentials((error as Error).message, token) },
          "Merge-base deepening fetch failed",
        );
        return null;
      }
      const found = await tryMergeBase();
      if (found) {
        return found;
      }
    }
    return null;
  }

  /**
   * Remove a workspace directory. Path-safe: refuses anything outside the
   * workspace root.
   */
  async removeDirectory(workspacePath: string): Promise<void> {
    const resolved = this.assertInsideRoot(workspacePath);
    await fsp.rm(resolved, { recursive: true, force: true });
  }

  /**
   * Cleanup after a review (success or failure): remove the directory and
   * mark the metadata row `cleaned` when `cleanupAfterReview` is enabled,
   * otherwise leave the directory in place for `retentionHours`.
   */
  async cleanupAfterReview(reviewId: string): Promise<{ removed: boolean }> {
    const { policy, workspaceRepository } = this.opts;
    if (workspaceRepository) {
      const row = await workspaceRepository.findLatestActive(reviewId);
      if (row) {
        if (policy.cleanupAfterReview) {
          await this.removeDirectory(row.path);
          await workspaceRepository.markCleaned(row.id);
          return { removed: true };
        }
        // Retention: the directory stays until retentionHours elapse.
        return { removed: false };
      }
    }
    return { removed: false };
  }

  /**
   * Force-cleanup after a processing failure, regardless of retention
   * configuration.
   */
  async cleanupAfterFailure(reviewId: string, errorMessage?: string): Promise<void> {
    const { workspaceRepository } = this.opts;
    if (!workspaceRepository) {
      return;
    }
    const rows = await workspaceRepository.findActive(reviewId);
    for (const row of rows) {
      await this.removeDirectory(row.path).catch(() => {
        /* best effort */
      });
      await workspaceRepository.markFailed(row.id, errorMessage ? redactCredentials(errorMessage.slice(0, 500)) : null);
    }
  }

  /**
   * Sweep workspaces older than `retentionHours` (worker background task).
   * `retentionHours === 0` means "no retention" — only rows already marked
   * for cleanup participate; nothing is swept.
   */
  async sweepExpired(retentionHours: number): Promise<number> {
    const { workspaceRepository } = this.opts;
    if (!workspaceRepository || retentionHours <= 0) {
      return 0;
    }
    const cutoff = new Date(Date.now() - retentionHours * 3_600_000);
    const stale = await workspaceRepository.findActiveCreatedBefore(cutoff);
    for (const row of stale) {
      await this.removeDirectory(row.path).catch(() => {
        /* best effort */
      });
      await workspaceRepository.markCleaned(row.id, { lastError: null });
    }
    return stale.length;
  }
}
