import { REVIEW_STATES, type ReviewState, type ReviewStatePatch } from "./ingestion.repository.js";
import type { IngestionUnitOfWork } from "./ingestion.unit-of-work.js";
import { getDefaultIngestionDependencies } from "./prisma-ingestion.unit-of-work.js";

/**
 * Review lifecycle state machine (ARCHITECTURE.md §4.3).
 *
 * Every transition is persisted as a ReviewStateTransition row so the full
 * history of a review is auditable. Terminal states accept no further
 * transitions — in particular a `superseded` review can never be resumed or
 * published.
 *
 * The state machine itself is pure; persistence goes through the ingestion
 * unit of work so the review row and its audit transition commit together.
 */

export { REVIEW_STATES };

export const TERMINAL_REVIEW_STATES: readonly ReviewState[] = [
  "completed",
  "completed_with_warnings",
  "failed",
  "cancelled",
  "superseded",
];

export function isTerminalReviewState(state: ReviewState): boolean {
  return TERMINAL_REVIEW_STATES.includes(state);
}

/** Allowed transitions out of each state. */
const ALLOWED_TRANSITIONS: Readonly<Record<ReviewState, readonly ReviewState[]>> = {
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

export class InvalidStateTransitionError extends Error {
  constructor(
    public readonly fromState: ReviewState,
    public readonly toState: ReviewState,
  ) {
    super(`Invalid review state transition: ${fromState} -> ${toState}`);
    this.name = "InvalidStateTransitionError";
  }
}

export function canTransition(from: ReviewState, to: ReviewState): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

export type TransitionOptions = {
  /** Optional failure metadata when transitioning to `failed`. */
  errorCode?: string;
  errorMessage?: string;
  /** When transitioning to `superseded`, the review that replaced this one. */
  supersededByReviewId?: string;
};

export interface ReviewStateService {
  /**
   * Move a review to `toState` and persist the transition row. Throws
   * InvalidStateTransitionError when the move is not allowed. Terminal states
   * can never be left.
   */
  transitionReviewState(
    reviewId: string,
    toState: ReviewState,
    options?: TransitionOptions,
  ): Promise<{ id: string; state: ReviewState }>;
}

export type ReviewStateServiceDependencies = {
  unitOfWork: IngestionUnitOfWork;
};

export function createReviewStateService(deps: ReviewStateServiceDependencies): ReviewStateService {
  return {
    async transitionReviewState(
      reviewId: string,
      toState: ReviewState,
      options: TransitionOptions = {},
    ): Promise<{ id: string; state: ReviewState }> {
      return deps.unitOfWork.execute(async (repos) => {
        const review = await repos.reviews.findById(reviewId);
        if (!review) {
          throw new Error(`Review '${reviewId}' not found`);
        }
        if (review.state === toState) {
          return { id: review.id, state: review.state };
        }
        if (!canTransition(review.state, toState)) {
          throw new InvalidStateTransitionError(review.state, toState);
        }

        const patch: ReviewStatePatch = {
          state: toState,
          ...(toState === "completed" || toState === "completed_with_warnings" ? { completedAt: new Date() } : {}),
          ...(toState === "failed"
            ? { errorCode: options.errorCode ?? "REVIEW_FAILED", errorMessage: options.errorMessage ?? null }
            : {}),
          ...(toState === "superseded" && options.supersededByReviewId
            ? { supersededByReviewId: options.supersededByReviewId, supersededAt: new Date() }
            : {}),
        };

        const updated = await repos.reviews.updateState(review.id, patch);
        await repos.stateTransitions.create({
          reviewId: review.id,
          fromState: review.state,
          toState,
        });

        return { id: updated.id, state: updated.state };
      });
    },
  };
}

let defaultReviewStateService: ReviewStateService | undefined;

function getDefaultReviewStateService(): ReviewStateService {
  defaultReviewStateService ??= createReviewStateService({
    unitOfWork: getDefaultIngestionDependencies().unitOfWork,
  });
  return defaultReviewStateService;
}

/**
 * Module-edge compatibility function for existing callers. The implementation
 * receives its unit of work; PR 2.6 wires the composition root and removes this
 * wrapper.
 */
export async function transitionReviewState(
  reviewId: string,
  toState: ReviewState,
  options: TransitionOptions = {},
): Promise<{ id: string; state: ReviewState }> {
  return getDefaultReviewStateService().transitionReviewState(reviewId, toState, options);
}
