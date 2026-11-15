import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ReviewState } from "@prisma/client";
import { Probot, ProbotOctokit } from "probot";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { ReviewJobPayload } from "../../src/contracts/queue.js";
import { createApp } from "../../src/index.js";
import { InvalidStateTransitionError } from "../../src/modules/ingestion/index.js";
import { createReviewQueue } from "../../src/platform/queue/review-queue.js";
import { at, defined, first } from "../helpers/assert.js";
import { disconnectDatabase, prisma } from "../helpers/db.js";
import { testEnv } from "../helpers/env.js";
import { webhookReceiver } from "../helpers/events.js";
import { createTestIngestion } from "../helpers/ingestion.js";
import { createTestTriage } from "../helpers/triage.js";

/**
 * Ticket 03 integration tests: durable review ingestion.
 *
 * Everything runs against the local docker-compose dependencies
 * (Postgres on :5432, Redis on :6379). Webhook payloads are delivered through
 * probot.receive with the shared mock private key. No test stops or renames a
 * shared container.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const privateKey = fs.readFileSync(path.join(__dirname, "../fixtures/mock-cert.pem"), "utf-8");

// Integration tests run against the local docker-compose dependencies.
process.env.DATABASE_URL ??= "postgres://postgres:postgres@localhost:5432/reviewer";
process.env.REDIS_URL ??= "redis://localhost:6379";

// The ingestion path loads config/review.json, whose provider.baseURL
// references ${MODEL_BASE_URL}; provide a value so validation succeeds.
process.env.MODEL_BASE_URL ??= "http://localhost:8000";

/**
 * Test seam for the review-type tests: when set, every loadReviewConfig call
 * (webhook handlers + orchestrator) reads this path instead of
 * config/review.json. Only used by the "disabled review type" test; unset
 * the rest of the time so all other tests exercise the real configuration.
 */
const configPathHolder = vi.hoisted(() => ({ path: undefined as string | undefined }));
vi.mock("../../src/platform/config/review-loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/platform/config/review-loader.js")>();
  return {
    ...actual,
    loadReviewConfig: ((path: string, ...rest: unknown[]) =>
      actual.loadReviewConfig(configPathHolder.path ?? path, ...(rest as []))) as typeof actual.loadReviewConfig,
  };
});

// Webhook payload factory -----------------------------------------------------

const INSTALLATION_ID = 9901;
const REPOSITORY_ID = 5501;
const REPO_FULL_NAME = "octo-org/widget";

function pullRequestPayload(
  action: "opened" | "synchronize" | "ready_for_review" | "closed",
  overrides: Record<string, unknown> = {},
) {
  const headSha = (overrides.headSha as string) ?? "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111";
  // Top-level overrides are applied BEFORE the pull_request block is built, so
  // a partial `pull_request` override (e.g. `{ draft: true }`) deep-merges over
  // the defaults instead of clobbering head/base.
  const prOverrides = (overrides.pull_request ?? {}) as Record<string, unknown>;
  const { pull_request: _ignored, ...topLevelOverrides } = overrides;
  void _ignored;
  return {
    action,
    installation: { id: INSTALLATION_ID },
    repository: {
      id: REPOSITORY_ID,
      full_name: REPO_FULL_NAME,
      name: "widget",
      default_branch: "main",
      owner: { login: "octo-org" },
    },
    ...topLevelOverrides,
    pull_request: {
      number: 42,
      draft: false,
      state: "open",
      user: { type: "User", login: "octocat" },
      head: { sha: headSha, ref: "feature" },
      base: { sha: "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222", ref: "main" },
      ...prOverrides,
    },
  };
}

function commentPayload(body: string, overrides: Record<string, unknown> = {}) {
  const issueOverrides = (overrides.issue ?? {}) as Record<string, unknown>;
  const commentOverrides = (overrides.comment ?? {}) as Record<string, unknown>;
  const { issue: _i, comment: _c, ...topLevelOverrides } = overrides;
  void _i;
  void _c;
  return {
    action: "created",
    installation: { id: INSTALLATION_ID },
    repository: {
      id: REPOSITORY_ID,
      full_name: REPO_FULL_NAME,
      name: "widget",
      default_branch: "main",
      owner: { login: "octo-org" },
    },
    ...topLevelOverrides,
    issue: {
      number: 42,
      state: "open",
      draft: false,
      user: { type: "User", login: "octocat" },
      pull_request: { url: `https://api.github.com/repos/${REPO_FULL_NAME}/pulls/42` },
      ...issueOverrides,
    },
    comment: {
      body,
      user: { type: "User", login: "octocat" },
      ...commentOverrides,
    },
  };
}

function installationPayload(
  installationId: number,
  accountLogin: string,
  repos: Array<{ id: number; full_name: string; default_branch?: string }>,
) {
  return {
    action: "created",
    installation: { id: installationId, account: { login: accountLogin } },
    repositories: repos.map((r) => ({
      id: r.id,
      full_name: r.full_name,
      name: r.full_name.split("/")[1],
      default_branch: r.default_branch,
    })),
  };
}

function installationDeletedPayload(installationId: number) {
  return { action: "deleted", installation: { id: installationId, account: { login: "octo-org" } } };
}

// Database helpers -------------------------------------------------------------

async function cleanDatabase(): Promise<void> {
  // FK-safe delete order.
  await prisma.webhookDelivery.deleteMany();
  await prisma.outboxEvent.deleteMany();
  await prisma.reviewStateTransition.deleteMany();
  await prisma.reviewJob.deleteMany();
  await prisma.reviewComment.deleteMany();
  await prisma.reviewWorkspace.deleteMany();
  await prisma.findingStatusTransition.deleteMany();
  await prisma.finding.deleteMany();
  await prisma.commandExecutionAudit.deleteMany();
  await prisma.evaluationRun.deleteMany();
  await prisma.review.deleteMany();
  await prisma.pullRequest.deleteMany();
  await prisma.repository.deleteMany();
  await prisma.installation.deleteMany();
}

async function receiveDelivery(
  probot: Probot,
  event: string,
  action: string | undefined,
  payload: Record<string, unknown>,
  deliveryId: string,
): Promise<void> {
  await webhookReceiver(probot).receive({
    id: deliveryId,
    name: event,
    payload: { ...payload, ...(action ? { action } : {}) },
  });
}

/**
 * Ensure the BullMQ queue connection is actually connected before any
 * webhook delivery. The dedicated outbox connection fails commands fast
 * while disconnected (enableOfflineQueue: false), so a delivery arriving
 * before the TCP handshake completes would leave its outbox event pending.
 */
let reviewQueue = createReviewQueue(testEnv.REDIS_URL);
let ingestion = createTestIngestion({ queue: reviewQueue });

type TestIngestion = ReturnType<typeof createTestIngestion>;

function makeApp(testIngestion: TestIngestion) {
  return createApp({
    ingestion: testIngestion.services,
    ingestionRepositories: testIngestion.repositories,
    ingestionUnitOfWork: testIngestion.unitOfWork,
    triage: createTestTriage(),
    config: testIngestion.config,
  });
}

function makeTestApp() {
  return makeApp(ingestion);
}
let testApp = makeTestApp();

/**
 * Ensure the BullMQ queue connection is actually connected before any
 * webhook delivery. The dedicated outbox connection fails commands fast
 * while disconnected (enableOfflineQueue: false), so a delivery arriving
 * before the TCP handshake completes would leave its outbox event pending.
 * A connection that gave up (after a Redis outage) is recreated, along with
 * the services bound to it.
 */
async function ensureQueueReady(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = reviewQueue.connection.status;
    if (status === "ready") {
      return;
    }
    if (status === "end" || status === "close") {
      await reviewQueue.close().catch(() => {});
      reviewQueue = createReviewQueue(testEnv.REDIS_URL);
      ingestion = createTestIngestion({ queue: reviewQueue });
      testApp = makeTestApp();
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("BullMQ connection did not become ready in time");
}

beforeEach(async () => {
  await cleanDatabase();
  await ensureQueueReady();
});

afterAll(async () => {
  await reviewQueue.close();
  await cleanDatabase();
  await disconnectDatabase();
});

describe("review ingestion", () => {
  let probot: Probot;

  beforeEach(() => {
    probot = new Probot({
      appId: 123,
      privateKey,
      Octokit: ProbotOctokit.defaults((instanceOptions: Record<string, unknown>) => ({
        ...instanceOptions,
        retry: { enabled: false },
        throttle: { enabled: false },
      })),
    });
    probot.load(testApp);
  });

  test("pull_request.opened persists installation, repository, PR, review (queued) and enqueues the job", async () => {
    await receiveDelivery(probot, "pull_request", "opened", pullRequestPayload("opened"), "delivery-opened-1");

    const installation = await prisma.installation.findUnique({
      where: { githubInstallationId: BigInt(INSTALLATION_ID) },
    });
    expect(installation?.status).toBe("active");

    const repository = await prisma.repository.findUnique({ where: { githubRepositoryId: BigInt(REPOSITORY_ID) } });
    expect(repository?.fullName).toBe(REPO_FULL_NAME);
    expect(repository?.defaultBranch).toBe("main");

    const review = defined(await prisma.review.findFirst(), "ingested review");
    expect(review.state).toBe("queued");
    expect(review.trigger).toBe("opened");
    expect(review.headSha).toBe("aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111");
    expect(review.configurationHash).toMatch(/^sha256:/);
    expect(review.schemaVersion).toBe(1);

    const job = await prisma.reviewJob.findFirst({ where: { reviewId: review.id } });
    expect(job?.jobKey).toBe(
      `${INSTALLATION_ID}:${REPOSITORY_ID}:42:aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111:adaptive:standard`,
    );
    // Redis is up in the integration environment: the outbox publishes immediately.
    expect(job?.status).toBe("enqueued");

    const outbox = await prisma.outboxEvent.findFirst();
    expect(outbox?.status).toBe("published");

    // Initial state transition persisted.
    const transitions = await prisma.reviewStateTransition.findMany({ where: { reviewId: review.id } });
    expect(transitions).toHaveLength(1);
    expect(first(transitions).fromState).toBeNull();
    expect(first(transitions).toState).toBe("queued");
  });

  test("duplicate webhook delivery is ignored", async () => {
    const deliveryId = "delivery-duplicate-1";
    await receiveDelivery(probot, "pull_request", "opened", pullRequestPayload("opened"), deliveryId);
    await receiveDelivery(probot, "pull_request", "opened", pullRequestPayload("opened"), deliveryId);

    const reviews = await prisma.review.findMany();
    expect(reviews).toHaveLength(1);
    const deliveries = await prisma.webhookDelivery.findMany({ where: { deliveryId } });
    expect(deliveries).toHaveLength(1);
  });

  test("same commit delivered with a new delivery id does not create a second review (identity)", async () => {
    await receiveDelivery(probot, "pull_request", "opened", pullRequestPayload("opened"), "delivery-id-1");
    const result = await receiveDelivery(
      probot,
      "pull_request",
      "opened",
      pullRequestPayload("opened"),
      "delivery-id-2",
    );

    const reviews = await prisma.review.findMany();
    expect(reviews).toHaveLength(1);
    const jobs = await prisma.reviewJob.findMany();
    expect(jobs).toHaveLength(1);
    void result;
  });

  test("synchronize supersedes the in-flight review of the previous commit (§4.4)", async () => {
    await receiveDelivery(probot, "pull_request", "opened", pullRequestPayload("opened"), "delivery-sync-1");
    const firstReview = await prisma.review.findFirstOrThrow();
    // Push the first review into an in-flight stage so superseding is observable.
    await prisma.review.update({ where: { id: firstReview.id }, data: { state: "analyzing" } });
    await prisma.reviewStateTransition.create({
      data: { reviewId: firstReview.id, fromState: "queued", toState: "analyzing" },
    });

    const newSha = "cccc3333cccc3333cccc3333cccc3333cccc3333";
    await receiveDelivery(
      probot,
      "pull_request",
      "synchronize",
      pullRequestPayload("synchronize", { headSha: newSha }),
      "delivery-sync-2",
    );

    const reviews = await prisma.review.findMany({ orderBy: { createdAt: "asc" } });
    expect(reviews).toHaveLength(2);
    const superseded = first(reviews);
    const replacement = at(reviews, 1);
    expect(superseded.state).toBe("superseded");
    expect(superseded.supersededByReviewId).toBe(replacement.id);
    expect(replacement.headSha).toBe(newSha);
    expect(replacement.state).toBe("queued");

    const firstJob = await prisma.reviewJob.findFirstOrThrow({ where: { reviewId: superseded.id } });
    expect(firstJob.status).toBe("superseded");
    const firstOutbox = await prisma.outboxEvent.findMany({ where: { reviewJobId: firstJob.id } });
    // Pending events of a superseded job are discarded; events already
    // published stay published — the superseded job status is what the
    // worker must honor (§4.4).
    expect(firstOutbox.every((event) => event.status !== "pending")).toBe(true);

    // Transitions for the superseded review were persisted.
    const transitions = await prisma.reviewStateTransition.findMany({
      where: { reviewId: superseded.id },
      orderBy: { createdAt: "asc" },
    });
    expect(transitions.map((t) => t.toState)).toEqual(["queued", "analyzing", "superseded"]);
  });

  test("ready_for_review triggers a review with the ready_for_review trigger", async () => {
    await receiveDelivery(
      probot,
      "pull_request",
      "ready_for_review",
      pullRequestPayload("ready_for_review"),
      "delivery-rfr-1",
    );

    const review = await prisma.review.findFirstOrThrow();
    expect(review.trigger).toBe("ready_for_review");
    expect(review.state).toBe("queued");
  });

  test("draft pull requests are skipped while github.draftPullRequests.enabled is false", async () => {
    await receiveDelivery(
      probot,
      "pull_request",
      "opened",
      pullRequestPayload("opened", { pull_request: { draft: true } }),
      "delivery-draft-1",
    );

    const reviews = await prisma.review.findMany();
    expect(reviews).toHaveLength(0);
  });

  test("bot-authored pull requests are skipped", async () => {
    await receiveDelivery(
      probot,
      "pull_request",
      "opened",
      pullRequestPayload("opened", {
        pull_request: { user: { type: "Bot", login: "dependabot[bot]" } },
      }),
      "delivery-bot-1",
    );

    const reviews = await prisma.review.findMany();
    expect(reviews).toHaveLength(0);
  });

  test("unsupported pull_request actions are ignored", async () => {
    await receiveDelivery(probot, "pull_request", "closed", pullRequestPayload("closed"), "delivery-closed-1");
    await receiveDelivery(probot, "pull_request", "labeled", pullRequestPayload("closed"), "delivery-labeled-1");

    const reviews = await prisma.review.findMany();
    expect(reviews).toHaveLength(0);
    const jobs = await prisma.reviewJob.findMany();
    expect(jobs).toHaveLength(0);
  });

  test("/review comment re-triggers a review even though the commit was already reviewed", async () => {
    // Automatic review of the commit first (trigger opened).
    await receiveDelivery(probot, "pull_request", "opened", pullRequestPayload("opened"), "delivery-cmd-open-1");
    expect(await prisma.review.count()).toBe(1);

    // /review on the same head SHA: forced re-review must be created anyway.
    await receiveDelivery(probot, "issue_comment", "created", commentPayload("/review"), "delivery-cmd-1");

    const reviews = await prisma.review.findMany({ orderBy: { createdAt: "asc" } });
    expect(reviews).toHaveLength(2);
    const manual = at(reviews, 1);
    expect(manual.trigger).toBe("manual");
    expect(manual.state).toBe("queued");
    expect(manual.attempt).toBe(1);
    expect(manual.headSha).toBe("aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111");

    const manualJob = await prisma.reviewJob.findFirstOrThrow({ where: { reviewId: manual.id } });
    expect(manualJob.status).toBe("enqueued");
    expect(manual.reviewType).toBe("handbook");
    expect(manualJob.jobKey).toBe(
      `${INSTALLATION_ID}:${REPOSITORY_ID}:42:aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111:adaptive:handbook:a1`,
    );
  });

  test("repeated /review comments create one fresh review per command", async () => {
    await receiveDelivery(probot, "pull_request", "opened", pullRequestPayload("opened"), "delivery-cmd-open-2");
    await receiveDelivery(probot, "issue_comment", "created", commentPayload("/review"), "delivery-cmd-2");
    await receiveDelivery(probot, "issue_comment", "created", commentPayload("/review standard"), "delivery-cmd-3");

    const reviews = await prisma.review.findMany({ orderBy: { createdAt: "asc" } });
    expect(reviews).toHaveLength(3);
    expect(reviews.map((r) => r.trigger)).toEqual(["opened", "manual", "manual"]);
    expect(reviews.map((r) => r.reviewType)).toEqual(["standard", "handbook", "standard"]);
    expect(reviews.map((r) => r.attempt)).toEqual([0, 1, 1]);
    const jobs = await prisma.reviewJob.findMany();
    expect(new Set(jobs.map((j) => j.jobKey)).size).toBe(3);
  });

  test("/review type:handbook ingests a handbook review with its own attempt counter", async () => {
    await receiveDelivery(probot, "pull_request", "opened", pullRequestPayload("opened"), "delivery-handbook-open-1");
    await receiveDelivery(
      probot,
      "issue_comment",
      "created",
      commentPayload("/review type:handbook"),
      "delivery-handbook-1",
    );

    const reviews = await prisma.review.findMany({ orderBy: { createdAt: "asc" } });
    expect(reviews).toHaveLength(2);
    const handbook = at(reviews, 1);
    expect(handbook.reviewType).toBe("handbook");
    expect(handbook.trigger).toBe("manual");
    expect(handbook.attempt).toBe(1);
    const job = await prisma.reviewJob.findFirstOrThrow({ where: { reviewId: handbook.id } });
    expect(job.jobKey).toBe(
      `${INSTALLATION_ID}:${REPOSITORY_ID}:42:aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111:adaptive:handbook:a1`,
    );

    // Repeating the handbook command increments the handbook attempt counter.
    await receiveDelivery(
      probot,
      "issue_comment",
      "created",
      commentPayload("/review handbook"),
      "delivery-handbook-2",
    );
    const handbookReviews = await prisma.review.findMany({
      where: { reviewType: "handbook" },
      orderBy: { createdAt: "asc" },
    });
    expect(handbookReviews.map((r) => r.attempt)).toEqual([1, 2]);
  });

  test("the same head SHA can have standard and handbook reviews concurrently (distinct identity)", async () => {
    await receiveDelivery(probot, "pull_request", "opened", pullRequestPayload("opened"), "delivery-types-open-1");
    // An explicit standard /review creates a standard review (attempt 1, forced).
    await receiveDelivery(probot, "issue_comment", "created", commentPayload("/review standard"), "delivery-types-1");
    // A handbook review of the SAME head SHA is an independent identity.
    await receiveDelivery(
      probot,
      "issue_comment",
      "created",
      commentPayload("/review type:handbook"),
      "delivery-types-2",
    );

    const reviews = await prisma.review.findMany();
    expect(reviews).toHaveLength(3);
    // §4.4: the forced standard re-review supersedes the in-flight standard
    // review of the same PR — but the handbook review of the same commit is an
    // independent identity and keeps running.
    const standardReviews = reviews.filter((r) => r.reviewType === "standard");
    expect(standardReviews.map((r) => r.state).sort()).toEqual(["queued", "superseded"]);
    const handbookReviews = reviews.filter((r) => r.reviewType === "handbook");
    expect(handbookReviews.map((r) => r.state)).toEqual(["queued"]);

    const jobs = await prisma.reviewJob.findMany();
    expect(new Set(jobs.map((j) => j.jobKey)).size).toBe(3);
    // §4.4: the forced handbook re-review supersedes only the handbook
    // in-flight review; the standard job keeps running.
    expect(jobs.filter((j) => j.status === "superseded")).toHaveLength(1);
    expect(jobs.filter((j) => j.status === "enqueued")).toHaveLength(2);
    // No review of one type bleeds into another type's identity.
    const byType = reviews.reduce<Record<string, number>>((acc, r) => {
      acc[r.reviewType] = (acc[r.reviewType] ?? 0) + 1;
      return acc;
    }, {});
    expect(byType).toEqual({ standard: 2, handbook: 1 });
  });
  test("unknown review type posts help and does not ingest", async () => {
    await receiveDelivery(probot, "pull_request", "opened", pullRequestPayload("opened"), "delivery-unknown-open-1");
    await receiveDelivery(probot, "issue_comment", "created", commentPayload("/review type:wat"), "delivery-unknown-1");
    await receiveDelivery(probot, "issue_comment", "created", commentPayload("/review wat"), "delivery-unknown-2");

    const reviews = await prisma.review.findMany();
    expect(reviews).toHaveLength(1); // only the automatic opened review
    expect(first(reviews).reviewType).toBe("standard");
  });

  test("disabled review type posts help and does not ingest", async () => {
    // The checked-in configuration disables the skill review type. The
    // automatic opened review still ingests; the disabled manual type posts
    // help and creates nothing.
    await receiveDelivery(probot, "pull_request", "opened", pullRequestPayload("opened"), "delivery-disabled-open-1");
    await receiveDelivery(probot, "issue_comment", "created", commentPayload("/review skill"), "delivery-disabled-1");

    const reviews = await prisma.review.findMany();
    expect(reviews).toHaveLength(1);
    expect(first(reviews).reviewType).toBe("standard");
  });

  test("non-command comments, bot comments and closed PRs are ignored", async () => {
    await receiveDelivery(probot, "pull_request", "opened", pullRequestPayload("opened"), "delivery-cmd-open-3");
    const before = await prisma.review.count();

    await receiveDelivery(probot, "issue_comment", "created", commentPayload("Looks good to me!"), "delivery-cmd-4");
    await receiveDelivery(probot, "issue_comment", "created", commentPayload("/reviewre"), "delivery-cmd-5");
    await receiveDelivery(
      probot,
      "issue_comment",
      "created",
      commentPayload("/review", { comment: { user: { type: "Bot", login: "ai-pr-reviewer[bot]" } } }),
      "delivery-cmd-6",
    );
    await receiveDelivery(
      probot,
      "issue_comment",
      "created",
      commentPayload("/review", { issue: { state: "closed" } }),
      "delivery-cmd-7",
    );
    // Plain issues (no pull_request marker) are ignored too.
    await receiveDelivery(
      probot,
      "issue_comment",
      "created",
      commentPayload("/review", { issue: { number: 99, state: "open", pull_request: undefined } }),
      "delivery-cmd-8",
    );

    expect(await prisma.review.count()).toBe(before);
  });

  test("installation.created registers installation + repositories; installation.deleted disables them", async () => {
    await receiveDelivery(
      probot,
      "installation",
      "created",
      installationPayload(9902, "octo-org", [
        { id: 6601, full_name: "octo-org/alpha" },
        { id: 6602, full_name: "octo-org/beta" },
      ]),
      "delivery-install-1",
    );

    const installation = await prisma.installation.findUniqueOrThrow({ where: { githubInstallationId: BigInt(9902) } });
    expect(installation.organization).toBe("octo-org");
    expect(installation.status).toBe("active");
    const repos = await prisma.repository.findMany({ where: { installationId: installation.id } });
    expect(repos.map((r) => r.fullName).sort()).toEqual(["octo-org/alpha", "octo-org/beta"]);

    await receiveDelivery(probot, "installation", "deleted", installationDeletedPayload(9902), "delivery-install-2");
    const deleted = await prisma.installation.findUniqueOrThrow({ where: { githubInstallationId: BigInt(9902) } });
    expect(deleted.status).toBe("deleted");
    const disabled = await prisma.repository.findMany({ where: { installationId: installation.id } });
    expect(disabled.every((r) => r.status === "disabled")).toBe(true);
  });

  test("installation.created writes the payload default branch verbatim (null clears it)", async () => {
    await receiveDelivery(
      probot,
      "installation",
      "created",
      installationPayload(9904, "octo-org", [{ id: 6604, full_name: "octo-org/delta", default_branch: "main" }]),
      "delivery-install-branch-1",
    );

    let repository = await prisma.repository.findUniqueOrThrow({ where: { githubRepositoryId: BigInt(6604) } });
    expect(repository.defaultBranch).toBe("main");

    // GitHub installation payloads are authoritative: a missing branch must
    // overwrite the stored value with null, exactly like the pre-refactor
    // handler.
    await receiveDelivery(
      probot,
      "installation",
      "created",
      installationPayload(9904, "octo-org", [{ id: 6604, full_name: "octo-org/delta" }]),
      "delivery-install-branch-2",
    );

    repository = await prisma.repository.findUniqueOrThrow({ where: { githubRepositoryId: BigInt(6604) } });
    expect(repository.defaultBranch).toBeNull();
  });

  test("manual ingestion creates a manual review and status lookup reports job + transitions", async () => {
    await receiveDelivery(
      probot,
      "installation",
      "created",
      installationPayload(9903, "octo-org", [{ id: 6603, full_name: "octo-org/gamma" }]),
      "delivery-manual-0",
    );

    // Seed a PR for the repository (manual ingestion reviews an existing PR).
    const repository = await prisma.repository.findUniqueOrThrow({ where: { githubRepositoryId: BigInt(6603) } });
    const pullRequest = await prisma.pullRequest.create({
      data: {
        repositoryId: repository.id,
        githubPrNumber: 7,
        headSha: "dddd4444dddd4444dddd4444dddd4444dddd4444",
        status: "open",
      },
    });

    const result = await ingestion.services.ingestManualReview({ repository: "octo-org/gamma", pullRequestNumber: 7 });
    expect(result.outcome).toBe("created");
    expect(result.reviewId).toBeDefined();

    const review = await prisma.review.findUniqueOrThrow({ where: { id: defined(result.reviewId, "review id") } });
    expect(review.trigger).toBe("manual");
    expect(review.reviewType).toBe("standard");
    expect(review.pullRequestId).toBe(pullRequest.id);

    // Manual ingestion accepts a review type (§4.1): same PR/SHA, independent
    // identity.
    const skillResult = await ingestion.services.ingestManualReview({
      repository: "octo-org/gamma",
      pullRequestNumber: 7,
      reviewType: "skill",
    });
    expect(skillResult.outcome).toBe("created");
    const skillReview = await prisma.review.findUniqueOrThrow({
      where: { id: defined(skillResult.reviewId, "skill review id") },
    });
    expect(skillReview.reviewType).toBe("skill");

    const status = await ingestion.services.getReviewStatus(defined(result.reviewId, "review id"));
    expect(status?.review.state).toBe("queued");
    expect(status?.job?.jobKey).toContain(":7:dddd4444dddd4444dddd4444dddd4444dddd4444:adaptive");
    expect(status?.transitions).toHaveLength(1);

    // Unknown repository -> ManualIngestionError surface
    await expect(
      ingestion.services.ingestManualReview({ repository: "octo-org/missing", pullRequestNumber: 1 }),
    ).rejects.toMatchObject({
      name: "ManualIngestionError",
    });

    await expect(ingestion.services.getReviewStatus("nonexistent-id")).resolves.toBeNull();
  });
});

describe("review state machine", () => {
  test("rejects transitions out of terminal states", async () => {
    const repository = await prisma.repository.create({
      data: {
        githubRepositoryId: BigInt(7701),
        installationId: (
          await prisma.installation.create({ data: { githubInstallationId: BigInt(8801), organization: "org" } })
        ).id,
        fullName: "org/terminal",
      },
    });
    const pullRequest = await prisma.pullRequest.create({
      data: { repositoryId: repository.id, githubPrNumber: 1, headSha: "eeee5555eeee5555eeee5555eeee5555eeee5555" },
    });
    const review = await prisma.review.create({
      data: {
        pullRequestId: pullRequest.id,
        githubInstallationId: BigInt(8801),
        githubRepositoryId: BigInt(7701),
        pullRequestNumber: 1,
        headSha: "eeee5555eeee5555eeee5555eeee5555eeee5555",
        trigger: "opened",
        state: "completed",
      },
    });

    await expect(
      ingestion.services.transitionReviewState(review.id, "preparing" as ReviewState),
    ).rejects.toBeInstanceOf(InvalidStateTransitionError);
    await expect(
      ingestion.services.transitionReviewState(review.id, "superseded" as ReviewState),
    ).rejects.toBeInstanceOf(InvalidStateTransitionError);

    // Valid transition still works from a non-terminal state.
    const review2 = await prisma.review.create({
      data: {
        pullRequestId: pullRequest.id,
        githubInstallationId: BigInt(8801),
        githubRepositoryId: BigInt(7701),
        pullRequestNumber: 1,
        headSha: "ffff6666ffff6666ffff6666ffff6666ffff6666",
        trigger: "opened",
      },
    });
    const moved = await ingestion.services.transitionReviewState(review2.id, "preparing" as ReviewState);
    expect(moved.state).toBe("preparing");
    const transitions = await prisma.reviewStateTransition.findMany({
      where: { reviewId: review2.id },
      orderBy: { createdAt: "asc" },
    });
    expect(transitions.map((t) => t.toState)).toEqual(["preparing"]);
  });
});

describe("transactional outbox recovery (§12.2)", () => {
  test("ingestion with the queue unavailable leaves pending outbox events; recovery publishes them", async () => {
    // Deterministic Redis-outage seam: the webhook graph is bound to a queue
    // port whose enqueue always fails. No shared Redis or named container is
    // stopped, so this runs anywhere Postgres/Redis are reachable.
    const unavailableQueue = {
      enqueue: async (): Promise<{ id?: string }> => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:6379");
      },
      close: async () => {},
    };
    const offlineIngestion = createTestIngestion({ queue: unavailableQueue });
    const offlineProbot = new Probot({
      appId: 123,
      privateKey,
      Octokit: ProbotOctokit.defaults((instanceOptions: Record<string, unknown>) => ({
        ...instanceOptions,
        retry: { enabled: false },
        throttle: { enabled: false },
      })),
    });
    offlineProbot.load(makeApp(offlineIngestion));

    await receiveDelivery(
      offlineProbot,
      "pull_request",
      "opened",
      pullRequestPayload("opened", { headSha: "abab7777abab7777abab7777abab7777abab7777" }),
      "delivery-outbox-1",
    );

    const review = await prisma.review.findFirstOrThrow();
    expect(review.state).toBe("queued");
    const job = await prisma.reviewJob.findFirstOrThrow({ where: { reviewId: review.id } });
    expect(job.status).toBe("pending_outbox");
    const event = await prisma.outboxEvent.findFirstOrThrow({ where: { reviewJobId: job.id } });
    expect(event.status).toBe("pending");
    expect(event.attempts).toBe(1);
    expect(event.lastError).toContain("ECONNREFUSED");

    // The real queue port is healthy; recovery drains the pending event.
    const summary = await ingestion.services.recoverOutbox();
    expect(summary.scanned).toBeGreaterThanOrEqual(1);
    expect(summary.published).toBeGreaterThanOrEqual(1);

    const jobAfter = await prisma.reviewJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(jobAfter.status).toBe("enqueued");
    expect(jobAfter.queueJobId).toBe(job.id);
    const eventAfter = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(eventAfter.status).toBe("published");
    expect(eventAfter.publishedAt).not.toBeNull();
  });
});

describe("outbox publish ordering", () => {
  async function seedPendingJob(): Promise<{ jobId: string; eventId: string }> {
    const headSha = "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222";
    const installation = await prisma.installation.create({
      data: { githubInstallationId: BigInt(INSTALLATION_ID), organization: "octo-org" },
    });
    const repository = await prisma.repository.create({
      data: {
        githubRepositoryId: BigInt(REPOSITORY_ID),
        installationId: installation.id,
        fullName: REPO_FULL_NAME,
        defaultBranch: "main",
      },
    });
    const pullRequest = await prisma.pullRequest.create({
      data: { repositoryId: repository.id, githubPrNumber: 77, headSha },
    });
    const review = await prisma.review.create({
      data: {
        pullRequestId: pullRequest.id,
        githubInstallationId: BigInt(INSTALLATION_ID),
        githubRepositoryId: BigInt(REPOSITORY_ID),
        pullRequestNumber: 77,
        headSha,
        state: "queued",
        trigger: "opened",
      },
    });
    const job = await prisma.reviewJob.create({
      data: { reviewId: review.id, status: "pending_outbox", jobKey: `outbox-order-${review.id}` },
    });
    const event = await prisma.outboxEvent.create({
      data: {
        reviewJobId: job.id,
        type: "review.requested",
        payload: {
          reviewId: review.id,
          jobKey: job.jobKey,
          githubInstallationId: String(INSTALLATION_ID),
          githubRepositoryId: String(REPOSITORY_ID),
          repositoryFullName: REPO_FULL_NAME,
          pullRequestNumber: 77,
          headSha,
          baseSha: null,
          reviewMode: "adaptive",
          reviewType: "standard",
          trigger: "opened",
          configurationHash: null,
        },
      },
    });
    return { jobId: job.id, eventId: event.id };
  }

  test("commits enqueued before the queue job becomes visible", async () => {
    // Regression: publishing to Redis before the DB commit let a worker see
    // `pending_outbox`, skip the job, and lose the review permanently.
    const { jobId, eventId } = await seedPendingJob();
    const statusAtAdd: string[] = [];
    const queue = {
      enqueue: async (_payload: ReviewJobPayload, opts: { jobId?: string } = {}) => {
        const row = await prisma.reviewJob.findUniqueOrThrow({ where: { id: jobId } });
        statusAtAdd.push(row.status);
        expect(opts.jobId).toBe(jobId);
        return { id: jobId };
      },
      close: async () => {},
    };

    await expect(createTestIngestion({ queue }).services.publishOutboxEvent(eventId)).resolves.toBe("published");

    expect(statusAtAdd).toEqual(["enqueued"]);
    const job = await prisma.reviewJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("enqueued");
    expect(job.queueJobId).toBe(jobId);
    const event = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: eventId } });
    expect(event.status).toBe("published");
    expect(event.publishedAt).not.toBeNull();
  });

  test("restores pending_outbox and leaves the event pending when publish fails", async () => {
    const { jobId, eventId } = await seedPendingJob();
    const queue = {
      enqueue: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:6379");
      },
      close: async () => {},
    };

    await expect(createTestIngestion({ queue }).services.publishOutboxEvent(eventId)).resolves.toBe("failed");

    const job = await prisma.reviewJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("pending_outbox");
    expect(job.queueJobId).toBeNull();
    const event = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: eventId } });
    expect(event.status).toBe("pending");
    expect(event.attempts).toBe(1);
  });
});
