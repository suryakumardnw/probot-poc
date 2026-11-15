import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { REVIEW_STATES, TERMINAL_REVIEW_STATES, createReviewStateService } from "../../src/ingestion/index.js";
import { createIngestionRepositories } from "../../src/ingestion/prisma-ingestion.repository.js";
import { createIngestionUnitOfWork } from "../../src/ingestion/prisma-ingestion.unit-of-work.js";
import { systemClock } from "../../src/ports/clock.js";
import { AppError, InvalidStateTransitionError } from "../../src/shared/errors/index.js";
import { cleanDatabase, seedReviewChain } from "../characterization/support.js";
import { disconnectDatabase, prisma } from "../helpers/db.js";

/**
 * Integration: atomic review state transitions against real PostgreSQL.
 *
 * The repository owns the read, the guarded review update, and the audit row.
 * These tests pin the concurrency contract the rest of the pipeline relies on:
 * one successful move per observed state and exactly one history row.
 */

process.env.DATABASE_URL ??= "postgres://postgres:postgres@localhost:5432/reviewer";

const repositories = createIngestionRepositories(prisma);
const service = createReviewStateService({ repositories, clock: systemClock });

async function persistedState(reviewId: string) {
  const review = await prisma.review.findUniqueOrThrow({ where: { id: reviewId }, select: { state: true } });
  return review.state;
}

async function transitionRows(reviewId: string) {
  return prisma.reviewStateTransition.findMany({ where: { reviewId } });
}

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectDatabase();
});

describe("atomic review state transitions", () => {
  test("a same-state transition is a no-op with no audit row, including from a terminal state", async () => {
    const analyzing = await seedReviewChain({ prefix: "same-state", state: "analyzing" });

    await expect(service.transitionReviewState(analyzing.reviewId, "analyzing")).resolves.toEqual({
      id: analyzing.reviewId,
      state: "analyzing",
    });
    await expect(service.transitionReviewState(analyzing.reviewId, "analyzing")).resolves.toEqual({
      id: analyzing.reviewId,
      state: "analyzing",
    });
    expect(await transitionRows(analyzing.reviewId)).toHaveLength(0);
    expect(await persistedState(analyzing.reviewId)).toBe("analyzing");

    const completed = await seedReviewChain({ prefix: "same-terminal", state: "completed" });
    await expect(service.transitionReviewState(completed.reviewId, "completed")).resolves.toEqual({
      id: completed.reviewId,
      state: "completed",
    });
    expect(await transitionRows(completed.reviewId)).toHaveLength(0);
    expect(await persistedState(completed.reviewId)).toBe("completed");
  });

  test("an invalid transition throws a 409 AppError and leaves the review untouched", async () => {
    const seeded = await seedReviewChain({ prefix: "invalid", state: "queued" });
    const error = await service.transitionReviewState(seeded.reviewId, "publishing").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(InvalidStateTransitionError);
    expect(error).toBeInstanceOf(AppError);
    if (!(error instanceof InvalidStateTransitionError)) {
      throw new Error("expected InvalidStateTransitionError");
    }
    expect(error.code).toBe("INVALID_STATE_TRANSITION");
    expect(error.statusCode).toBe(409);
    expect(error.retryable).toBe(false);
    expect(error.fromState).toBe("queued");
    expect(error.toState).toBe("publishing");
    expect(error.message).toBe("Invalid review state transition: queued -> publishing");

    expect(await persistedState(seeded.reviewId)).toBe("queued");
    expect(await transitionRows(seeded.reviewId)).toHaveLength(0);
  });

  test("two concurrent valid moves from publishing move the review exactly once", async () => {
    const seeded = await seedReviewChain({ prefix: "concurrent", state: "publishing" });

    const results = await Promise.allSettled([
      service.transitionReviewState(seeded.reviewId, "completed"),
      service.transitionReviewState(seeded.reviewId, "failed"),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(InvalidStateTransitionError);

    const state = await persistedState(seeded.reviewId);
    expect(TERMINAL_REVIEW_STATES).toContain(state);

    const rows = await transitionRows(seeded.reviewId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fromState).toBe("publishing");
    expect(rows[0]?.toState).toBe(state);
  });

  test("terminal states reject every move and record no history", async () => {
    for (const terminal of TERMINAL_REVIEW_STATES) {
      const seeded = await seedReviewChain({ prefix: `terminal-${terminal}`, state: terminal });
      for (const target of REVIEW_STATES.filter((state) => state !== terminal)) {
        await expect(
          service.transitionReviewState(seeded.reviewId, target),
          `${terminal} must reject -> ${target}`,
        ).rejects.toBeInstanceOf(InvalidStateTransitionError);
      }
      expect(await persistedState(seeded.reviewId)).toBe(terminal);
      expect(await transitionRows(seeded.reviewId)).toHaveLength(0);
    }
  });

  test("each successful move appends exactly one transition row", async () => {
    const seeded = await seedReviewChain({ prefix: "history", state: "queued" });

    await service.transitionReviewState(seeded.reviewId, "preparing");
    // A repeated target after the move is an idempotent no-op, not a new row.
    await service.transitionReviewState(seeded.reviewId, "preparing");
    await service.transitionReviewState(seeded.reviewId, "cloning");

    const rows = await transitionRows(seeded.reviewId);
    expect(rows.map((row) => `${row.fromState}->${row.toState}`).sort()).toEqual([
      "preparing->cloning",
      "queued->preparing",
    ]);
    expect(await persistedState(seeded.reviewId)).toBe("cloning");
  });

  test("the guarded move joins an existing unit-of-work transaction", async () => {
    const committed = await seedReviewChain({ prefix: "uow-commit", state: "queued" });
    const unitOfWork = createIngestionUnitOfWork(prisma);

    await unitOfWork.execute((repos) =>
      repos.reviews.transitionState({
        reviewId: committed.reviewId,
        toState: "preparing",
        allowedFromStates: ["queued"],
        patch: {},
      }),
    );
    expect(await persistedState(committed.reviewId)).toBe("preparing");
    expect(await transitionRows(committed.reviewId)).toHaveLength(1);

    const rolledBack = await seedReviewChain({ prefix: "uow-rollback", state: "queued" });
    await expect(
      unitOfWork.execute(async (repos) => {
        await repos.reviews.transitionState({
          reviewId: rolledBack.reviewId,
          toState: "preparing",
          allowedFromStates: ["queued"],
          patch: {},
        });
        throw new Error("forced rollback");
      }),
    ).rejects.toThrow("forced rollback");

    expect(await persistedState(rolledBack.reviewId)).toBe("queued");
    expect(await transitionRows(rolledBack.reviewId)).toHaveLength(0);
  });

  test("a transition for a missing review reports not found", async () => {
    await expect(service.transitionReviewState("missing-review", "preparing")).rejects.toThrow(
      "Review 'missing-review' not found",
    );
  });
});
