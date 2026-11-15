import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { createReviewConfigStore } from "../../src/config/review-config-store.js";
import { createIngestionService, type IngestReviewRequestInput } from "../../src/ingestion/index.js";
import type { ReviewWithJob } from "../../src/ingestion/ingestion.repository.js";
import type { IngestionRepositories, IngestionUnitOfWork } from "../../src/ingestion/ingestion.unit-of-work.js";
import { createIngestionRepositories } from "../../src/ingestion/prisma-ingestion.repository.js";
import { createIngestionUnitOfWork } from "../../src/ingestion/prisma-ingestion.unit-of-work.js";
import { cleanDatabase, seedReviewChain } from "../characterization/support.js";
import { disconnectDatabase, prisma } from "../helpers/db.js";
import { silentLogger } from "../helpers/ingestion.js";

/**
 * Integration: ingest-time supersession against real PostgreSQL.
 *
 * A webhook transaction first snapshots the PR's in-flight reviews and later
 * races the worker to retire them. Superseding must go through the guarded
 * transition port: a completed review is never overwritten, and concurrent
 * supersede attempts produce exactly one `-> superseded` history row.
 */

process.env.DATABASE_URL ??= "postgres://postgres:postgres@localhost:5432/reviewer";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.MODEL_BASE_URL ??= "http://localhost:8000";

const repositories = createIngestionRepositories(prisma);
const unitOfWork = createIngestionUnitOfWork(prisma);
const config = createReviewConfigStore();

function createService(work: IngestionUnitOfWork = unitOfWork) {
  return createIngestionService({
    repositories,
    unitOfWork: work,
    config,
    logger: silentLogger,
    publish: async () => "published",
  });
}

type Seed = Awaited<ReturnType<typeof seedReviewChain>>;

async function ingestInput(
  seed: Seed,
  overrides: Partial<IngestReviewRequestInput> = {},
): Promise<IngestReviewRequestInput> {
  const pullRequest = await prisma.pullRequest.findUniqueOrThrow({
    where: { id: seed.pullRequestId },
    select: { githubPrNumber: true },
  });
  return {
    trigger: "synchronized",
    installationId: seed.githubInstallationId.toString(),
    repositoryId: seed.githubRepositoryId.toString(),
    repositoryName: seed.repositoryFullName,
    owner: "supersede-org",
    defaultBranch: "main",
    pullRequestNumber: pullRequest.githubPrNumber,
    baseSha: "base-supersede",
    draft: false,
    ...overrides,
  };
}

/** Simulate an in-flight snapshot taken before a worker changed the review. */
function snapshotUnitOfWork(snapshot: ReviewWithJob): IngestionUnitOfWork {
  return {
    execute<T>(work: (repos: IngestionRepositories) => Promise<T>): Promise<T> {
      return unitOfWork.execute((repos) =>
        work({
          ...repos,
          reviews: {
            ...repos.reviews,
            findInFlight: async () => [snapshot],
          },
        }),
      );
    },
  };
}

async function staleSnapshot(seed: Seed): Promise<ReviewWithJob> {
  const snapshot = await repositories.reviews.findByIdentity({
    pullRequestId: seed.pullRequestId,
    headSha: seed.headSha,
    reviewMode: "adaptive",
    reviewType: "standard",
    attempt: 0,
  });
  if (!snapshot) {
    throw new Error("fixture review was not found");
  }
  return snapshot;
}

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectDatabase();
});

describe("ingest-time supersession", () => {
  test("a normal in-flight review is superseded once with its job and outbox retired", async () => {
    const seed = await seedReviewChain({
      prefix: "supersede-normal",
      state: "analyzing",
      job: { status: "processing" },
      outbox: { status: "pending" },
    });
    if (!seed.jobId || !seed.outboxEventId) {
      throw new Error("fixture did not seed a job and outbox event");
    }

    const result = await createService().ingestReviewRequest(
      await ingestInput(seed, {
        headSha: "1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa",
        deliveryId: "supersede-normal",
      }),
    );
    expect(result.outcome).toBe("created");
    if (!result.reviewId) {
      throw new Error("ingestion did not create a review");
    }

    const outdated = await prisma.review.findUniqueOrThrow({ where: { id: seed.reviewId } });
    expect(outdated.state).toBe("superseded");
    expect(outdated.supersededByReviewId).toBe(result.reviewId);

    const transitions = await prisma.reviewStateTransition.findMany({ where: { reviewId: seed.reviewId } });
    expect(transitions.map((row) => `${row.fromState}->${row.toState}`)).toEqual(["analyzing->superseded"]);

    const job = await prisma.reviewJob.findUniqueOrThrow({ where: { id: seed.jobId } });
    expect(job.status).toBe("superseded");
    expect(job.lastError).toContain(result.reviewId);

    const event = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: seed.outboxEventId } });
    expect(event.status).toBe("discarded");
  });

  test("a completed review is not overwritten by a stale supersede", async () => {
    const seed = await seedReviewChain({
      prefix: "supersede-completed",
      state: "completed",
      job: { status: "completed" },
    });
    if (!seed.jobId) {
      throw new Error("fixture did not seed a job");
    }
    const snapshot = await staleSnapshot(seed);

    const result = await createService(snapshotUnitOfWork(snapshot)).ingestReviewRequest(
      await ingestInput(seed, {
        headSha: "2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb",
        deliveryId: "supersede-completed",
      }),
    );
    expect(result.outcome).toBe("created");

    const review = await prisma.review.findUniqueOrThrow({ where: { id: seed.reviewId } });
    expect(review.state).toBe("completed");
    expect(review.supersededByReviewId).toBeNull();
    expect(
      await prisma.reviewStateTransition.count({ where: { reviewId: seed.reviewId, toState: "superseded" } }),
    ).toBe(0);

    const job = await prisma.reviewJob.findUniqueOrThrow({ where: { id: seed.jobId } });
    expect(job.status).toBe("completed");
  });

  test("retries a non-terminal conflict and still supersedes the stale review", async () => {
    const seed = await seedReviewChain({
      prefix: "supersede-retry",
      state: "analyzing",
      job: { status: "processing" },
    });
    if (!seed.jobId) {
      throw new Error("fixture did not seed a job");
    }
    const snapshot = await staleSnapshot(seed);
    let attempts = 0;

    const racingUnitOfWork: IngestionUnitOfWork = {
      execute<T>(work: (repos: IngestionRepositories) => Promise<T>): Promise<T> {
        return unitOfWork.execute((repos) =>
          work({
            ...repos,
            reviews: {
              ...repos.reviews,
              findInFlight: async () => [snapshot],
              transitionState: async (input) => {
                attempts += 1;
                if (attempts === 1) {
                  // The worker advanced the review after the in-flight snapshot
                  // but before supersede's guarded write.
                  const advanced = await repos.reviews.transitionState({
                    reviewId: input.reviewId,
                    toState: "investigating",
                    allowedFromStates: ["analyzing"],
                    patch: {},
                  });
                  if (advanced.outcome !== "transitioned") {
                    throw new Error("expected the simulated worker advance to succeed");
                  }
                  return { outcome: "conflict", currentState: "investigating" };
                }
                return repos.reviews.transitionState(input);
              },
            },
          }),
        );
      },
    };

    const result = await createService(racingUnitOfWork).ingestReviewRequest(
      await ingestInput(seed, {
        headSha: "5555eeee5555eeee5555eeee5555eeee5555eeee",
        deliveryId: "supersede-retry",
      }),
    );
    expect(result.outcome).toBe("created");
    expect(attempts).toBe(2);

    const review = await prisma.review.findUniqueOrThrow({ where: { id: seed.reviewId } });
    expect(review.state).toBe("superseded");
    expect(review.supersededByReviewId).toBe(result.reviewId);

    const transitions = await prisma.reviewStateTransition.findMany({ where: { reviewId: seed.reviewId } });
    expect(transitions.filter((row) => row.toState === "superseded")).toHaveLength(1);
    expect(transitions.map((row) => `${row.fromState}->${row.toState}`).sort()).toEqual([
      "analyzing->investigating",
      "investigating->superseded",
    ]);

    const job = await prisma.reviewJob.findUniqueOrThrow({ where: { id: seed.jobId } });
    expect(job.status).toBe("superseded");
  });

  test("concurrent supersedes of one in-flight review write exactly one transition row", async () => {
    const seed = await seedReviewChain({
      prefix: "supersede-race",
      state: "analyzing",
      job: { status: "processing" },
      outbox: { status: "pending" },
    });
    if (!seed.jobId || !seed.outboxEventId) {
      throw new Error("fixture did not seed a job and outbox event");
    }
    const snapshot = await staleSnapshot(seed);
    const service = createService(snapshotUnitOfWork(snapshot));

    const [firstInput, secondInput] = await Promise.all([
      ingestInput(seed, {
        headSha: "3333cccc3333cccc3333cccc3333cccc3333cccc",
        deliveryId: "supersede-race-1",
      }),
      ingestInput(seed, {
        headSha: "4444dddd4444dddd4444dddd4444dddd4444dddd",
        deliveryId: "supersede-race-2",
      }),
    ]);
    const results = await Promise.all([
      service.ingestReviewRequest(firstInput),
      service.ingestReviewRequest(secondInput),
    ]);

    expect(results.map((result) => result.outcome)).toEqual(["created", "created"]);
    const replacementIds = results.flatMap((result) => (result.reviewId ? [result.reviewId] : []));
    expect(replacementIds).toHaveLength(2);

    const outdated = await prisma.review.findUniqueOrThrow({ where: { id: seed.reviewId } });
    expect(outdated.state).toBe("superseded");
    expect(replacementIds).toContain(outdated.supersededByReviewId);

    const transitions = await prisma.reviewStateTransition.findMany({ where: { reviewId: seed.reviewId } });
    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.fromState).toBe("analyzing");
    expect(transitions[0]?.toState).toBe("superseded");

    const job = await prisma.reviewJob.findUniqueOrThrow({ where: { id: seed.jobId } });
    expect(job.status).toBe("superseded");

    const event = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: seed.outboxEventId } });
    expect(event.status).toBe("discarded");
  });
});
