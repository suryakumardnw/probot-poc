import type { Clock } from "../ports/clock.js";
import { InvalidStateTransitionError } from "../shared/errors/index.js";
import { REVIEW_STATES, type ReviewState, type ReviewStatePatch } from "./ingestion.repository.js";
import type { IngestionRepositories } from "./ingestion.unit-of-work.js";

/**
 * Review lifecycle state machine (ARCHITECTURE.md §4.3).
 *
 * Every transition is persisted as a ReviewStateTransition row so the full
 * history of a review is auditable. Terminal states accept no further
 * transitions — in particular a `superseded` review can never be resumed or
 * published.
 *
 * The state machine itself is pure; the repository performs the guarded write
 * and its audit row in one transaction, so concurrent callers cannot both move
 * the same review.
 */

export { InvalidStateTransitionError, REVIEW_STATES };

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

export function canTransition(from: ReviewState, to: ReviewState): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Every state the machine permits a move into `toState` from. */
function allowedPredecessors(toState: ReviewState): readonly ReviewState[] {
  return REVIEW_STATES.filter((from) => ALLOWED_TRANSITIONS[from].includes(toState));
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
  repositories: IngestionRepositories;
  clock: Clock;
};

export function createReviewStateService(deps: ReviewStateServiceDependencies): ReviewStateService {
  return {
    async transitionReviewState(
      reviewId: string,
      toState: ReviewState,
      options: TransitionOptions = {},
    ): Promise<{ id: string; state: ReviewState }> {
      const patch: Omit<ReviewStatePatch, "state"> = {
        ...(toState === "completed" || toState === "completed_with_warnings" ? { completedAt: deps.clock.now() } : {}),
        ...(toState === "failed"
          ? { errorCode: options.errorCode ?? "REVIEW_FAILED", errorMessage: options.errorMessage ?? null }
          : {}),
        ...(toState === "superseded" && options.supersededByReviewId
          ? { supersededByReviewId: options.supersededByReviewId, supersededAt: deps.clock.now() }
          : {}),
      };

      const result = await deps.repositories.reviews.transitionState({
        reviewId,
        toState,
        allowedFromStates: allowedPredecessors(toState),
        patch,
      });

      switch (result.outcome) {
        case "transitioned":
        case "unchanged":
          return { id: result.review.id, state: result.review.state };
        case "not_found":
          throw new Error(`Review '${reviewId}' not found`);
        case "conflict":
          throw new InvalidStateTransitionError(result.currentState, toState);
      }
    },
  };
}
