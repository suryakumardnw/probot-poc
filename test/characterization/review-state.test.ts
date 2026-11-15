import type { ReviewState } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import {
  InvalidStateTransitionError,
  REVIEW_STATES,
  isTerminalReviewState,
} from "../../src/modules/ingestion/index.js";
import { AppError } from "../../src/shared/errors/index.js";
import { createTestReviewState } from "../helpers/ingestion.js";
import { cleanDatabase, disconnectDatabase, prisma } from "./support.js";

/**
 * Characterization: review lifecycle state machine (ARCHITECTURE.md §4.3).
 *
 * This table is written out by hand instead of importing the implementation's
 * transition map: it is the contract the refactor must preserve. Every move is
 * exercised through the exported `transitionReviewState` boundary and verified
 * against the persisted Review row and ReviewStateTransition history.
 */

const transitionReviewState = createTestReviewState().transitionReviewState;

const ALLOWED: Readonly<Record<ReviewState, readonly ReviewState[]>> = {
  queued: ["preparing", "failed", "cancelled", "superseded"],
  preparing: ["cloning", "failed", "cancelled", "superseded"],
  cloning: ["analyzing", "failed", "cancelled", "superseded"],
  analyzing: ["investigating", "validating", "failed", "cancelled", "superseded"],
  investigating: ["validating", "failed", "cancelled", "superseded"],
  validating: ["publishing", "failed", "cancelled", "superseded"],
  publishing: ["completed", "completed_with_warnings", "failed", "cancelled", "superseded"],
  completed: [],
  completed_with_warnings: [],
  failed: [],
  cancelled: [],
  superseded: [],
};

const TERMINAL: readonly ReviewState[] = ["completed", "completed_with_warnings", "failed", "cancelled", "superseded"];

let fixture: { installationId: string; repositoryId: string; pullRequestId: string };
let reviewSeq = 0;

async function seedReviewInState(state: ReviewState, headShaLabel = "state"): Promise<string> {
  reviewSeq += 1;
  const headSha = `${headShaLabel}-${reviewSeq.toString().padStart(4, "0")}`;
  const review = await prisma.review.create({
    data: {
      pullRequestId: fixture.pullRequestId,
      githubInstallationId: 9_500_000n,
      githubRepositoryId: 8_500_000n,
      pullRequestNumber: 501,
      headSha,
      state,
      trigger: "opened",
    },
  });
  return review.id;
}

async function transitionCount(reviewId: string): Promise<number> {
  return prisma.reviewStateTransition.count({ where: { reviewId } });
}

beforeEach(async () => {
  await cleanDatabase();
  const installation = await prisma.installation.create({
    data: { githubInstallationId: 9_500_000n, organization: "state-org", status: "active" },
  });
  const repository = await prisma.repository.create({
    data: {
      githubRepositoryId: 8_500_000n,
      installationId: installation.id,
      fullName: "state-org/state-repo",
      defaultBranch: "main",
      status: "active",
    },
  });
  const pullRequest = await prisma.pullRequest.create({
    data: {
      repositoryId: repository.id,
      githubPrNumber: 501,
      headSha: "state-fixture-head",
      status: "open",
    },
  });
  fixture = {
    installationId: installation.id,
    repositoryId: repository.id,
    pullRequestId: pullRequest.id,
  };
});

afterAll(async () => {
  await cleanDatabase();
  await disconnectDatabase();
});

describe("review state transitions (§4.3)", () => {
  test("every allowed transition moves the row and persists an audit transition", async () => {
    for (const from of REVIEW_STATES) {
      for (const to of ALLOWED[from]) {
        const reviewId = await seedReviewInState(from, `allowed-${from}-${to}`);
        const result = await transitionReviewState(reviewId, to);

        expect(result, `${from} -> ${to} returns the moved review`).toEqual({ id: reviewId, state: to });
        const row = await prisma.review.findUniqueOrThrow({ where: { id: reviewId } });
        expect(row.state, `${from} -> ${to} persists the new state`).toBe(to);

        const transitions = await prisma.reviewStateTransition.findMany({
          where: { reviewId },
          orderBy: { createdAt: "asc" },
        });
        expect(
          transitions.map((entry) => `${entry.fromState}->${entry.toState}`),
          `${from} -> ${to} is auditable`,
        ).toEqual([`${from}->${to}`]);
      }
    }
  });

  test("every disallowed transition throws and leaves the row untouched", async () => {
    for (const from of REVIEW_STATES) {
      const reviewId = await seedReviewInState(from, `invalid-${from}`);
      const invalidTargets = REVIEW_STATES.filter((to) => to !== from && !ALLOWED[from].includes(to));
      const transitionsBefore = await transitionCount(reviewId);

      for (const to of invalidTargets) {
        await expect(transitionReviewState(reviewId, to), `${from} -> ${to} must be rejected`).rejects.toBeInstanceOf(
          InvalidStateTransitionError,
        );

        const row = await prisma.review.findUniqueOrThrow({ where: { id: reviewId } });
        expect(row.state, `${from} stays unchanged after rejected ${from} -> ${to}`).toBe(from);
      }

      expect(await transitionCount(reviewId), `${from} records no transitions for rejected moves`).toBe(
        transitionsBefore,
      );
    }
  });

  test("terminal states accept no further move", async () => {
    for (const terminal of TERMINAL) {
      const reviewId = await seedReviewInState(terminal, `terminal-${terminal}`);
      expect(isTerminalReviewState(terminal)).toBe(true);
      const transitionsBefore = await transitionCount(reviewId);

      for (const to of REVIEW_STATES) {
        if (to === terminal) {
          continue;
        }
        await expect(
          transitionReviewState(reviewId, to),
          `terminal ${terminal} must reject -> ${to}`,
        ).rejects.toBeInstanceOf(InvalidStateTransitionError);
      }

      expect((await prisma.review.findUniqueOrThrow({ where: { id: reviewId } })).state).toBe(terminal);
      expect(await transitionCount(reviewId)).toBe(transitionsBefore);
    }
  });

  test("a same-state transition is idempotent and records no duplicate history", async () => {
    for (const state of REVIEW_STATES) {
      const reviewId = await seedReviewInState(state, `same-${state}`);
      const result = await transitionReviewState(reviewId, state);
      const repeated = await transitionReviewState(reviewId, state);
      expect(result).toEqual({ id: reviewId, state });
      expect(repeated).toEqual({ id: reviewId, state });
      expect(await transitionCount(reviewId), `${state} -> ${state} adds no audit row`).toBe(0);
      expect((await prisma.review.findUniqueOrThrow({ where: { id: reviewId } })).state).toBe(state);
    }
  });

  test("an invalid transition carries the shared 409 conflict contract", async () => {
    const reviewId = await seedReviewInState("queued", "error-contract");
    const error = await transitionReviewState(reviewId, "completed").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(InvalidStateTransitionError);
    expect(error).toBeInstanceOf(AppError);
    if (!(error instanceof InvalidStateTransitionError)) {
      throw new Error("expected InvalidStateTransitionError");
    }
    expect(error.code).toBe("INVALID_STATE_TRANSITION");
    expect(error.statusCode).toBe(409);
    expect(error.retryable).toBe(false);
    expect(error.fromState).toBe("queued");
    expect(error.toState).toBe("completed");
    expect((await prisma.review.findUniqueOrThrow({ where: { id: reviewId } })).state).toBe("queued");
    expect(await transitionCount(reviewId)).toBe(0);
  });

  test("terminal side effects are recorded on the review row", async () => {
    const completedId = await seedReviewInState("validating", "side-completed");
    await transitionReviewState(completedId, "publishing");
    await transitionReviewState(completedId, "completed");
    const completed = await prisma.review.findUniqueOrThrow({ where: { id: completedId } });
    expect(completed.completedAt).not.toBeNull();

    const failedId = await seedReviewInState("validating", "side-failed");
    await transitionReviewState(failedId, "failed", { errorCode: "CHARACTERIZED_FAILURE", errorMessage: "boom" });
    const failed = await prisma.review.findUniqueOrThrow({ where: { id: failedId } });
    expect(failed.errorCode).toBe("CHARACTERIZED_FAILURE");
    expect(failed.errorMessage).toBe("boom");

    const replacementId = await seedReviewInState("queued", "side-replacement");
    const supersededId = await seedReviewInState("analyzing", "side-superseded");
    await transitionReviewState(supersededId, "superseded", { supersededByReviewId: replacementId });
    const superseded = await prisma.review.findUniqueOrThrow({ where: { id: supersededId } });
    expect(superseded.supersededByReviewId).toBe(replacementId);
    expect(superseded.supersededAt).not.toBeNull();
  });
});
