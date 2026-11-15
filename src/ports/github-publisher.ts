/**
 * GitHub publisher port (ARCHITECTURE.md §4.4, §6.4, §7.4).
 *
 * The publishing service depends on this minimal surface only; tests inject a
 * fake implementation. Keeping the shape here (rather than beside the service)
 * lets the concrete Octokit adapter move to `platform/github` without touching
 * publication logic.
 */

/** One inline review comment anchored to a diff position. */
export interface ReviewCommentParams {
  path: string;
  line: number;
  side?: "RIGHT" | "LEFT";
  body: string;
}

/** The subset of a created review the publisher records and reconciles. */
export interface CreatedReview {
  id: number;
  comments?: Array<{ id: number; body?: string | null }>;
}

export interface CreatedReviewResponse {
  data: CreatedReview;
}

/**
 * Minimal pull-request API used for publication. Every method mirrors the
 * Octokit REST shape so the real client satisfies it directly.
 */
export interface PublisherOctokit {
  rest: {
    pulls: {
      get(params: { owner: string; repo: string; pull_number: number }): Promise<{
        data: { head: { sha?: string | null } };
      }>;
      listReviewComments(params: {
        owner: string;
        repo: string;
        pull_number: number;
        per_page?: number;
        page?: number;
      }): Promise<{ data: Array<{ id: number; body: string | null }> }>;
      listReviews(params: {
        owner: string;
        repo: string;
        pull_number: number;
        per_page?: number;
        page?: number;
      }): Promise<{ data: Array<{ id: number; body: string | null; state: string }> }>;
      createReview(params: {
        owner: string;
        repo: string;
        pull_number: number;
        event: "COMMENT";
        body: string;
        comments?: ReviewCommentParams[];
      }): Promise<CreatedReviewResponse>;
    };
  };
}
