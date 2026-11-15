import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { createIngestionService, type IngestReviewRequestInput } from "../../src/modules/ingestion/index.js";
import type { IngestionRepositories, IngestionUnitOfWork } from "../../src/modules/ingestion/ingestion.unit-of-work.js";
import { createReviewConfigStore } from "../../src/platform/config/review-config-store.js";
import { cleanDatabase } from "../characterization/support.js";
import { disconnectDatabase, prisma } from "../helpers/db.js";
import { createTestIngestion, silentLogger } from "../helpers/ingestion.js";

/**
 * Integration: ingestion unit of work against real PostgreSQL.
 *
 * The unit of work is the module's only multi-write transaction boundary. The
 * tests pin the two outcomes the services rely on: every write commits, or
 * every write rolls back and no partial intake survives.
 */

process.env.DATABASE_URL ??= "postgres://postgres:postgres@localhost:5432/reviewer";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.MODEL_BASE_URL ??= "http://localhost:8000";

const ingestion = createTestIngestion();
const { repositories, unitOfWork } = ingestion;

function intakeInput(overrides: Partial<IngestReviewRequestInput> = {}): IngestReviewRequestInput {
  return {
    trigger: "opened",
    installationId: 9_300_101,
    repositoryId: 8_300_101,
    repositoryName: "uow-org/uow-widget",
    owner: "uow-org",
    defaultBranch: "main",
    pullRequestNumber: 17,
    headSha: "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
    baseSha: "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2",
    draft: false,
    ...overrides,
  };
}

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await ingestion.close();
  await cleanDatabase();
  await disconnectDatabase();
});

describe("IngestionUnitOfWork", () => {
  test("commits every repository write when the callback succeeds", async () => {
    const written = await unitOfWork.execute(async (repos) => {
      const installation = await repos.installations.upsertActive({
        githubInstallationId: 9_300_201n,
        organization: "uow-org",
      });
      const repository = await repos.repositories.upsertActive({
        githubRepositoryId: 8_300_201n,
        installationId: installation.id,
        fullName: "uow-org/committed",
        defaultBranch: "main",
      });
      const pullRequest = await repos.pullRequests.upsertOpen({
        repositoryId: repository.id,
        githubPrNumber: 1,
        headSha: "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3",
        baseSha: "d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4",
        draft: false,
      });
      return { installation, repository, pullRequest };
    });

    const installation = await prisma.installation.findUnique({
      where: { githubInstallationId: written.installation.githubInstallationId },
    });
    expect(installation?.organization).toBe("uow-org");
    const repository = await repositories.repositories.findActiveByFullName("uow-org/committed");
    expect(repository?.repository.id).toBe(written.repository.id);
    const pullRequest = await repositories.pullRequests.findByRepositoryAndNumber(written.repository.id, 1);
    expect(pullRequest?.id).toBe(written.pullRequest.id);
  });

  test("rolls back every repository write when the callback throws", async () => {
    const existing = await repositories.installations.upsertActive({
      githubInstallationId: 9_300_202n,
      organization: "outside-org",
    });

    await expect(
      unitOfWork.execute(async (repos) => {
        await repos.installations.upsertActive({
          githubInstallationId: 9_300_202n,
          organization: "changed-inside-rollback",
        });
        await repos.installations.upsertActive({
          githubInstallationId: 9_300_203n,
          organization: "new-inside-rollback",
        });
        throw new Error("forced rollback");
      }),
    ).rejects.toThrow("forced rollback");

    // Nothing created inside the transaction survives.
    expect(await prisma.installation.findUnique({ where: { githubInstallationId: 9_300_203n } })).toBeNull();
    // A row touched inside the transaction keeps its pre-transaction value.
    expect(await prisma.installation.findUnique({ where: { githubInstallationId: 9_300_202n } })).toMatchObject({
      id: existing.id,
      organization: "outside-org",
    });
  });

  test("rolls back the multi-write review intake when any write fails", async () => {
    const failingUnitOfWork: IngestionUnitOfWork = {
      execute<T>(work: (repos: IngestionRepositories) => Promise<T>): Promise<T> {
        return unitOfWork.execute((repos) =>
          work({
            ...repos,
            outboxEvents: {
              ...repos.outboxEvents,
              create: async () => {
                throw new Error("forced outbox failure");
              },
            },
          }),
        );
      },
    };
    const service = createIngestionService({
      repositories,
      unitOfWork: failingUnitOfWork,
      config: createReviewConfigStore(),
      logger: silentLogger,
      publish: async () => "published",
    });

    await expect(service.ingestReviewRequest(intakeInput())).rejects.toThrow("forced outbox failure");

    // No partial intake: installation, repository, pull request, review, job,
    // transition, and outbox event were all inside the rolled-back transaction.
    expect(await prisma.installation.findUnique({ where: { githubInstallationId: 9_300_101n } })).toBeNull();
    expect(await prisma.repository.findUnique({ where: { githubRepositoryId: 8_300_101n } })).toBeNull();
    expect(await prisma.pullRequest.count()).toBe(0);
    expect(await prisma.review.count()).toBe(0);
    expect(await prisma.reviewJob.count()).toBe(0);
    expect(await prisma.reviewStateTransition.count()).toBe(0);
    expect(await prisma.outboxEvent.count()).toBe(0);
    expect(await prisma.webhookDelivery.count()).toBe(0);
  });
});

describe("createIngestionServices", () => {
  test("wires the service bundle and commits one complete durable intake", async () => {
    const services = ingestion.services;
    const input = intakeInput({ deliveryId: "uow-delivery-1" });

    const result = await services.ingestReviewRequest(input);
    expect(result.outcome).toBe("created");
    expect(result.reviewId).toBeDefined();
    expect(result.jobId).toBeDefined();
    expect(result.attempt).toBe(0);
    const reviewId = result.reviewId;
    if (!reviewId) {
      throw new Error("ingestion did not create a review");
    }

    const review = await prisma.review.findUniqueOrThrow({ where: { id: reviewId } });
    expect(review.state).toBe("queued");
    expect(review.trigger).toBe("opened");
    expect(review.configurationHash).toMatch(/^sha256:/);

    const job = await prisma.reviewJob.findUniqueOrThrow({ where: { reviewId: review.id } });
    expect(job.status).toBe("enqueued");
    expect(job.jobKey).toBe("9300101:8300101:17:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1:adaptive:standard");

    const transition = await prisma.reviewStateTransition.findMany({ where: { reviewId: review.id } });
    expect(transition.map((entry) => `${entry.fromState}->${entry.toState}`)).toEqual(["null->queued"]);

    const event = await prisma.outboxEvent.findFirstOrThrow({ where: { reviewJobId: job.id } });
    expect(event.status).toBe("published");
    expect(event.payload).toMatchObject({
      reviewId: review.id,
      jobKey: job.jobKey,
      repositoryFullName: "uow-org/uow-widget",
      reviewType: "standard",
    });

    const delivery = await prisma.webhookDelivery.findUniqueOrThrow({ where: { deliveryId: "uow-delivery-1" } });
    expect(delivery.reviewJobId).toBe(job.id);

    const status = await services.getReviewStatus(review.id);
    expect(status?.review.state).toBe("queued");
    expect(status?.job?.jobKey).toBe(job.jobKey);
    expect(status?.transitions).toHaveLength(1);

    // A repeated delivery short-circuits before any transaction.
    const duplicate = await services.ingestReviewRequest(input);
    expect(duplicate.outcome).toBe("duplicate_delivery");
    expect(await prisma.review.count()).toBe(1);
  });

  test("exposes the review state machine through the same service bundle", async () => {
    const services = ingestion.services;
    const result = await services.ingestReviewRequest(intakeInput({ deliveryId: "uow-delivery-2" }));
    if (!result.reviewId) {
      throw new Error("ingestion did not create a review");
    }

    const moved = await services.transitionReviewState(result.reviewId, "preparing");
    expect(moved).toEqual({ id: result.reviewId, state: "preparing" });

    const transitions = await prisma.reviewStateTransition.findMany({
      where: { reviewId: result.reviewId },
      orderBy: { createdAt: "asc" },
    });
    expect(transitions.map((entry) => entry.toState).sort()).toEqual(["preparing", "queued"]);
  });
});
