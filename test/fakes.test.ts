import { describe, expect, test } from "vitest";
import type { ReviewJobPayload } from "../src/contracts/queue.js";
import type { CreateFindingInput } from "../src/modules/findings/findings.repository.js";
import type { ReviewJobRecord } from "../src/modules/ingestion/ingestion.repository.js";
import type { FindingEvidence } from "../src/modules/review/index.js";
import type { ModelResponse } from "../src/ports/model-provider.js";
import { AgentRuntimeError, ModelProviderError } from "../src/shared/errors/index.js";
import { FakeAgentRuntime } from "./fakes/agent-runtime.js";
import { FakeClock } from "./fakes/clock.js";
import { FakeLogger } from "./fakes/logger.js";
import { FakeModelProvider } from "./fakes/model-provider.js";
import {
  createFakeFindings,
  createFakePublishingRepositories,
  FakeAuditRepository,
  FakeOutboxRepository,
  FakeWorkspaceRepository,
} from "./fakes/repositories.js";
import { FakeReviewQueue } from "./fakes/review-queue.js";

const EVIDENCE: FindingEvidence[] = [
  { file: "src/app.ts", line: 2, excerpt: "const broken = true;", reason: "the finding is anchored here" },
];

function findingInput(overrides: Partial<CreateFindingInput> = {}): CreateFindingInput {
  return {
    reviewId: "review-1",
    repositoryId: "repository-1",
    fingerprint: "fingerprint-1",
    category: "functional",
    severity: "high",
    confidence: 0.9,
    title: "Broken guard",
    filePath: "src/app.ts",
    lineNumber: 2,
    description: "the guard never runs",
    impact: null,
    recommendation: null,
    guideline: null,
    evidence: EVIDENCE,
    verified: true,
    status: "new",
    reopenedFromFindingId: null,
    ...overrides,
  };
}

const reviewJob = (overrides: Partial<ReviewJobRecord> = {}): ReviewJobRecord => ({
  id: "job-1",
  reviewId: "review-1",
  status: "enqueued",
  attempts: 0,
  lastError: null,
  queueJobId: null,
  jobKey: "job-key-1",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  ...overrides,
});

const queuePayload = (overrides: Partial<ReviewJobPayload> = {}): ReviewJobPayload => ({
  reviewId: "review-1",
  jobKey: "job-key-1",
  githubInstallationId: "1",
  githubRepositoryId: "2",
  repositoryFullName: "acme/widgets",
  pullRequestNumber: 7,
  headSha: "head-sha",
  baseSha: "base-sha",
  reviewMode: "adaptive",
  reviewType: "standard",
  trigger: "opened",
  configurationHash: "sha256:config",
  ...overrides,
});

describe("FakeClock", () => {
  test("returns copies and supports set/advance", () => {
    const clock = new FakeClock("2026-01-01T00:00:00.000Z");
    const first = clock.now();
    first.setUTCFullYear(2030);
    expect(clock.now().toISOString()).toBe("2026-01-01T00:00:00.000Z");

    clock.advance(1_500);
    expect(clock.now().toISOString()).toBe("2026-01-01T00:00:01.500Z");
    clock.set("2026-02-01T12:00:00.000Z");
    expect(clock.now().toISOString()).toBe("2026-02-01T12:00:00.000Z");
  });
});

describe("FakeLogger", () => {
  test("records both overloads and shares child bindings with the parent", () => {
    const logger = new FakeLogger();
    logger.info("plain");
    logger.info({ reviewId: "review-1" }, "with context");
    const child = logger.child({ jobId: "job-1" });
    child.warn({ stage: "publish" }, "child line");

    expect(logger.messages()).toEqual(["plain", "with context", "child line"]);
    expect(logger.entriesFor("info")).toHaveLength(2);
    const childEntry = logger.entriesFor("warn")[0];
    expect(childEntry?.context).toEqual({ stage: "publish" });
    expect(childEntry?.bindings).toEqual({ jobId: "job-1" });
    logger.clear();
    expect(logger.entries).toHaveLength(0);
  });
});

describe("FakeAgentRuntime", () => {
  test("starts isolated sessions and validates scripted output", async () => {
    const clock = new FakeClock("2026-01-01T00:00:00.000Z");
    const runtime = new FakeAgentRuntime({ clock });
    runtime.queueResponse({ findings: [] });

    const session = await runtime.startSession({ reviewId: "review-1", workspacePath: "/workspace" });
    expect(session.id).toBe("sess-fake-1");
    expect(session.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(runtime.started).toEqual([{ reviewId: "review-1", workspacePath: "/workspace" }]);

    const result = await runtime.execute(session, {
      instruction: "review",
      output: "json",
      validate: (value) => ({ ok: true, value }),
    });
    expect(result.value).toEqual({ findings: [] });
    expect(result.json).toEqual({ findings: [] });
    expect(runtime.tasks).toHaveLength(1);
  });

  test("fails validation, missing scripts and queued failures like the real port", async () => {
    const runtime = new FakeAgentRuntime();
    runtime.queueResponse({ wrong: true });
    const session = await runtime.startSession({ reviewId: "review-1", workspacePath: "/workspace" });

    await expect(
      runtime.execute(session, {
        instruction: "review",
        output: "json",
        validate: () => ({ ok: false, error: "missing findings" }),
      }),
    ).rejects.toMatchObject({ code: "invalid_output" });

    await expect(runtime.execute(session, { instruction: "again", output: "text" })).rejects.toBeInstanceOf(
      AgentRuntimeError,
    );

    const failure = new AgentRuntimeError("timeout", "timed out");
    runtime.queueExecuteError(failure);
    await expect(runtime.execute(session, { instruction: "third", output: "text" })).rejects.toBe(failure);

    await runtime.terminate(session);
    expect(runtime.terminated).toBe(1);
    expect(runtime.terminatedSessions).toEqual([session]);
    await expect(runtime.healthCheck()).resolves.toMatchObject({ healthy: true });
  });

  test("supports start, terminate and health failures", async () => {
    const runtime = new FakeAgentRuntime();
    runtime.queueStartSessionError(new AgentRuntimeError("spawn", "cannot spawn"));
    await expect(runtime.startSession({ reviewId: "review-1", workspacePath: "/workspace" })).rejects.toMatchObject({
      code: "spawn",
    });
    const session = await runtime.startSession({ reviewId: "review-1", workspacePath: "/workspace" });
    const terminateFailure = new AgentRuntimeError("crash", "terminate failed");
    runtime.queueTerminateError(terminateFailure);
    await expect(runtime.terminate(session)).rejects.toBe(terminateFailure);
    expect(runtime.terminated).toBe(1);
    runtime.queueHealthError(new Error("health probe failed"));
    await expect(runtime.healthCheck()).rejects.toThrow("health probe failed");
  });
});

describe("FakeModelProvider", () => {
  const response: ModelResponse = {
    content: "pong",
    finishReason: "stop",
    latencyMs: 3,
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  };

  test("records requests and returns scripted responses", async () => {
    const provider = new FakeModelProvider();
    provider.queueResponse(response);
    await expect(provider.chat({ messages: [{ role: "user", content: "ping" }] })).resolves.toEqual(response);
    expect(provider.requests).toHaveLength(1);
    await expect(provider.getCapabilities()).resolves.toMatchObject({ chatCompletions: true });
    await expect(provider.healthCheck()).resolves.toMatchObject({ healthy: true });
  });

  test("fails when the script is exhausted or a failure is queued", async () => {
    const provider = new FakeModelProvider();
    await expect(provider.chat({ messages: [] })).rejects.toBeInstanceOf(ModelProviderError);

    const failure = new ModelProviderError("rate_limit", "slow down");
    provider.queueChatError(failure);
    await expect(provider.chat({ messages: [] })).rejects.toBe(failure);
  });
});

describe("FakeReviewQueue", () => {
  test("records payloads and returns the durable job id", async () => {
    const queue = new FakeReviewQueue();
    await expect(
      queue.enqueue(queuePayload(), {
        jobId: "job-1",
        attempts: 3,
        backoff: { type: "exponential", delay: 1_000 },
      }),
    ).resolves.toEqual({ id: "job-1" });
    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0]?.options.attempts).toBe(3);
    await queue.close();
    expect(queue.closed).toBe(true);
    expect(queue.closeCalls).toBe(1);
  });

  test("supports enqueue and close failures", async () => {
    const queue = new FakeReviewQueue();
    queue.queueEnqueueError(new Error("ECONNREFUSED"));
    await expect(
      queue.enqueue(queuePayload(), { jobId: "job-1", attempts: 1, backoff: { type: "fixed", delay: 0 } }),
    ).rejects.toThrow("ECONNREFUSED");
    queue.queueCloseError(new Error("close failed"));
    await expect(queue.close()).rejects.toThrow("close failed");
  });
});

describe("fake repositories", () => {
  test("findings repository persists lifecycle transitions and supports rollback", async () => {
    const clock = new FakeClock("2026-01-01T00:00:00.000Z");
    const { findings, statusTransitions, unitOfWork } = createFakeFindings({ clock });

    const created = await findings.create(findingInput());
    expect(created.id).toBe("finding-1");
    await expect(findings.findActiveByReview({ reviewId: "review-1", statuses: ["new"] })).resolves.toEqual([
      { id: "finding-1", status: "new" },
    ]);
    await findings.markResolved({ findingId: created.id, resolvedAt: clock.now() });
    await expect(findings.findByReview("review-1")).resolves.toMatchObject([{ status: "resolved" }]);

    await expect(
      unitOfWork.execute(async (repos) => {
        await repos.findings.create(findingInput({ fingerprint: "fingerprint-2" }));
        await repos.statusTransitions.create({
          findingId: "finding-2",
          reviewId: "review-1",
          fromStatus: null,
          toStatus: "new",
          reason: "test",
        });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    await expect(findings.findByReview("review-1")).resolves.toHaveLength(1);
    expect(statusTransitions.transitions).toHaveLength(0);
  });

  test("findings repository rejects unknown rows and orders prior occurrences", async () => {
    const clock = new FakeClock("2026-01-03T00:00:00.000Z");
    const { findings } = createFakeFindings({ clock });
    const older = await findings.create(findingInput({ reviewId: "review-older", fingerprint: "fingerprint-old" }));
    clock.advance(1_000);
    await findings.create(findingInput({ reviewId: "review-newer", fingerprint: "fingerprint-new" }));

    const priors = await findings.findPriorOccurrences({
      repositoryId: "repository-1",
      excludeReviewId: "review-newer",
    });
    expect(priors.map((prior) => prior.fingerprint)).toEqual(["fingerprint-old"]);

    await findings.markSuperseded({ findingId: older.id, supersededByReviewId: "review-newer" });
    await expect(findings.findByReview("review-older")).resolves.toMatchObject([{ status: "superseded" }]);
    await expect(findings.markResolved({ findingId: "missing", resolvedAt: clock.now() })).rejects.toThrow(
      "unknown finding",
    );
  });

  test("findings repository rejects duplicate review/fingerprint rows", async () => {
    const { findings } = createFakeFindings();
    await findings.create(findingInput());
    await expect(findings.create(findingInput({ title: "Duplicate fingerprint" }))).rejects.toThrow(
      "duplicate fingerprint fingerprint-1 in review review-1",
    );
    await expect(findings.findByReview("review-1")).resolves.toHaveLength(1);
  });

  test("findings repository orders by verified, severity then createdAt", async () => {
    const clock = new FakeClock("2026-01-01T00:00:00.000Z");
    const { findings } = createFakeFindings({ clock });
    const firstLow = await findings.create(findingInput({ fingerprint: "low-first", verified: true, severity: "low" }));
    clock.advance(1_000);
    const critical = await findings.create(
      findingInput({ fingerprint: "critical", verified: true, severity: "critical" }),
    );
    clock.advance(1_000);
    const unverified = await findings.create(
      findingInput({ fingerprint: "unverified", verified: false, severity: "critical" }),
    );
    clock.advance(1_000);
    const secondLow = await findings.create(
      findingInput({ fingerprint: "low-second", verified: true, severity: "low" }),
    );

    const ordered = await findings.findByReview("review-1");
    expect(ordered.map((row) => row.id)).toEqual([critical.id, firstLow.id, secondLow.id, unverified.id]);
  });

  test("findings repository ranks severities instead of comparing them lexicographically", async () => {
    const { findings } = createFakeFindings();
    for (const severity of ["informational", "low", "medium", "high", "critical"] as const) {
      await findings.create(findingInput({ fingerprint: `severity-${severity}`, severity }));
    }

    const ordered = await findings.findByReview("review-1");
    expect(ordered.map((row) => row.severity)).toEqual(["critical", "high", "medium", "low", "informational"]);
  });

  test("workspace repository enforces active/latest/retention rules", async () => {
    const clock = new FakeClock("2026-01-01T00:00:00.000Z");
    const repository = new FakeWorkspaceRepository({ clock });
    const first = await repository.create({
      reviewId: "review-1",
      path: "/workspaces/first",
      headSha: "head-1",
      baseSha: null,
      mergeBaseSha: null,
    });
    clock.advance(60_000);
    const second = await repository.create({
      reviewId: "review-1",
      path: "/workspaces/second",
      headSha: "head-2",
      baseSha: null,
      mergeBaseSha: null,
    });

    await expect(repository.findLatestActive("review-1")).resolves.toMatchObject({ id: second.id });
    await repository.markCleaned(second.id, { lastError: null });
    await expect(repository.findActive("review-1")).resolves.toMatchObject([{ id: first.id }]);
    await expect(repository.findActiveCreatedBefore(new Date("2026-01-01T00:30:00.000Z"))).resolves.toMatchObject([
      { id: first.id },
    ]);
    clock.advance(60_000);
    await repository.markFailed(first.id, "clone failed");
    expect(repository.findById(first.id)).toMatchObject({
      status: "failed",
      lastError: "clone failed",
      cleanedAt: new Date("2026-01-01T00:02:00.000Z"),
    });
    await expect(repository.findLatestActive("review-1")).resolves.toBeNull();
    await expect(repository.markFailed("missing", null)).rejects.toThrow("unknown workspace");
  });

  test("workspace repository turns queued mutation failures into rejections", async () => {
    const repository = new FakeWorkspaceRepository();
    const workspace = await repository.create({
      reviewId: "review-1",
      path: "/workspaces/first",
      headSha: "head-1",
      baseSha: null,
      mergeBaseSha: null,
    });
    const failure = new Error("workspace update failed");
    repository.queueMutationError(failure);
    await expect(repository.markCleaned(workspace.id)).rejects.toBe(failure);
    expect(repository.findById(workspace.id)?.status).toBe("active");

    repository.queueMutationError(failure);
    await expect(repository.markFailed(workspace.id, "cleanup failed")).rejects.toBe(failure);
    expect(repository.findById(workspace.id)?.status).toBe("active");
  });

  test("publishing repositories reconcile retries and record usage", async () => {
    const publishing = createFakePublishingRepositories([
      { reviewId: "review-1", reviewType: "standard", repositoryId: "repository-1" },
    ]);
    await publishing.comments.recordPublication({
      reviewId: "review-1",
      summary: { githubCommentId: 10 },
      inlineComments: [{ findingId: "finding-1", fingerprint: "fingerprint-1", githubCommentId: 11 }],
    });
    await expect(publishing.comments.listPublishedFingerprints("review-1")).resolves.toEqual([
      { fingerprint: "fingerprint-1", githubCommentId: 11 },
    ]);
    await expect(publishing.comments.findPublishedSummaryCommentId("review-1")).resolves.toBe(10);

    await publishing.comments.recordFailure("review-1");
    expect(publishing.comments.wasMarkedFailed("review-1")).toBe(true);
    await publishing.reviews.markPublishSkipped("review-1");
    await publishing.reviews.recordUsage({ reviewId: "review-1", inputTokens: 10, outputTokens: 5 });
    expect(publishing.reviews.skippedReviewIds.has("review-1")).toBe(true);
    expect(publishing.reviews.usage).toEqual([{ reviewId: "review-1", inputTokens: 10, outputTokens: 5 }]);
    await expect(publishing.reviews.findReviewContext("review-1")).resolves.toMatchObject({
      repositoryId: "repository-1",
    });
  });

  test("publishing repositories propagate queued write failures", async () => {
    const publishing = createFakePublishingRepositories();
    const failure = new Error("publication write failed");
    publishing.comments.queueRecordPublicationError(failure);
    await expect(
      publishing.comments.recordPublication({ reviewId: "review-1", summary: null, inlineComments: [] }),
    ).rejects.toBe(failure);
    await publishing.comments.recordFailure("review-1");
    expect(publishing.comments.wasMarkedFailed("review-1")).toBe(true);

    publishing.reviews.queueMarkPublishSkippedError(failure);
    await expect(publishing.reviews.markPublishSkipped("review-1")).rejects.toBe(failure);
    publishing.reviews.queueRecordUsageError(failure);
    await expect(
      publishing.reviews.recordUsage({ reviewId: "review-1", inputTokens: 1, outputTokens: 1 }),
    ).rejects.toBe(failure);
    expect(publishing.reviews.skippedReviewIds.size).toBe(0);
    expect(publishing.reviews.usage).toHaveLength(0);
  });

  test("audit repository lists newest first and propagates write failures", async () => {
    const clock = new FakeClock("2026-01-01T00:00:00.000Z");
    const audit = new FakeAuditRepository({ clock });
    await audit.record({ actor: "admin", action: "admin.login", resource: "session" });
    clock.advance(1_000);
    await audit.record({
      actor: "admin",
      action: "config.update",
      resource: "review.json",
      metadata: { source: "panel" },
    });

    const page = await audit.listPage({ limit: 1, offset: 0 });
    expect(page.total).toBe(2);
    expect(page.rows).toMatchObject([{ action: "config.update" }]);
    const allRows = await audit.listPage({ limit: 2, offset: 0 });
    expect(allRows.rows.find((row) => row.action === "admin.login")?.metadata).toBeNull();

    const failure = new Error("audit down");
    audit.queueRecordError(failure);
    await expect(audit.record({ actor: "admin", action: "admin.logout", resource: "session" })).rejects.toBe(failure);
  });

  test("outbox repository honors pending-only races and job discards", async () => {
    const clock = new FakeClock("2026-01-01T00:00:00.000Z");
    const jobs = new Map([["job-1", reviewJob()]]);
    const outbox = new FakeOutboxRepository({ clock, jobs });
    const first = await outbox.create({
      reviewJobId: "job-1",
      type: "review.requested",
      payload: queuePayload(),
    });
    const second = await outbox.create({
      reviewJobId: "job-1",
      type: "review.requested",
      payload: queuePayload(),
    });

    await expect(outbox.findLatestForJob("job-1")).resolves.toMatchObject({ id: second.id });
    await expect(outbox.findPendingIds(10)).resolves.toEqual([first.id, second.id]);
    await expect(outbox.findByIdWithJob(first.id)).resolves.toMatchObject({ reviewJob: { id: "job-1" } });

    await expect(outbox.discardIfPending(first.id, "stop")).resolves.toBe(true);
    await expect(outbox.discardIfPending(first.id, "stop")).resolves.toBe(false);
    await expect(outbox.discardIfPending("missing", "stop")).resolves.toBe(false);
    await expect(outbox.incrementAttemptsIfPending("missing", "ignored")).resolves.toBeUndefined();
    await outbox.incrementAttemptsIfPending(second.id, "retry");
    const retried = await outbox.findLatestForJob("job-1");
    expect(retried).toMatchObject({ id: second.id, status: "pending", attempts: 1, lastError: "retry" });

    await outbox.markPublished(second.id, clock.now());
    await expect(outbox.findPendingIds(10)).resolves.toEqual([]);
    await outbox.incrementAttemptsIfPending(second.id, "ignored");
    await expect(outbox.findLatestForJob("job-1")).resolves.toMatchObject({
      attempts: 1,
      status: "published",
      lastError: null,
    });

    await outbox.discardPendingForJob("job-1", "superseded");
    await expect(outbox.markPublished("missing", clock.now())).rejects.toThrow("unknown outbox event");
  });
});
