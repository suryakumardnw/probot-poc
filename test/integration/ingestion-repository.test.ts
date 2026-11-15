import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { outboxPayloadSchema } from "../../src/contracts/queue.js";
import type { CreateReviewInput, ReviewJobRecord, ReviewRecord } from "../../src/ingestion/ingestion.repository.js";
import { createIngestionRepositories } from "../../src/ingestion/prisma-ingestion.repository.js";
import { cleanDatabase } from "../characterization/support.js";
import { prisma, disconnectDatabase } from "../helpers/db.js";

/**
 * Integration: ingestion repositories against real PostgreSQL.
 *
 * Every mapper is exercised through the repository port — the tests never
 * reach into Prisma for the behavior under assertion, except to clean up
 * fixtures.
 */

process.env.DATABASE_URL ??= "postgres://postgres:postgres@localhost:5432/reviewer";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.MODEL_BASE_URL ??= "http://localhost:8000";

const repositories = createIngestionRepositories(prisma);

const INSTALLATION_ID = 9_300_001n;
const REPOSITORY_ID = 8_300_001n;

async function seedRepository(): Promise<{ installationId: string; repositoryId: string }> {
  const installation = await repositories.installations.upsertActive({
    githubInstallationId: INSTALLATION_ID,
    organization: "repository-org",
  });
  const repository = await repositories.repositories.upsertActive({
    githubRepositoryId: REPOSITORY_ID,
    installationId: installation.id,
    fullName: "repository-org/widget",
    defaultBranch: "main",
  });
  return { installationId: installation.id, repositoryId: repository.id };
}

async function seedPullRequest(repositoryId: string): Promise<string> {
  const pullRequest = await repositories.pullRequests.upsertOpen({
    repositoryId,
    githubPrNumber: 42,
    headSha: "aaaa9300aaaa9300aaaa9300aaaa9300aaaa9300",
    baseSha: "bbbb9300bbbb9300bbbb9300bbbb9300bbbb9300",
    draft: false,
  });
  return pullRequest.id;
}

function reviewInput(pullRequestId: string, overrides: Partial<CreateReviewInput> = {}): CreateReviewInput {
  return {
    pullRequestId,
    githubInstallationId: INSTALLATION_ID,
    githubRepositoryId: REPOSITORY_ID,
    pullRequestNumber: 42,
    headSha: "aaaa9300aaaa9300aaaa9300aaaa9300aaaa9300",
    baseSha: "bbbb9300bbbb9300bbbb9300bbbb9300bbbb9300",
    state: "queued",
    trigger: "opened",
    reviewMode: "adaptive",
    reviewType: "standard",
    attempt: 0,
    configurationHash: "sha256:test",
    schemaVersion: 1,
    ...overrides,
  };
}

async function seedReview(pullRequestId: string, overrides: Partial<CreateReviewInput> = {}): Promise<ReviewRecord> {
  return repositories.reviews.create(reviewInput(pullRequestId, overrides));
}

async function seedJob(review: ReviewRecord, jobKey = `job-${review.id}`): Promise<ReviewJobRecord> {
  return repositories.reviewJobs.create({ reviewId: review.id, status: "pending_outbox", jobKey });
}

function payloadFor(review: ReviewRecord, job: ReviewJobRecord) {
  return outboxPayloadSchema.parse({
    reviewId: review.id,
    jobKey: job.jobKey,
    githubInstallationId: review.githubInstallationId.toString(),
    githubRepositoryId: review.githubRepositoryId.toString(),
    repositoryFullName: "repository-org/widget",
    pullRequestNumber: review.pullRequestNumber,
    headSha: review.headSha,
    baseSha: review.baseSha,
    reviewMode: review.reviewMode,
    reviewType: review.reviewType,
    trigger: review.trigger,
    configurationHash: review.configurationHash,
  });
}

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectDatabase();
});

describe("installation, repository, and pull request repositories", () => {
  test("upserts map domain records and preserve stored values on partial updates", async () => {
    const { installationId, repositoryId } = await seedRepository();

    const installation = await repositories.installations.upsertActive({
      githubInstallationId: INSTALLATION_ID,
      organization: "renamed-org",
    });
    expect(installation.id).toBe(installationId);
    expect(installation.organization).toBe("renamed-org");
    expect(installation.status).toBe("active");

    const updatedRepository = await repositories.repositories.upsertActive({
      githubRepositoryId: REPOSITORY_ID,
      installationId,
      fullName: "renamed-org/widget",
      defaultBranch: null,
    });
    expect(updatedRepository.id).toBe(repositoryId);
    expect(updatedRepository.fullName).toBe("renamed-org/widget");
    // A null default branch never clobbers the stored branch.
    expect(updatedRepository.defaultBranch).toBe("main");

    const withBranch = await repositories.repositories.upsertActive({
      githubRepositoryId: REPOSITORY_ID,
      installationId,
      fullName: "renamed-org/widget",
      defaultBranch: "develop",
    });
    expect(withBranch.defaultBranch).toBe("develop");

    const pullRequestId = await seedPullRequest(repositoryId);
    const updatedPullRequest = await repositories.pullRequests.upsertOpen({
      repositoryId,
      githubPrNumber: 42,
      headSha: "cccc9300cccc9300cccc9300cccc9300cccc9300",
      baseSha: null,
      draft: true,
    });
    expect(updatedPullRequest.id).toBe(pullRequestId);
    expect(updatedPullRequest.headSha).toBe("cccc9300cccc9300cccc9300cccc9300cccc9300");
    // A null base SHA never clobbers the stored base SHA.
    expect(updatedPullRequest.baseSha).toBe("bbbb9300bbbb9300bbbb9300bbbb9300bbbb9300");
    expect(updatedPullRequest.draft).toBe(true);

    const found = await repositories.pullRequests.findByRepositoryAndNumber(repositoryId, 42);
    expect(found?.id).toBe(pullRequestId);
    expect(await repositories.pullRequests.findByRepositoryAndNumber(repositoryId, 999)).toBeNull();

    const withInstallation = await repositories.repositories.findActiveByFullName("renamed-org/widget");
    expect(withInstallation?.repository.id).toBe(repositoryId);
    expect(withInstallation?.installation.id).toBe(installationId);
    expect(await repositories.repositories.findActiveByFullName("missing/repo")).toBeNull();

    const names = await repositories.repositories.findFullNamesByGithubIds([REPOSITORY_ID]);
    expect(names).toEqual([{ githubRepositoryId: REPOSITORY_ID, fullName: "renamed-org/widget" }]);
  });
});

describe("review repository", () => {
  test("creates reviews, resolves identity, and scopes in-flight supersession by type", async () => {
    const { repositoryId } = await seedRepository();
    const pullRequestId = await seedPullRequest(repositoryId);

    const review = await seedReview(pullRequestId);
    expect(review.state).toBe("queued");
    expect(review.reviewType).toBe("standard");
    expect(review.attempt).toBe(0);
    expect(await repositories.reviews.maxAttempt(reviewIdentity(pullRequestId))).toBe(0);

    const job = await seedJob(review);
    const identity = await repositories.reviews.findByIdentity({ ...reviewIdentity(pullRequestId), attempt: 0 });
    expect(identity?.review.id).toBe(review.id);
    expect(identity?.job?.id).toBe(job.id);
    expect(await repositories.reviews.findByIdentity({ ...reviewIdentity(pullRequestId), attempt: 7 })).toBeNull();

    await seedReview(pullRequestId, { state: "completed", headSha: "dddd9300dddd9300dddd9300dddd9300dddd9300" });
    await seedReview(pullRequestId, {
      reviewType: "skill",
      headSha: "eeee9300eeee9300eeee9300eeee9300eeee9300",
    });
    const secondInFlight = await seedReview(pullRequestId, {
      headSha: "ffff9300ffff9300ffff9300ffff9300ffff9300",
    });

    const inFlight = await repositories.reviews.findInFlight({
      pullRequestId,
      reviewType: "standard",
      notInStates: ["completed", "completed_with_warnings", "failed", "cancelled", "superseded"],
    });
    expect(inFlight.map((entry) => entry.review.id).sort()).toEqual([review.id, secondInFlight.id].sort());
    expect(await repositories.reviews.maxAttempt(reviewIdentity(pullRequestId))).toBe(0);

    await seedReview(pullRequestId, { attempt: 1 });
    expect(await repositories.reviews.maxAttempt(reviewIdentity(pullRequestId))).toBe(1);

    const superseded = await repositories.reviews.updateState(secondInFlight.id, {
      state: "superseded",
      supersededByReviewId: review.id,
      supersededAt: new Date("2026-01-02T03:04:05.000Z"),
    });
    expect(superseded.state).toBe("superseded");
    expect(superseded.supersededByReviewId).toBe(review.id);
    expect(superseded.supersededAt?.toISOString()).toBe("2026-01-02T03:04:05.000Z");

    await repositories.stateTransitions.create({
      reviewId: review.id,
      fromState: null,
      toState: "queued",
    });
    const status = await repositories.reviews.findStatusById(review.id);
    expect(status?.review.id).toBe(review.id);
    expect(status?.job?.id).toBe(job.id);
    expect(status?.transitions.map((transition) => `${transition.fromState}->${transition.toState}`)).toEqual([
      "null->queued",
    ]);
    expect(await repositories.reviews.findStatusById("missing-review")).toBeNull();

    expect(await repositories.reviews.findStateById(review.id)).toBe("queued");
    expect(await repositories.reviews.findStateById("missing-review")).toBeNull();
    expect((await repositories.reviews.findById(review.id))?.id).toBe(review.id);
    expect(await repositories.reviews.findById("missing-review")).toBeNull();
  });

  test("resets and fails reviews for recovery while exposing the state needed on each path", async () => {
    const { repositoryId } = await seedRepository();
    const pullRequestId = await seedPullRequest(repositoryId);

    const review = await seedReview(pullRequestId, { state: "publishing" });
    await repositories.reviews.resetForRecovery(review.id);
    const reset = await repositories.reviews.findById(review.id);
    expect(reset?.state).toBe("queued");
    expect(reset?.errorCode).toBeNull();
    expect(reset?.errorMessage).toBeNull();

    await repositories.reviews.markFailed(review.id, "recovery_exhausted", "attempts exhausted");
    const failed = await repositories.reviews.findById(review.id);
    expect(failed?.state).toBe("failed");
    expect(failed?.errorCode).toBe("recovery_exhausted");
    expect(failed?.errorMessage).toBe("attempts exhausted");
  });

  test("updates complete transitions and terminal timestamps", async () => {
    const { repositoryId } = await seedRepository();
    const pullRequestId = await seedPullRequest(repositoryId);
    const review = await seedReview(pullRequestId);

    const completedAt = new Date("2026-02-03T04:05:06.000Z");
    const completed = await repositories.reviews.updateState(review.id, { state: "completed", completedAt });
    expect(completed.state).toBe("completed");
    expect(completed.completedAt?.toISOString()).toBe(completedAt.toISOString());

    const failed = await repositories.reviews.updateState(review.id, {
      state: "failed",
      errorCode: "REVIEW_FAILED",
      errorMessage: "boom",
    });
    expect(failed.errorCode).toBe("REVIEW_FAILED");
    expect(failed.errorMessage).toBe("boom");
  });
});

describe("review job repository", () => {
  test("creates, updates, restores, and fails durable jobs", async () => {
    const { repositoryId } = await seedRepository();
    const pullRequestId = await seedPullRequest(repositoryId);
    const review = await seedReview(pullRequestId);
    const job = await seedJob(review, "job-update");

    await repositories.reviewJobs.update(job.id, { status: "enqueued", lastError: "first attempt" });
    const enqueued = await repositories.reviews.findStatusById(review.id);
    expect(enqueued?.job?.status).toBe("enqueued");
    expect(enqueued?.job?.lastError).toBe("first attempt");

    await repositories.reviewJobs.restorePendingOutbox(job.id);
    const restored = await repositories.reviews.findStatusById(review.id);
    expect(restored?.job?.status).toBe("pending_outbox");

    await repositories.reviewJobs.update(job.id, { status: "enqueued", queueJobId: "queue-job-1" });
    await repositories.reviewJobs.restorePendingOutbox(job.id);
    const owned = await repositories.reviews.findStatusById(review.id);
    expect(owned?.job?.status).toBe("enqueued");
    expect(owned?.job?.queueJobId).toBe("queue-job-1");

    await repositories.reviewJobs.markFailed(job.id, "clone failed");
    const failed = await repositories.reviews.findStatusById(review.id);
    expect(failed?.job?.status).toBe("failed");
    expect(failed?.job?.lastError).toBe("clone failed");
  });

  test("finds incomplete jobs for non-terminal reviews only", async () => {
    const { repositoryId } = await seedRepository();
    const pullRequestId = await seedPullRequest(repositoryId);

    const inFlightReview = await seedReview(pullRequestId);
    const inFlightJob = await seedJob(inFlightReview, "job-in-flight");
    const queuedReview = await seedReview(pullRequestId, {
      headSha: "2222930022229300222293002222930022229300",
    });
    const queuedJob = await seedJob(queuedReview, "job-queued");
    const terminalReview = await seedReview(pullRequestId, {
      state: "completed",
      headSha: "3333930033339300333393003333930033339300",
    });
    await seedJob(terminalReview, "job-terminal");

    const jobs = await repositories.reviewJobs.findIncompleteWithReviews({
      statuses: ["pending_outbox", "enqueued", "processing"],
      notInReviewStates: ["completed", "completed_with_warnings", "failed", "cancelled", "superseded"],
      limit: 100,
    });
    expect(jobs.map(({ job }) => job.id).sort()).toEqual([inFlightJob.id, queuedJob.id].sort());
    expect(jobs.some(({ review }) => review.id === terminalReview.id)).toBe(false);
  });
});

describe("state transition and webhook delivery repositories", () => {
  test("persists transitions and deduplicates webhook deliveries", async () => {
    const { repositoryId } = await seedRepository();
    const pullRequestId = await seedPullRequest(repositoryId);
    const review = await seedReview(pullRequestId);

    const transition = await repositories.stateTransitions.create({
      reviewId: review.id,
      fromState: "queued",
      toState: "preparing",
    });
    expect(transition.reviewId).toBe(review.id);
    expect(transition.fromState).toBe("queued");
    expect(transition.toState).toBe("preparing");

    await repositories.webhookDeliveries.create({
      deliveryId: "delivery-1",
      event: "pull_request.opened",
      reviewJobId: null,
    });
    const delivery = await repositories.webhookDeliveries.findByDeliveryId("delivery-1");
    expect(delivery?.event).toBe("pull_request.opened");
    expect(await repositories.webhookDeliveries.findByDeliveryId("missing-delivery")).toBeNull();

    await expect(
      repositories.webhookDeliveries.create({
        deliveryId: "delivery-1",
        event: "pull_request.opened",
        reviewJobId: null,
      }),
    ).rejects.toThrow();
  });
});

describe("outbox repository", () => {
  test("tracks pending, published, discarded, and retry state", async () => {
    const { repositoryId } = await seedRepository();
    const pullRequestId = await seedPullRequest(repositoryId);
    const review = await seedReview(pullRequestId);
    const job = await seedJob(review);

    const event = await repositories.outboxEvents.create({
      reviewJobId: job.id,
      type: "review.requested",
      payload: payloadFor(review, job),
    });
    expect(event.status).toBe("pending");
    expect(event.attempts).toBe(0);

    const withJob = await repositories.outboxEvents.findByIdWithJob(event.id);
    expect(withJob?.reviewJob.id).toBe(job.id);
    expect(withJob?.payload).toMatchObject({ reviewId: review.id, jobKey: job.jobKey });
    expect(await repositories.outboxEvents.findByIdWithJob("missing-event")).toBeNull();

    expect(await repositories.outboxEvents.findLatestForJob(job.id)).toMatchObject({ id: event.id });
    expect(await repositories.outboxEvents.findPendingIds(10)).toEqual([event.id]);

    await repositories.outboxEvents.incrementAttemptsIfPending(event.id, "redis unavailable");
    const retried = await repositories.outboxEvents.findByIdWithJob(event.id);
    expect(retried?.attempts).toBe(1);
    expect(retried?.lastError).toBe("redis unavailable");

    expect(await repositories.outboxEvents.discardIfPending(event.id, "invalid payload")).toBe(true);
    expect(await repositories.outboxEvents.discardIfPending(event.id, "invalid payload")).toBe(false);
    const discarded = await repositories.outboxEvents.findByIdWithJob(event.id);
    expect(discarded?.status).toBe("discarded");
    expect(discarded?.lastError).toBe("invalid payload");

    const published = await repositories.outboxEvents.create({
      reviewJobId: job.id,
      type: "review.requested",
      payload: payloadFor(review, job),
    });
    const publishedAt = new Date("2026-03-04T05:06:07.000Z");
    await repositories.outboxEvents.markPublished(published.id, publishedAt);
    const publishedRow = await repositories.outboxEvents.findByIdWithJob(published.id);
    expect(publishedRow?.status).toBe("published");
    expect(publishedRow?.publishedAt?.toISOString()).toBe(publishedAt.toISOString());
    expect(publishedRow?.lastError).toBeNull();

    const pendingForJob = await repositories.outboxEvents.create({
      reviewJobId: job.id,
      type: "review.requested",
      payload: payloadFor(review, job),
    });
    await repositories.outboxEvents.discardPendingForJob(job.id, "review job superseded");
    expect((await repositories.outboxEvents.findByIdWithJob(pendingForJob.id))?.status).toBe("discarded");
    // The already-published event is not touched by the pending-only discard.
    expect((await repositories.outboxEvents.findByIdWithJob(published.id))?.status).toBe("published");
    expect(await repositories.outboxEvents.findPendingIds(10)).toEqual([]);
  });
});

function reviewIdentity(pullRequestId: string) {
  return {
    pullRequestId,
    headSha: "aaaa9300aaaa9300aaaa9300aaaa9300aaaa9300",
    reviewMode: "adaptive",
    reviewType: "standard" as const,
  };
}
