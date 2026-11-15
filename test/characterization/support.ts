import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { JobStatus, OutboxStatus, ReviewState, ReviewTrigger, ReviewType } from "@prisma/client";
import { reviewConfigSchema, type ReviewConfig } from "../../src/contracts/config.js";
import type { Finding, FindingEvidence } from "../../src/modules/review/index.js";
import { disconnectDatabase, prisma } from "../helpers/db.js";
import { silentLogger } from "../helpers/ingestion.js";

export { disconnectDatabase, prisma, silentLogger };

/** Delete every domain row in FK-safe order. Postgres/Redis are required. */
export async function cleanDatabase(): Promise<void> {
  await prisma.webhookDelivery.deleteMany();
  await prisma.outboxEvent.deleteMany();
  await prisma.reviewComment.deleteMany();
  await prisma.reviewWorkspace.deleteMany();
  await prisma.findingStatusTransition.deleteMany();
  await prisma.finding.deleteMany();
  await prisma.commandExecutionAudit.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.evaluationRun.deleteMany();
  await prisma.reviewStateTransition.deleteMany();
  await prisma.reviewJob.deleteMany();
  await prisma.review.deleteMany();
  await prisma.pullRequest.deleteMany();
  await prisma.repository.deleteMany();
  await prisma.installation.deleteMany();
}

let chainSeq = 0;

export interface SeedReviewChainOptions {
  prefix: string;
  state?: ReviewState;
  trigger?: ReviewTrigger;
  reviewType?: ReviewType;
  reviewMode?: string;
  attempt?: number;
  headSha?: string;
  job?: { status: JobStatus; attempts?: number; jobKey?: string };
  outbox?: { status?: OutboxStatus; payload?: Record<string, unknown> };
}

export interface SeededReviewChain {
  installationId: string;
  repositoryId: string;
  pullRequestId: string;
  reviewId: string;
  headSha: string;
  repositoryFullName: string;
  githubInstallationId: bigint;
  githubRepositoryId: bigint;
  jobId?: string;
  jobKey?: string;
  outboxEventId?: string;
}

/** Narrow the optional seeded identity without a non-null assertion. */
export function jobIdentity(chain: SeededReviewChain): { jobId: string; jobKey: string } {
  if (!chain.jobId || !chain.jobKey) {
    throw new Error("seeded review chain is missing its job identity");
  }
  return { jobId: chain.jobId, jobKey: chain.jobKey };
}

/** Narrow the optional seeded outbox event id without a non-null assertion. */
export function outboxEventId(chain: SeededReviewChain): string {
  if (!chain.outboxEventId) {
    throw new Error("seeded review chain is missing its outbox event id");
  }
  return chain.outboxEventId;
}

/**
 * Seed Installation → Repository → PullRequest → Review, optionally with a
 * ReviewJob and OutboxEvent. IDs are deterministic per call within the file;
 * cleanDatabase() removes previous fixtures between tests.
 */
export async function seedReviewChain(options: SeedReviewChainOptions): Promise<SeededReviewChain> {
  chainSeq += 1;
  const suffix = `${Date.now().toString(36)}${chainSeq.toString(36)}`;
  const githubInstallationId = BigInt(9_200_000 + chainSeq);
  const githubRepositoryId = BigInt(8_200_000 + chainSeq);
  const headSha = options.headSha ?? `characterization-${suffix}`;
  const prNumber = 100 + chainSeq;
  const repositoryFullName = `${options.prefix}-org/${options.prefix}-repo`;

  const installation = await prisma.installation.create({
    data: {
      githubInstallationId,
      organization: `${options.prefix}-org`,
      status: "active",
    },
  });
  const repository = await prisma.repository.create({
    data: {
      githubRepositoryId,
      installationId: installation.id,
      fullName: repositoryFullName,
      defaultBranch: "main",
      status: "active",
    },
  });
  const pullRequest = await prisma.pullRequest.create({
    data: {
      repositoryId: repository.id,
      githubPrNumber: prNumber,
      headSha,
      baseSha: `base-${suffix}`,
      status: "open",
    },
  });
  const review = await prisma.review.create({
    data: {
      pullRequestId: pullRequest.id,
      githubInstallationId,
      githubRepositoryId,
      pullRequestNumber: prNumber,
      headSha,
      baseSha: `base-${suffix}`,
      state: options.state ?? "queued",
      trigger: options.trigger ?? "opened",
      reviewMode: options.reviewMode ?? "adaptive",
      reviewType: options.reviewType ?? "standard",
      attempt: options.attempt ?? 0,
    },
  });

  const seeded: SeededReviewChain = {
    installationId: installation.id,
    repositoryId: repository.id,
    pullRequestId: pullRequest.id,
    reviewId: review.id,
    headSha,
    repositoryFullName,
    githubInstallationId,
    githubRepositoryId,
  };

  if (options.job) {
    const job = await prisma.reviewJob.create({
      data: {
        reviewId: review.id,
        status: options.job.status,
        attempts: options.job.attempts ?? 0,
        jobKey: options.job.jobKey ?? `${options.prefix}-job-${suffix}`,
      },
    });
    seeded.jobId = job.id;
    seeded.jobKey = job.jobKey;

    if (options.outbox) {
      const event = await prisma.outboxEvent.create({
        data: {
          reviewJobId: job.id,
          type: "review.requested",
          status: options.outbox.status ?? "pending",
          payload: options.outbox.payload ?? {
            reviewId: review.id,
            jobKey: job.jobKey,
            githubInstallationId: String(githubInstallationId),
            githubRepositoryId: String(githubRepositoryId),
            repositoryFullName,
            pullRequestNumber: prNumber,
            headSha,
            baseSha: `base-${suffix}`,
            reviewMode: options.reviewMode ?? "adaptive",
            reviewType: options.reviewType ?? "standard",
            trigger: options.trigger ?? "opened",
            configurationHash: null,
          },
        },
      });
      seeded.outboxEventId = event.id;
    }
  }

  return seeded;
}

export function makeReviewConfig(overrides: Record<string, unknown> = {}): ReviewConfig {
  return reviewConfigSchema.parse({
    schemaVersion: 1,
    github: { organization: "fixture-org" },
    provider: {
      baseURL: "https://llm.example.test/compat",
      apiKeyEnv: "MODEL_API_KEY",
      model: "workers-ai/@cf/zai-org/glm-4.7-flash",
    },
    ...overrides,
  });
}

let findingSeq = 0;

export function makeFindingEvidence(partial: Partial<FindingEvidence> = {}): FindingEvidence[] {
  return [
    {
      file: "src/app.js",
      line: 2,
      excerpt: "function broken(a, b) {",
      reason: "the function shown is the one with the issue",
      ...partial,
    },
  ];
}

export function makeFinding(overrides: Partial<Finding> = {}): Finding {
  findingSeq += 1;
  return {
    category: "maintainability",
    severity: "medium",
    confidence: 0.9,
    title: `Characterization issue ${findingSeq}`,
    file: "src/app.js",
    line: 2,
    description: "the broken function has a real problem",
    evidence: makeFindingEvidence(),
    verified: false,
    ...overrides,
  };
}

/**
 * A small workspace the findings verifier can anchor against.
 * `src/app.js` has 8 lines; line 2 carries the broken function.
 */
export const APP_V1 = [
  "const x = require('x');",
  "function broken(a, b) {",
  "  return a + b; // fine",
  "}",
  "",
  "function unused() {",
  "  return 1;",
  "}",
].join("\n");

export interface WorkspaceFixture {
  path: string;
  write(source: string): Promise<void>;
  remove(): Promise<void>;
}

export async function writeWorkspace(prefix = "characterization-ws-"): Promise<WorkspaceFixture> {
  const workspacePath = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  const appPath = path.join(workspacePath, "src", "app.js");
  await fsp.mkdir(path.dirname(appPath), { recursive: true });
  await fsp.writeFile(appPath, `${APP_V1}\n`, "utf-8");
  await fsp.writeFile(path.join(workspacePath, "src", "helper.js"), "export const help = () => 0;\n", "utf-8");
  return {
    path: workspacePath,
    write: async (source: string) => {
      await fsp.writeFile(appPath, source, "utf-8");
    },
    remove: async () => {
      await fsp.rm(workspacePath, { recursive: true, force: true });
    },
  };
}
