import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { UnrecoverableError } from "bullmq";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { AgentRuntimeError } from "../src/agent/types.js";
import { createIngestionRepositories } from "../src/modules/ingestion/prisma-ingestion.repository.js";
import type { InstallationTokenProvider } from "../src/modules/workspace/credentials.js";
import {
  parseNameStatus,
  readWorkspaceFile,
  resolveWorkspacePath,
  PathEscapeError,
  FileTooLargeError,
  looksBinary,
} from "../src/modules/workspace/files.js";
import { createPrismaWorkspaceRepository } from "../src/modules/workspace/prisma-workspace.repository.js";
import {
  ReviewJobRetryError,
  processReviewJob,
  type ProcessReviewJobDeps,
} from "../src/modules/workspace/processor.js";
import { redactCredentials, sanitizeGitUrl } from "../src/modules/workspace/redact.js";
import {
  ReviewWorkspaceService,
  StaleCommitError,
  CloneFailedError,
  DiffFailedError,
} from "../src/modules/workspace/workspace.js";
import { prisma, disconnectDatabase } from "./helpers/db.js";
import { createTestReviewState } from "./helpers/ingestion.js";

/**
 * Ticket 04 integration tests: repository review workspace.
 *
 * Runs against a LOCAL git fixture (no GitHub): a bare origin repository
 * with two commits (base + head) covering added, modified, deleted,
 * renamed, binary and large files, plus refs/pull/42/head. All git
 * commands use argument arrays via the production module under test.
 */

const run = promisify(execFile);

process.env.DATABASE_URL ??= "postgres://postgres:postgres@localhost:5432/reviewer";
process.env.REDIS_URL ??= "redis://localhost:6379";

const INSTALLATION_ID = 77_001n;
const REPO_FULL_NAME = "fixture/local-repo";
const PR_NUMBER = 42;

// Fixture state ----------------------------------------------------------------

let fixtureDir: string;
let originPath: string; // bare "remote"
let baseSha: string;
let headSha: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const res = await run("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", ...args], { cwd });
  return res.stdout.toString();
}

async function createFixture(): Promise<void> {
  fixtureDir = await fsp.mkdtemp(path.join(os.tmpdir(), "ws-fixture-"));
  originPath = path.join(fixtureDir, "origin.git");
  const workPath = path.join(fixtureDir, "work");

  await git(fixtureDir, "init", "--bare", originPath);
  await git(fixtureDir, "clone", originPath, workPath);
  fs.mkdirSync(path.join(workPath, "src"), { recursive: true });

  // Base commit.
  fs.writeFileSync(path.join(workPath, "modified.txt"), "original line\n");
  fs.writeFileSync(path.join(workPath, "deleted.txt"), "to be deleted\n");
  fs.writeFileSync(path.join(workPath, "rename-old.txt"), "renamed content\n");
  await git(workPath, "add", "-A");
  await git(workPath, "commit", "-m", "base commit");
  baseSha = (await git(workPath, "rev-parse", "HEAD")).trim();

  // Head commit: added / modified / deleted / renamed / binary / large.
  fs.writeFileSync(path.join(workPath, "added.txt"), "brand new file\n");
  fs.writeFileSync(path.join(workPath, "modified.txt"), "original line\nchanged line\n");
  fs.unlinkSync(path.join(workPath, "deleted.txt"));
  await git(workPath, "mv", "rename-old.txt", "rename-new.txt");
  fs.writeFileSync(path.join(workPath, "binary.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x01, 0x02]));
  fs.writeFileSync(path.join(workPath, "large.txt"), "x".repeat(40_000));
  await git(workPath, "add", "-A");
  await git(workPath, "commit", "-m", "head commit");
  headSha = (await git(workPath, "rev-parse", "HEAD")).trim();

  // Publish main + PR ref.
  await git(workPath, "push", "origin", `HEAD:refs/heads/main`);
  await git(workPath, "push", "origin", `HEAD:refs/pull/${PR_NUMBER}/head`);
}

async function movePullRef(newSha: string): Promise<void> {
  await git(originPath, "update-ref", `refs/pull/${PR_NUMBER}/head`, newSha);
}

interface AdvancedBaseFixture {
  rootDir: string;
  originPath: string;
  branchPointSha: string;
  baseSha: string;
  headSha: string;
}

/**
 * A PR branch that was opened before main advanced. The PR head branches from
 * an older main commit; the base tip contains commits that are NOT part of the
 * PR. GitHub's PR diff is merge-base...head, so the review must ignore those
 * base-branch-only changes.
 */
async function createAdvancedBaseFixture(): Promise<AdvancedBaseFixture> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ws-advanced-"));
  const origin = path.join(dir, "origin.git");
  const work = path.join(dir, "work");

  await git(dir, "init", "--bare", origin);
  await git(dir, "clone", origin, work);

  fs.writeFileSync(path.join(work, "base.txt"), "base\n");
  await git(work, "add", "-A");
  await git(work, "commit", "-m", "branch point");
  const branchPointSha = (await git(work, "rev-parse", "HEAD")).trim();

  await git(work, "checkout", "-b", "pr");
  fs.writeFileSync(path.join(work, "pr-change.txt"), "the actual PR change\n");
  await git(work, "add", "-A");
  await git(work, "commit", "-m", "pr change");
  const headSha = (await git(work, "rev-parse", "HEAD")).trim();

  await git(work, "checkout", "main");
  fs.writeFileSync(path.join(work, "main-advance.txt"), "changed on main after branching\n");
  await git(work, "add", "-A");
  await git(work, "commit", "-m", "main advance");
  const baseSha = (await git(work, "rev-parse", "HEAD")).trim();

  await git(work, "push", "origin", "main");
  await git(work, "push", "origin", `pr:refs/pull/${PR_NUMBER}/head`);

  return { rootDir: dir, originPath: origin, branchPointSha, baseSha, headSha };
}

// Service factory ----------------------------------------------------------------

function makeTokenProvider(): InstallationTokenProvider & { minted: number } {
  return {
    minted: 0,
    async getInstallationToken() {
      this.minted += 1;
      return { token: "", expiresAt: null }; // empty = unauthenticated local clone
    },
  };
}

type ServiceHandle = {
  service: ReviewWorkspaceService;
  root: string;
  tokens: ReturnType<typeof makeTokenProvider>;
};

function makeService(
  opts: {
    retentionHours?: number;
    cleanupAfterReview?: boolean;
    cloneDepth?: number;
    cloneUrlBuilder?: (ctx: { repositoryFullName: string; token: string }) => string;
  } = {},
): ServiceHandle {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ws-root-"));
  const tokens = makeTokenProvider();
  const service = new ReviewWorkspaceService({
    policy: {
      cloneDepth: opts.cloneDepth ?? 50, // enough history for merge-base in the fixture
      retentionHours: opts.retentionHours ?? 0,
      cleanupAfterReview: opts.cleanupAfterReview ?? true,
      maxFilesPerReview: 2_000,
      gitTimeoutMs: 60_000,
    },
    rootDir: root,
    tokenProvider: tokens,
    workspaceRepository: createPrismaWorkspaceRepository(prisma),
    cloneUrlBuilder: opts.cloneUrlBuilder ?? (() => originPath),
  });
  return { service, root, tokens };
}

// DB helpers ----------------------------------------------------------------------

async function cleanDatabase(): Promise<void> {
  await prisma.reviewWorkspace.deleteMany();
  await prisma.reviewStateTransition.deleteMany();
  await prisma.outboxEvent.deleteMany();
  await prisma.reviewJob.deleteMany();
  await prisma.reviewComment.deleteMany();
  // Findings (from suites that run before this file) reference Review rows.
  await prisma.findingStatusTransition.deleteMany();
  await prisma.finding.deleteMany();
  await prisma.review.deleteMany();
  await prisma.pullRequest.deleteMany();
  await prisma.repository.deleteMany();
  await prisma.installation.deleteMany();
}

async function createReviewChain(): Promise<{ reviewId: string; jobId: string }> {
  const installation = await prisma.installation.create({
    data: { githubInstallationId: INSTALLATION_ID, organization: "fixture-owner", status: "active" },
  });
  const repository = await prisma.repository.create({
    data: {
      githubRepositoryId: 12345n,
      installationId: installation.id,
      fullName: REPO_FULL_NAME,
      defaultBranch: "main",
      status: "active",
    },
  });
  const pullRequest = await prisma.pullRequest.create({
    data: {
      repositoryId: repository.id,
      githubPrNumber: PR_NUMBER,
      status: "open",
      headSha,
      baseSha,
    },
  });
  const review = await prisma.review.create({
    data: {
      pullRequestId: pullRequest.id,
      githubInstallationId: INSTALLATION_ID,
      githubRepositoryId: 12345n,
      pullRequestNumber: PR_NUMBER,
      headSha,
      baseSha,
      state: "queued",
      trigger: "opened",
    },
  });
  const job = await prisma.reviewJob.create({
    data: {
      reviewId: review.id,
      status: "enqueued",
      jobKey: `${INSTALLATION_ID}:12345:${PR_NUMBER}:${headSha}:standard`,
    },
  });
  return { reviewId: review.id, jobId: job.id };
}

/**
 * The workspace metadata table has an FK to Review, so direct `service.prepare`
 * calls in these tests use real Review rows seeded with deterministic ids.
 */
async function seedReviewRow(id: string): Promise<void> {
  const installation = await prisma.installation.upsert({
    where: { githubInstallationId: INSTALLATION_ID },
    create: { githubInstallationId: INSTALLATION_ID, organization: "fixture-owner", status: "active" },
    update: {},
  });
  const repository = await prisma.repository.upsert({
    where: { githubRepositoryId: 12345n },
    create: {
      githubRepositoryId: 12345n,
      installationId: installation.id,
      fullName: REPO_FULL_NAME,
      defaultBranch: "main",
      status: "active",
    },
    update: {},
  });
  const pullRequest = await prisma.pullRequest.upsert({
    where: { repositoryId_githubPrNumber: { repositoryId: repository.id, githubPrNumber: PR_NUMBER } },
    create: { repositoryId: repository.id, githubPrNumber: PR_NUMBER, status: "open", headSha },
    update: {},
  });
  await prisma.review.create({
    data: {
      id,
      pullRequestId: pullRequest.id,
      githubInstallationId: INSTALLATION_ID,
      githubRepositoryId: 12345n,
      pullRequestNumber: PR_NUMBER,
      headSha,
      state: "queued",
      trigger: "opened",
    },
  });
}

// Tests ----------------------------------------------------------------------------

beforeAll(async () => {
  await createFixture();
});

afterAll(async () => {
  await fsp.rm(fixtureDir, { recursive: true, force: true }).catch(() => {});
  await disconnectDatabase();
});

beforeEach(async () => {
  await cleanDatabase();
});

describe("redaction helpers", () => {
  test("sanitizeGitUrl strips userinfo credentials", () => {
    const url = "https://x-access-token:ghs_secret@github.com/octo/repo.git";
    expect(sanitizeGitUrl(url)).not.toContain("ghs_secret");
  });

  test("redactCredentials removes the known secret and URL-encoded variants", () => {
    const text =
      "fatal: unable to access 'https://x-access-token:ghs_secret@github.com/o/r.git/' encoded ghs%5Fsecret end";
    const out = redactCredentials(text, "ghs_secret");
    expect(out).not.toContain("ghs_secret");
    expect(out).toContain("[REDACTED]");
  });
});

describe("workspace prepare", () => {
  test("shallow clone, exact head checkout, base + merge-base, diff and changed files", async () => {
    await seedReviewRow("review-ws-basic");
    const { service, tokens } = makeService();
    const result = await service.prepare({
      reviewId: "review-ws-basic",
      repositoryFullName: REPO_FULL_NAME,
      installationId: INSTALLATION_ID,
      pullRequestNumber: PR_NUMBER,
      headSha,
      baseSha,
    });

    expect(tokens.minted).toBe(1);
    expect(fs.existsSync(result.workspacePath)).toBe(true);
    expect(result.headSha).toBe(headSha);
    expect(result.baseSha).toBe(baseSha);
    expect(result.mergeBaseSha).toBe(baseSha); // linear fixture history

    // Changed files include every change class.
    const byPath = new Map(result.changedFiles.map((f) => [f.path, f]));
    expect(byPath.get("added.txt")?.status).toBe("added");
    expect(byPath.get("modified.txt")?.status).toBe("modified");
    expect(byPath.get("deleted.txt")?.status).toBe("deleted");
    expect(byPath.get("rename-new.txt")?.status).toBe("renamed");
    expect(byPath.get("rename-new.txt")?.previousPath).toBe("rename-old.txt");
    expect(byPath.get("binary.bin")?.status).toBe("added");
    expect(byPath.get("large.txt")?.status).toBe("added");

    // The diff contains hunks for the modified file.
    expect(result.diff).toContain("diff --git");
    expect(result.diff).toContain("changed line");

    // Workspace metadata persisted without credentials.
    const row = await prisma.reviewWorkspace.findFirst({ where: { reviewId: "review-ws-basic" } });
    expect(row?.status).toBe("active");
    expect(row?.headSha).toBe(headSha);
    expect(row?.path).toBe(result.workspacePath);

    // File content retrieval inside the workspace.
    const added = await readWorkspaceFile(result.workspacePath, "added.txt", { maxFileBytes: 1_000_000 });
    expect(added.encoding).toBe("utf-8");
    expect(added.text).toBe("brand new file\n");

    const binary = await readWorkspaceFile(result.workspacePath, "binary.bin", { maxFileBytes: 1_000_000 });
    expect(binary.encoding).toBe("binary");
    expect(binary.text).toBeUndefined();
    expect(looksBinary(binary.bytes)).toBe(true);

    await service.cleanupAfterReview("review-ws-basic");
    expect(fs.existsSync(result.workspacePath)).toBe(false);
    const cleaned = await prisma.reviewWorkspace.findFirst({ where: { reviewId: "review-ws-basic" } });
    expect(cleaned?.status).toBe("cleaned");
    expect(cleaned?.cleanedAt).not.toBeNull();
  });

  test("diff uses the merge base, not the advanced base-branch tip (clone depth 1)", async () => {
    const advanced = await createAdvancedBaseFixture();
    await seedReviewRow("review-ws-mergebase");
    // Production config uses shallow depth 1: the merge base is not initially
    // present, so the service must deepen the fetch before diffing.
    const { service } = makeService({
      cloneDepth: 1,
      cloneUrlBuilder: () => advanced.originPath,
    });

    const result = await service.prepare({
      reviewId: "review-ws-mergebase",
      repositoryFullName: REPO_FULL_NAME,
      installationId: INSTALLATION_ID,
      pullRequestNumber: PR_NUMBER,
      headSha: advanced.headSha,
      baseSha: advanced.baseSha,
    });

    expect(result.mergeBaseSha).toBe(advanced.branchPointSha);
    expect(result.baseSha).toBe(advanced.baseSha);
    // GitHub's PR diff is merge-base...head: only the PR commit's change.
    expect(result.changedFiles.map((file) => file.path)).toEqual(["pr-change.txt"]);
    expect(result.diff).toContain("pr-change.txt");
    expect(result.diff).not.toContain("main-advance.txt");

    await service.cleanupAfterReview("review-ws-mergebase");
    await fsp.rm(advanced.rootDir, { recursive: true, force: true });
  });

  test("stale commit detection: moved PR head ref is rejected", async () => {
    // Point the remote PR ref at the base commit — head no longer matches.
    await movePullRef(baseSha);
    const { service } = makeService();
    await expect(
      service.prepare({
        reviewId: "review-ws-stale",
        repositoryFullName: REPO_FULL_NAME,
        installationId: INSTALLATION_ID,
        pullRequestNumber: PR_NUMBER,
        headSha,
        baseSha,
      }),
    ).rejects.toBeInstanceOf(StaleCommitError);
    // Workspace directory is cleaned up after the failure.
    const root = path.join(os.tmpdir());
    expect(await countWorkspaceDirs()).toBe(0);
    void root;
  });
  afterEach(async () => {
    // Restore the PR ref so later tests see the original head commit.
    await movePullRef(headSha);
  });

  test("clone failure path: no workspace directory left behind", async () => {
    const { service, root } = makeService({
      cloneUrlBuilder: () => path.join(fixtureDir, "does-not-exist.git"),
    });
    await expect(
      service.prepare({
        reviewId: "review-ws-clonefail",
        repositoryFullName: REPO_FULL_NAME,
        installationId: INSTALLATION_ID,
        pullRequestNumber: PR_NUMBER,
        headSha,
        baseSha,
      }),
    ).rejects.toBeInstanceOf(CloneFailedError);
    const entries = await fsp.readdir(root);
    expect(entries).toHaveLength(0);
    expect(await prisma.reviewWorkspace.count({ where: { reviewId: "review-ws-clonefail" } })).toBe(0);
  });

  test("diff failure path: unresolvable base SHA cleans up the workspace", async () => {
    const bogusBase = "1".repeat(40);
    const { service, root } = makeService();
    await expect(
      service.prepare({
        reviewId: "review-ws-difffail",
        repositoryFullName: REPO_FULL_NAME,
        installationId: INSTALLATION_ID,
        pullRequestNumber: PR_NUMBER,
        headSha,
        baseSha: bogusBase,
      }),
    ).rejects.toBeInstanceOf(DiffFailedError);
    expect((await fsp.readdir(root)).filter((e) => e.startsWith("ws-"))).toHaveLength(0);
    expect(await prisma.reviewWorkspace.count({ where: { reviewId: "review-ws-difffail" } })).toBe(0);
  });

  test("path escape and large-file rejection", async () => {
    await seedReviewRow("review-ws-paths");
    const { service } = makeService();
    const result = await service.prepare({
      reviewId: "review-ws-paths",
      repositoryFullName: REPO_FULL_NAME,
      installationId: INSTALLATION_ID,
      pullRequestNumber: PR_NUMBER,
      headSha,
      baseSha,
    });

    expect(() => resolveWorkspacePath(result.workspacePath, "../../etc/passwd")).toThrow(PathEscapeError);
    expect(() => resolveWorkspacePath(result.workspacePath, "/etc/passwd")).toThrow(PathEscapeError);
    expect(() => resolveWorkspacePath(result.workspacePath, "added.txt")).not.toThrow();

    // Large file above the configurable limit is rejected.
    await expect(readWorkspaceFile(result.workspacePath, "large.txt", { maxFileBytes: 1_000 })).rejects.toBeInstanceOf(
      FileTooLargeError,
    );
    // But allowed under a bigger limit.
    const big = await readWorkspaceFile(result.workspacePath, "large.txt", { maxFileBytes: 100_000 });
    expect(big.truncated).toBe(false);
    expect(big.sizeBytes).toBe(40_000);

    await service.cleanupAfterReview("review-ws-paths");
  });

  test("retention mode keeps the workspace until swept", async () => {
    await seedReviewRow("review-ws-retain");
    const { service } = makeService({ cleanupAfterReview: false, retentionHours: 1 });
    const result = await service.prepare({
      reviewId: "review-ws-retain",
      repositoryFullName: REPO_FULL_NAME,
      installationId: INSTALLATION_ID,
      pullRequestNumber: PR_NUMBER,
      headSha,
      baseSha,
    });
    const { removed } = await service.cleanupAfterReview("review-ws-retain");
    expect(removed).toBe(false);
    expect(fs.existsSync(result.workspacePath)).toBe(true);
    expect(await prisma.reviewWorkspace.count({ where: { reviewId: "review-ws-retain", status: "active" } })).toBe(1);
  });

  test("sweep removes workspaces older than retentionHours", async () => {
    await seedReviewRow("review-ws-sweep");
    const { service } = makeService({ cleanupAfterReview: false, retentionHours: 1 });
    const result = await service.prepare({
      reviewId: "review-ws-sweep",
      repositoryFullName: REPO_FULL_NAME,
      installationId: INSTALLATION_ID,
      pullRequestNumber: PR_NUMBER,
      headSha,
      baseSha,
    });
    // Age the row past the cutoff.
    await prisma.reviewWorkspace.updateMany({
      where: { reviewId: "review-ws-sweep" },
      data: { createdAt: new Date(Date.now() - 2 * 3_600_000) },
    });
    const swept = await service.sweepExpired(1);
    expect(swept).toBe(1);
    expect(fs.existsSync(result.workspacePath)).toBe(false);
    const row = await prisma.reviewWorkspace.findFirst({ where: { reviewId: "review-ws-sweep" } });
    expect(row?.status).toBe("cleaned");
  });
});

describe("worker processor", () => {
  function makeDeps(
    service: ReviewWorkspaceService,
    logger: { info(): void; warn(): void; error(): void },
  ): ProcessReviewJobDeps {
    return {
      repositories: createIngestionRepositories(prisma),
      service,
      logger: logger as unknown as ProcessReviewJobDeps["logger"],
      transitionReviewState: createTestReviewState().transitionReviewState,
      concurrency: 1,
    };
  }

  const silentLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };

  test("superseded job is skipped before any workspace work", async () => {
    const { service } = makeService();
    const chain = await createReviewChain();
    await prisma.reviewJob.update({ where: { id: chain.jobId }, data: { status: "superseded" } });
    const outcome = await processReviewJob(
      chain.jobId,
      {
        reviewId: chain.reviewId,
        jobKey: "k",
        githubInstallationId: INSTALLATION_ID.toString(),
        githubRepositoryId: "12345",
        repositoryFullName: REPO_FULL_NAME,
        pullRequestNumber: PR_NUMBER,
        headSha,
        reviewMode: "adaptive",
        trigger: "opened",
      },
      makeDeps(service, silentLogger),
    );
    expect(outcome).toBe("skipped_superseded");
    // No workspace was created for the skipped job.
    expect(await prisma.reviewWorkspace.count({ where: { reviewId: chain.reviewId } })).toBe(0);
  });

  test("enqueued job is processed end-to-end and cleaned up", async () => {
    const { service, root } = makeService();
    const chain = await createReviewChain();
    let prepared = 0;
    const outcome = await processReviewJob(
      chain.jobId,
      {
        reviewId: chain.reviewId,
        jobKey: "k",
        githubInstallationId: INSTALLATION_ID.toString(),
        githubRepositoryId: "12345",
        repositoryFullName: REPO_FULL_NAME,
        pullRequestNumber: PR_NUMBER,
        headSha,
        reviewMode: "adaptive",
        trigger: "opened",
      },
      {
        ...makeDeps(service, silentLogger),
        onWorkspacePrepared: async () => {
          prepared += 1;
        },
      },
    );

    expect(outcome).toBe("processed");
    expect(prepared).toBe(1);
    const job = await prisma.reviewJob.findUnique({ where: { id: chain.jobId } });
    expect(job?.status).toBe("completed");
    const review = await prisma.review.findUnique({ where: { id: chain.reviewId } });
    expect(review?.state).toBe("analyzing");
    // Workspace cleaned up after the review (cleanupAfterReview default true).
    expect(await prisma.reviewWorkspace.count({ where: { reviewId: chain.reviewId, status: "cleaned" } })).toBe(1);
    expect(fs.existsSync(root)).toBe(true); // root survives, workspaces don't
  });

  test("agent runtime crash is classified as agent_crash, not unknown", async () => {
    const { service } = makeService();
    const chain = await createReviewChain();
    const errors: Array<Record<string, unknown>> = [];
    const capturingLogger = {
      ...silentLogger,
      error: (obj: Record<string, unknown>) => errors.push(obj),
    };
    await expect(
      processReviewJob(
        chain.jobId,
        {
          reviewId: chain.reviewId,
          jobKey: "k",
          githubInstallationId: INSTALLATION_ID.toString(),
          githubRepositoryId: "12345",
          repositoryFullName: REPO_FULL_NAME,
          pullRequestNumber: PR_NUMBER,
          headSha,
          reviewMode: "adaptive",
          trigger: "opened",
        },
        {
          ...makeDeps(service, capturingLogger),
          onWorkspacePrepared: async () => {
            throw new AgentRuntimeError("crash", "agent runtime exited with code 1", {
              detail: "provider rejected request: model not found",
            });
          },
        },
        { attempt: 1, maxAttempts: 3 },
      ),
    ).rejects.toBeInstanceOf(ReviewJobRetryError);

    const failure = errors.find((entry) => entry.failure_class !== undefined);
    expect(failure?.error_code).toBe("crash");
    expect(failure?.failure_class).toBe("agent_crash");
    expect(failure?.retry_decision).toMatchObject({ retry: true });
    expect(failure?.err_detail).toContain("model not found");
  });

  test("job still marked pending_outbox is claimed and processed (outbox publish race)", async () => {
    // The queue job can become visible a moment before the outbox publisher
    // commits `enqueued`. The processor must claim it instead of discarding it,
    // otherwise BullMQ marks the skip as success and the review is lost.
    const { service } = makeService();
    const chain = await createReviewChain();
    await prisma.reviewJob.update({ where: { id: chain.jobId }, data: { status: "pending_outbox" } });
    let prepared = 0;
    const outcome = await processReviewJob(
      chain.jobId,
      {
        reviewId: chain.reviewId,
        jobKey: "k",
        githubInstallationId: INSTALLATION_ID.toString(),
        githubRepositoryId: "12345",
        repositoryFullName: REPO_FULL_NAME,
        pullRequestNumber: PR_NUMBER,
        headSha,
        reviewMode: "adaptive",
        trigger: "opened",
      },
      {
        ...makeDeps(service, silentLogger),
        onWorkspacePrepared: async () => {
          prepared += 1;
        },
      },
    );

    expect(outcome).toBe("processed");
    expect(prepared).toBe(1);
    const job = await prisma.reviewJob.findUnique({ where: { id: chain.jobId } });
    expect(job?.status).toBe("completed");
    expect(job?.attempts).toBe(1);
  });

  test("completed job is still skipped", async () => {
    const { service } = makeService();
    const chain = await createReviewChain();
    await prisma.reviewJob.update({ where: { id: chain.jobId }, data: { status: "completed" } });
    const outcome = await processReviewJob(
      chain.jobId,
      {
        reviewId: chain.reviewId,
        jobKey: "k",
        githubInstallationId: INSTALLATION_ID.toString(),
        githubRepositoryId: "12345",
        repositoryFullName: REPO_FULL_NAME,
        pullRequestNumber: PR_NUMBER,
        headSha,
        reviewMode: "adaptive",
        trigger: "opened",
      },
      makeDeps(service, silentLogger),
    );
    expect(outcome).toBe("skipped_status");
    expect(await prisma.reviewWorkspace.count({ where: { reviewId: chain.reviewId } })).toBe(0);
  });

  test("a terminal review is skipped before claiming and mirrors the job status", async () => {
    const { service } = makeService();
    const chain = await createReviewChain();
    await prisma.review.update({
      where: { id: chain.reviewId },
      data: { state: "completed", completedAt: new Date() },
    });

    const outcome = await processReviewJob(
      chain.jobId,
      {
        reviewId: chain.reviewId,
        jobKey: "k",
        githubInstallationId: INSTALLATION_ID.toString(),
        githubRepositoryId: "12345",
        repositoryFullName: REPO_FULL_NAME,
        pullRequestNumber: PR_NUMBER,
        headSha,
        reviewMode: "adaptive",
        trigger: "opened",
      },
      makeDeps(service, silentLogger),
    );

    expect(outcome).toBe("skipped_status");
    const job = await prisma.reviewJob.findUniqueOrThrow({ where: { id: chain.jobId } });
    expect(job.status).toBe("completed");
    // The decided review was not claimed, so its attempt counter did not move.
    expect(job.attempts).toBe(0);
    expect(await prisma.reviewWorkspace.count({ where: { reviewId: chain.reviewId } })).toBe(0);
  });

  test("falls back to the repository default branch when base SHA is unknown", async () => {
    // Manual reviews previously carried no base SHA and failed before cloning.
    // With neither baseSha nor a payload baseRef, the worker must use the
    // repository's default branch to compute the diff.
    const { service } = makeService();
    const chain = await createReviewChain();
    await prisma.review.update({ where: { id: chain.reviewId }, data: { baseSha: null } });
    let prepared = 0;
    const outcome = await processReviewJob(
      chain.jobId,
      {
        reviewId: chain.reviewId,
        jobKey: "k",
        githubInstallationId: INSTALLATION_ID.toString(),
        githubRepositoryId: "12345",
        repositoryFullName: REPO_FULL_NAME,
        pullRequestNumber: PR_NUMBER,
        headSha,
        baseSha: null,
        reviewMode: "adaptive",
        trigger: "manual",
      },
      {
        ...makeDeps(service, silentLogger),
        onWorkspacePrepared: async ({ workspace }) => {
          prepared += 1;
          expect(workspace.baseSha).toBeTruthy();
        },
      },
    );

    expect(outcome).toBe("processed");
    expect(prepared).toBe(1);
  });

  test("processing failure marks job + review failed and cleans up", async () => {
    const { service } = makeService({ cloneUrlBuilder: () => path.join(fixtureDir, "missing.git") });
    const chain = await createReviewChain();
    // A direct caller owns one attempt: a retryable clone failure reported on
    // its final attempt is terminal for this job.
    await expect(
      processReviewJob(
        chain.jobId,
        {
          reviewId: chain.reviewId,
          jobKey: "k",
          githubInstallationId: INSTALLATION_ID.toString(),
          githubRepositoryId: "12345",
          repositoryFullName: REPO_FULL_NAME,
          pullRequestNumber: PR_NUMBER,
          headSha,
          reviewMode: "adaptive",
          trigger: "opened",
        },
        makeDeps(service, silentLogger),
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    const job = await prisma.reviewJob.findUnique({ where: { id: chain.jobId } });
    expect(job?.status).toBe("failed");
    expect(job?.lastError).toContain("clone");
    const review = await prisma.review.findUnique({ where: { id: chain.reviewId } });
    expect(review?.state).toBe("failed");
    expect(review?.errorCode).toBe("retry_exhausted");
  });
});

describe("changed-file parsing", () => {
  test("parseNameStatus handles all change classes", () => {
    const output = [
      "A\tnew.txt",
      "M\tmod.txt",
      "D\told.txt",
      "R100\tprev.txt\tnext.txt",
      "C75\tsrc.txt\tdst.txt",
      "",
    ].join("\n");
    const files = parseNameStatus(output);
    expect(files.map((f) => f.status)).toEqual(["added", "modified", "deleted", "renamed", "copied"]);
    expect(files.find((f) => f.path === "next.txt")?.previousPath).toBe("prev.txt");
  });
});

async function countWorkspaceDirs(): Promise<number> {
  // Workspaces live in per-test mkdtemp roots; assert via DB instead.
  return prisma.reviewWorkspace.count({ where: { status: "active" } });
}
