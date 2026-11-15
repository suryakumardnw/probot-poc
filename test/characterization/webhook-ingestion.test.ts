import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Probot, ProbotOctokit } from "probot";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createApp } from "../../src/index.js";
import { createReviewQueue } from "../../src/modules/ingestion/queue.js";
import { testEnv } from "../helpers/env.js";
import { createTestIngestion } from "../helpers/ingestion.js";
import { createTestTriage } from "../helpers/triage.js";
import { cleanDatabase, disconnectDatabase, prisma } from "./support.js";

/**
 * Characterization: webhook → durable review ingestion (ARCHITECTURE.md §4,
 * §4.1, §4.4, §12.1, §12.3, §13.1).
 *
 * Deliveries go through the real Probot event boundary; GitHub API side
 * effects are captured through a stubbed fetch (Probot's transport boundary)
 * and all durable assertions read Postgres/Redis-visible state.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const privateKey = fs.readFileSync(path.join(__dirname, "../fixtures/mock-cert.pem"), "utf-8");

const INSTALLATION_ID = 9_701;
const REPOSITORY_ID = 5_701;
const REPO_FULL_NAME = "octo-org/widget";

const OPENED_SHA = "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111";
const SYNC_SHA = "cccc3333cccc3333cccc3333cccc3333cccc3333";

function pullRequestPayload(
  action: "opened" | "synchronize" | "ready_for_review" | "closed" | "labeled",
  overrides: Record<string, unknown> = {},
) {
  const headSha = (overrides.headSha as string) ?? OPENED_SHA;
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

interface CapturedRequest {
  method: string;
  path: string;
  body: unknown;
}

const jsonResponse = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

let captured: CapturedRequest[] = [];

const reviewQueue = createReviewQueue(testEnv.REDIS_URL);
const ingestion = createTestIngestion({ queue: reviewQueue });
const testApp = createApp({
  ingestion: ingestion.services,
  ingestionRepositories: ingestion.repositories,
  ingestionUnitOfWork: ingestion.unitOfWork,
  triage: createTestTriage(),
});

function installFetchStub(): void {
  const stub = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String((input as { url?: string })?.url ?? input));
    let body: unknown = null;
    if (init?.body) {
      try {
        body = JSON.parse(String(init.body));
      } catch {
        body = String(init.body);
      }
    }
    captured.push({ method: init?.method ?? "GET", path: url.pathname, body });

    // GitHub App installation token (Probot auth bootstrap).
    if (url.pathname.startsWith("/app/installations/")) {
      return jsonResponse({ token: "test-installation-token", permissions: {} });
    }
    // Any REST write (issue comments, etc.) succeeds with an empty object.
    return jsonResponse({});
  });
  vi.stubGlobal("fetch", stub);
}

async function ensureQueueReady(): Promise<void> {
  await reviewQueue.queue.waitUntilReady();
}

async function receive(
  probot: Probot,
  event: string,
  action: string,
  payload: Record<string, unknown>,
  deliveryId: string,
): Promise<void> {
  await probot.receive({
    id: deliveryId,
    name: event,
    payload: { ...payload, action },
  });
}

function makeProbot(): Probot {
  const probot = new Probot({
    appId: 123,
    privateKey,
    Octokit: ProbotOctokit.defaults((instanceOptions: any) => ({
      ...instanceOptions,
      retry: { enabled: false },
      throttle: { enabled: false },
    })),
  });
  probot.load(testApp);
  return probot;
}

beforeEach(async () => {
  await cleanDatabase();
  captured = [];
  installFetchStub();
  await ensureQueueReady();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  // Leave Redis clean for the next suite: webhook tests only need their jobs
  // during the test, and no worker consumes them here.
  await reviewQueue.queue.waitUntilReady().catch(() => {});
  const jobs = await reviewQueue.queue.getJobs(["waiting", "paused", "delayed", "failed"]).catch(() => []);
  await Promise.all(jobs.map((job) => job.remove().catch(() => {})));
  await reviewQueue.close();
  await cleanDatabase();
  await disconnectDatabase();
});

describe("pull_request ingestion", () => {
  let probot: Probot;

  beforeEach(() => {
    probot = makeProbot();
  });

  afterEach(async () => {
    await probot.teardown?.();
  });

  test("opened persists the installation/repository/PR/review and enqueues one job", async () => {
    await receive(probot, "pull_request", "opened", pullRequestPayload("opened"), "delivery-opened-1");

    const installation = await prisma.installation.findUniqueOrThrow({
      where: { githubInstallationId: BigInt(INSTALLATION_ID) },
    });
    expect(installation.organization).toBe("octo-org");
    expect(installation.status).toBe("active");

    const repository = await prisma.repository.findUniqueOrThrow({
      where: { githubRepositoryId: BigInt(REPOSITORY_ID) },
    });
    expect(repository.fullName).toBe(REPO_FULL_NAME);
    expect(repository.defaultBranch).toBe("main");

    const pullRequest = await prisma.pullRequest.findFirstOrThrow();
    expect(pullRequest.githubPrNumber).toBe(42);
    expect(pullRequest.headSha).toBe(OPENED_SHA);
    expect(pullRequest.baseSha).toBe("bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222");

    const review = await prisma.review.findFirstOrThrow();
    expect(review.state).toBe("queued");
    expect(review.trigger).toBe("opened");
    expect(review.reviewType).toBe("standard");
    expect(review.attempt).toBe(0);

    const job = await prisma.reviewJob.findFirstOrThrow({ where: { reviewId: review.id } });
    expect(job.status).toBe("enqueued");
    expect(job.jobKey).toBe(`${INSTALLATION_ID}:${REPOSITORY_ID}:42:${OPENED_SHA}:adaptive:standard`);

    const outbox = await prisma.outboxEvent.findFirstOrThrow({ where: { reviewJobId: job.id } });
    expect(outbox.status).toBe("published");
    expect(outbox.publishedAt).not.toBeNull();

    const delivery = await prisma.webhookDelivery.findFirstOrThrow();
    expect(delivery.deliveryId).toBe("delivery-opened-1");
    expect(delivery.event).toBe("pull_request.opened");

    const transitions = await prisma.reviewStateTransition.findMany({ where: { reviewId: review.id } });
    expect(transitions.map((entry) => `${entry.fromState}->${entry.toState}`)).toEqual(["null->queued"]);
  });

  test("synchronize reviews the new head and supersedes the in-flight previous commit", async () => {
    await receive(probot, "pull_request", "opened", pullRequestPayload("opened"), "delivery-sync-1");
    await receive(
      probot,
      "pull_request",
      "synchronize",
      pullRequestPayload("synchronize", { headSha: SYNC_SHA }),
      "delivery-sync-2",
    );

    const reviews = await prisma.review.findMany({ orderBy: { createdAt: "asc" } });
    expect(reviews).toHaveLength(2);
    expect(reviews[0]!.headSha).toBe(OPENED_SHA);
    expect(reviews[0]!.state).toBe("superseded");
    expect(reviews[0]!.supersededByReviewId).toBe(reviews[1]!.id);
    expect(reviews[1]!.headSha).toBe(SYNC_SHA);
    expect(reviews[1]!.state).toBe("queued");
    expect(reviews[1]!.trigger).toBe("synchronized");

    const oldJob = await prisma.reviewJob.findFirstOrThrow({ where: { reviewId: reviews[0]!.id } });
    expect(oldJob.status).toBe("superseded");
    const oldOutbox = await prisma.outboxEvent.findFirstOrThrow({ where: { reviewJobId: oldJob.id } });
    // The event was already published before the push; a superseded job is
    // never enqueued twice and its pending events are discarded.
    expect(oldOutbox.status).toBe("published");
  });

  test("ready_for_review triggers a review with the ready_for_review trigger", async () => {
    await receive(probot, "pull_request", "ready_for_review", pullRequestPayload("ready_for_review"), "delivery-rfr-1");

    const review = await prisma.review.findFirstOrThrow();
    expect(review.trigger).toBe("ready_for_review");
    expect(review.state).toBe("queued");
  });

  test("unsupported pull_request actions are ignored", async () => {
    await receive(probot, "pull_request", "closed", pullRequestPayload("closed"), "delivery-closed-1");
    await receive(probot, "pull_request", "labeled", pullRequestPayload("labeled"), "delivery-labeled-1");

    expect(await prisma.review.count()).toBe(0);
    expect(await prisma.reviewJob.count()).toBe(0);
    expect(await prisma.webhookDelivery.count()).toBe(0);
  });

  test("bot-authored pull requests are never reviewed", async () => {
    await receive(
      probot,
      "pull_request",
      "opened",
      pullRequestPayload("opened", { pull_request: { user: { type: "Bot", login: "dependabot[bot]" } } }),
      "delivery-bot-1",
    );

    expect(await prisma.review.count()).toBe(0);
    expect(await prisma.webhookDelivery.count()).toBe(0);
  });

  test("draft pull requests are skipped while draft review is disabled", async () => {
    await receive(
      probot,
      "pull_request",
      "opened",
      pullRequestPayload("opened", { pull_request: { draft: true } }),
      "delivery-draft-1",
    );

    expect(await prisma.review.count()).toBe(0);
    expect(await prisma.pullRequest.count()).toBe(0);
  });
});

describe("duplicate delivery and review identity (§12.1, §12.3)", () => {
  let probot: Probot;

  beforeEach(() => {
    probot = makeProbot();
  });

  afterEach(async () => {
    await probot.teardown?.();
  });

  test("the same deliveryId twice creates one review and one delivery row", async () => {
    const deliveryId = "delivery-duplicate-1";
    await receive(probot, "pull_request", "opened", pullRequestPayload("opened"), deliveryId);
    await receive(probot, "pull_request", "opened", pullRequestPayload("opened"), deliveryId);

    expect(await prisma.review.count()).toBe(1);
    expect(await prisma.reviewJob.count()).toBe(1);
    expect(await prisma.outboxEvent.count()).toBe(1);
    expect(await prisma.webhookDelivery.count({ where: { deliveryId } })).toBe(1);
  });

  test("the same (PR, headSha, mode, type) with a new delivery creates one review", async () => {
    await receive(probot, "pull_request", "opened", pullRequestPayload("opened"), "delivery-identity-1");
    await receive(probot, "pull_request", "opened", pullRequestPayload("opened"), "delivery-identity-2");

    expect(await prisma.review.count()).toBe(1);
    expect(await prisma.reviewJob.count()).toBe(1);
    expect(await prisma.outboxEvent.count()).toBe(1);
    expect(await prisma.webhookDelivery.count()).toBe(2);
  });
});

describe("manual /review trigger", () => {
  let probot: Probot;

  beforeEach(() => {
    probot = makeProbot();
  });

  afterEach(async () => {
    await probot.teardown?.();
  });

  test("a /review comment creates a manual review and posts an acknowledgment", async () => {
    await receive(probot, "pull_request", "opened", pullRequestPayload("opened"), "delivery-manual-open-1");
    captured = [];

    await receive(probot, "issue_comment", "created", commentPayload("/review"), "delivery-manual-1");

    const reviews = await prisma.review.findMany({ orderBy: { createdAt: "asc" } });
    expect(reviews).toHaveLength(2);
    const manual = reviews[1]!;
    expect(manual.trigger).toBe("manual");
    expect(manual.state).toBe("queued");
    // The checked-in configuration selects handbook as the default type.
    expect(manual.reviewType).toBe("handbook");
    expect(manual.attempt).toBe(1);
    expect(manual.headSha).toBe(OPENED_SHA);

    const manualJob = await prisma.reviewJob.findFirstOrThrow({ where: { reviewId: manual.id } });
    expect(manualJob.status).toBe("enqueued");
    expect(manualJob.jobKey).toBe(`${INSTALLATION_ID}:${REPOSITORY_ID}:42:${OPENED_SHA}:adaptive:handbook:a1`);

    const acknowledgment = captured.find(
      (request) => request.method === "POST" && request.path === `/repos/${REPO_FULL_NAME}/issues/42/comments`,
    );
    expect(acknowledgment).toBeDefined();
    expect(JSON.stringify(acknowledgment!.body)).toContain("Re-review queued");
    expect(JSON.stringify(acknowledgment!.body)).toContain("handbook");
  });

  test("forced manual re-reviews increment attempt without violating identity", async () => {
    await receive(probot, "pull_request", "opened", pullRequestPayload("opened"), "delivery-attempt-open-1");
    await receive(probot, "issue_comment", "created", commentPayload("/review standard"), "delivery-attempt-1");
    await receive(probot, "issue_comment", "created", commentPayload("/review standard"), "delivery-attempt-2");

    const reviews = await prisma.review.findMany({ orderBy: { createdAt: "asc" } });
    expect(reviews).toHaveLength(3);
    expect(reviews.map((review) => review.attempt)).toEqual([0, 1, 2]);
    expect(reviews.map((review) => review.trigger)).toEqual(["opened", "manual", "manual"]);
    expect(reviews.map((review) => review.reviewType)).toEqual(["standard", "standard", "standard"]);
    expect(reviews[0]!.state).toBe("superseded");
    expect(reviews[1]!.state).toBe("superseded");
    expect(reviews[2]!.state).toBe("queued");

    const jobs = await prisma.reviewJob.findMany();
    expect(new Set(jobs.map((job) => job.jobKey)).size).toBe(3);
  });
});
