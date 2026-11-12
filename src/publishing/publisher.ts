/**
 * GitHub review publisher (ARCHITECTURE.md §4.3, §4.4, §6.4, §7.4, §13.1;
 * ticket 09).
 *
 * Responsibilities:
 *  - Stale SHA protection: the current PR head SHA is re-verified through the
 *    GitHub API immediately before anything is published; a moved head rejects
 *    the whole publication (§4.4 — never publish results for a superseded
 *    commit).
 *  - Inline comment generation: verified findings with a valid diff position
 *    are published as inline review comments; findings without a valid
 *    position (deleted line/file, binary, outside the diff) fall back to the
 *    summary (§7.4 — never force an incorrect inline location).
 *  - Deduplication + reconciliation: inline comment bodies carry a hidden
 *    fingerprint marker; comments already present on the PR (or already
 *    recorded in `review_comments` for this review) are never published again.
 *  - COMMENT-only publication: the review event is ALWAYS `COMMENT` —
 *    APPROVE and REQUEST_CHANGES are never sent (§23 non-goal).
 *  - Publication status persistence: every GitHub comment id is recorded in
 *    the `review_comments` table (§13.1).
 *  - GitHub API error handling: bounded retries with exponential backoff.
 */

import type { PrismaClient } from "@prisma/client";
import { Octokit } from "@octokit/core";
import { restEndpointMethods } from "@octokit/plugin-rest-endpoint-methods";
import { retry } from "@octokit/plugin-retry";
import {
  buildInlineCommentBody,
  buildReviewBody,
  extractFingerprint,
  type ReviewBodyMeta,
} from "./summary.js";
import { resolveInlinePosition, parseUnifiedDiff, type InlinePosition } from "./diff-positions.js";
import type { StoredFinding } from "../findings/index.js";

// ---------------------------------------------------------------------------
// Octokit surface (minimal, injectable — tests supply a fake)
// ---------------------------------------------------------------------------

export interface ReviewCommentParams {
  path: string;
  line: number;
  side?: "RIGHT" | "LEFT";
  body: string;
}

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
      }): Promise<{ data: { id: number; comments?: Array<{ id: number; body?: string | null }> } }>;
    };
  };
}

/** Real octokit built from an installation token (rest methods + retry plugin). */
const RestOctokit = Octokit.plugin(restEndpointMethods, retry);

export function createGitHubOctokit(token: string, baseUrl?: string): PublisherOctokit {
  return new RestOctokit({
    auth: token,
    ...(baseUrl ? { baseUrl } : {}),
  }) as unknown as PublisherOctokit;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** The PR head moved between review time and publish time (§4.3/§4.4). */
export class StaleHeadError extends Error {
  constructor(
    public readonly expectedSha: string,
    public readonly actualSha: string | null,
  ) {
    super(`PR head moved before publication: expected ${expectedSha.slice(0, 12)}, current ${actualSha ? actualSha.slice(0, 12) : "unknown"}`);
    this.name = "StaleHeadError";
  }
}

class ApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubApiError";
  }
}

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

export interface RetryOptions {
  maxAttempts: number;
  /** Base delay in ms; attempt n waits baseDelayMs * 2^(n-1). */
  baseDelayMs: number;
}

export const DEFAULT_RETRY: RetryOptions = { maxAttempts: 3, baseDelayMs: 500 };

export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  options: RetryOptions,
  logger?: { warn: (obj: unknown, msg: string) => void },
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < options.maxAttempts) {
        const delay = options.baseDelayMs * 2 ** (attempt - 1);
        logger?.warn(
          { label, attempt, nextAttempt: attempt + 1, delayMs: delay, err: error instanceof Error ? error.message : String(error) },
          "GitHub API call failed; retrying",
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw new ApiError(`${label} failed after ${options.maxAttempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

// ---------------------------------------------------------------------------
// Publication
// ---------------------------------------------------------------------------

const SUMMARY_MARKER = "<!-- ai-pr-reviewer:summary -->";

/** Marker appended to the summary body so earlier summaries can be reconciled. */
export function appendSummaryMarker(body: string): string {
  return `${body}\n\n${SUMMARY_MARKER}`;
}

export type PublishOutcome =
  | "published"
  | "already_published"
  | "clean_review_published"
  | "nothing_to_publish";

export interface PublishReviewResult {
  outcome: PublishOutcome;
  /** GitHub review id of the summary comment (null when deduped/skipped). */
  reviewId: number | null;
  /** Inline comments created in this call. */
  inlineCreated: number;
  /** Inline comments skipped because their fingerprint already exists. */
  inlineDeduped: number;
  /** Verified findings that could not be anchored inline (summary-only). */
  summaryOnlyFindings: number;
  /** Findings skipped as already reconciled from a previous publication. */
  reconciled: number;
}

export interface PublishReviewInput {
  prisma: PrismaClient;
  octokit: PublisherOctokit;
  reviewId: string;
  /** Full repository name ("owner/repo"). */
  repositoryFullName: string;
  pullNumber: number;
  /** Head SHA the review was produced for — re-verified before publishing. */
  headSha: string;
  /** Unified diff (merge base..head) used for inline position resolution. */
  diff: string;
  /** Engine summary text. */
  summary: string;
  /** All stored findings of this review (verified + uncertain). */
  findings: StoredFinding[];
  config: { publishUncertainInSummary: boolean; publishCleanReview: boolean };
  /** Header metadata for the review body (reviewer, source, date). */
  meta?: ReviewBodyMeta;
  retry?: Partial<RetryOptions>;
  logger?: { info: (obj: unknown, msg: string) => void; warn: (obj: unknown, msg: string) => void };
}

function splitFullName(repositoryFullName: string): { owner: string; repo: string } {
  const [owner, repo] = repositoryFullName.split("/");
  if (!owner || !repo) throw new Error(`Invalid repository full name: ${repositoryFullName}`);
  return { owner, repo };
}

/** Page through a paginated pulls.* listing (bounded to 10 pages). */
async function listAll<T>(fetchPage: (page: number) => Promise<T[]>): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = await fetchPage(page);
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

/**
 * Publish the review for one already-persisted set of findings.
 *
 * Order of operations (§7.4):
 *  1. Stale-SHA re-check (pulls.get).
 *  2. Reconcile existing PR comments + persisted publication rows.
 *  3. Resolve inline positions from the diff.
 *  4. createReview with event COMMENT (summary + inline comments).
 *  5. Persist ReviewComment rows with the GitHub comment IDs.
 */
export async function publishReview(input: PublishReviewInput): Promise<PublishReviewResult> {
  const { prisma, octokit, reviewId, repositoryFullName, pullNumber, headSha, diff, summary, findings, logger } = input;
  const { owner, repo } = splitFullName(repositoryFullName);
  const retryOptions: RetryOptions = { ...DEFAULT_RETRY, ...input.retry };
  const expectedSha = headSha.toLowerCase();

  // 1. Stale SHA protection (§4.4): re-verify immediately before publishing.
  const prData = await withRetry(
    "pulls.get",
    () => octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber }),
    retryOptions,
    logger,
  );
  const currentSha = prData.data.head.sha ? prData.data.head.sha.toLowerCase() : null;
  if (currentSha !== expectedSha) {
    throw new StaleHeadError(expectedSha, currentSha);
  }

  // 2. Reconcile: existing inline comments on the PR by fingerprint marker,
  //    plus publication rows already recorded for this review.
  const existingComments = await listAll(
    (page) =>
      withRetry(
        "pulls.listReviewComments",
        () =>
          octokit.rest.pulls.listReviewComments({
            owner,
            repo,
            pull_number: pullNumber,
            per_page: 100,
            page,
          }),
        retryOptions,
        logger,
      ).then((r) => r.data),
  );
  const knownFingerprints = new Map<string, number>();
  for (const comment of existingComments) {
    const fp = comment.body ? extractFingerprint(comment.body) : null;
    if (fp && !knownFingerprints.has(fp)) knownFingerprints.set(fp, comment.id);
  }
  const publishedRows = await prisma.reviewComment.findMany({
    where: { reviewId, status: "published", fingerprint: { not: null } },
    select: { fingerprint: true, githubCommentId: true },
  });
  for (const row of publishedRows) {
    if (row.fingerprint && !knownFingerprints.has(row.fingerprint)) {
      knownFingerprints.set(row.fingerprint, Number(row.githubCommentId ?? 0));
    }
  }

  // 3. Inline position resolution (§7.4): only verified findings with a valid
  //    new-side diff position become inline comments.
  const diffFiles = parseUnifiedDiff(diff);
  const verified = findings.filter((f) => f.status !== "uncertain");
  const uncertain = findings.filter((f) => f.status === "uncertain");

  interface InlineCandidate {
    finding: StoredFinding;
    position: InlinePosition;
  }
  const inlineCandidates: InlineCandidate[] = [];
  let summaryOnlyFindings = 0;
  let inlineDeduped = 0;
  let reconciled = 0;

  for (const finding of verified) {
    const resolution = resolveInlinePosition(diffFiles, finding.filePath, finding.lineNumber);
    if (resolution.kind !== "anchored") {
      summaryOnlyFindings += 1;
      continue;
    }
    if (knownFingerprints.has(finding.fingerprint)) {
      // Already published for this fingerprint (earlier attempt / duplicate).
      inlineDeduped += 1;
      reconciled += 1;
      continue;
    }
    inlineCandidates.push({ finding, position: resolution.position });
  }

  // 4. Summary dedup: an already-recorded summary row (or an existing review
  //    carrying our marker) means the summary was published in an earlier
  //    attempt — never create a second one.
  const summaryRow = await prisma.reviewComment.findFirst({
    where: { reviewId, commentType: "summary", status: "published", githubCommentId: { not: null } },
    select: { githubCommentId: true },
  });
  let existingSummaryId: number | null = summaryRow?.githubCommentId != null ? Number(summaryRow.githubCommentId) : null;
  if (existingSummaryId === null) {
    const reviews = await listAll(
      (page) =>
        withRetry(
          "pulls.listReviews",
          () => octokit.rest.pulls.listReviews({ owner, repo, pull_number: pullNumber, per_page: 100, page }),
          retryOptions,
          logger,
        ).then((r) => r.data),
    );
    const marked = reviews.find((r) => r.body?.includes(SUMMARY_MARKER));
    existingSummaryId = marked ? marked.id : null;
  }

  const body = appendSummaryMarker(
    buildReviewBody({
      summary,
      verified,
      uncertain,
      inlineFingerprints: new Set(inlineCandidates.map((c) => c.finding.fingerprint)),
      config: input.config,
      ...(input.meta ? { meta: input.meta } : {}),
    }),
  );

  const commentPayloads = inlineCandidates.map((candidate) => ({
    ...candidate.position,
    body: buildInlineCommentBody(candidate.finding),
  }));

  const result: PublishReviewResult = {
    outcome: "published",
    reviewId: null,
    inlineCreated: 0,
    inlineDeduped,
    summaryOnlyFindings,
    reconciled,
  };

  if (existingSummaryId !== null && commentPayloads.length === 0) {
    // Nothing new to publish: full dedup.
    result.outcome = "already_published";
    result.reviewId = existingSummaryId;
    result.inlineCreated = 0;
    logger?.info(
      { reviewId, existingSummaryId, inlineDeduped, summaryOnlyFindings },
      "Review already published; no new comments to create",
    );
    return result;
  }

  // 5. COMMENT-only publication — NEVER APPROVE / REQUEST_CHANGES (§23).
  const created = await withRetry(
    "pulls.createReview",
    () =>
      octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: pullNumber,
        event: "COMMENT",
        body,
        comments: commentPayloads,
      }),
    retryOptions,
    logger,
  );

  const githubReviewId = created.data.id;
  result.reviewId = githubReviewId;
  // A createReview call just happened, so this publication DID add content;
  // `already_published` is reserved for the full-dedup early return.
  result.outcome =
    verified.length === 0 && uncertain.length === 0 && existingSummaryId === null
      ? "clean_review_published"
      : "published";
  result.inlineCreated = created.data.comments?.length ?? commentPayloads.length;

  // 6. Persist publication state (§13.1). Mapping relies on the fingerprint
  //    marker echoed back in the created review comments.
  const responseComments = created.data.comments ?? [];
  const fingerprintToCommentId = new Map<string, number>();
  for (const comment of responseComments) {
    const fp = comment.body ? extractFingerprint(comment.body) : null;
    if (fp) fingerprintToCommentId.set(fp, comment.id);
  }

  await prisma.$transaction(async (tx) => {
    if (existingSummaryId === null) {
      await tx.reviewComment.create({
        data: { reviewId, commentType: "summary", status: "published", githubCommentId: BigInt(githubReviewId) },
      });
    }
    for (const candidate of inlineCandidates) {
      const commentId = fingerprintToCommentId.get(candidate.finding.fingerprint) ?? null;
      await tx.reviewComment.create({
        data: {
          reviewId,
          findingId: candidate.finding.id,
          fingerprint: candidate.finding.fingerprint,
          commentType: "inline",
          status: "published",
          ...(commentId !== null ? { githubCommentId: BigInt(commentId) } : {}),
        },
      });
    }
  });

  logger?.info(
    {
      reviewId,
      githubReviewId,
      outcome: result.outcome,
      inlineCreated: result.inlineCreated,
      inlineDeduped: result.inlineDeduped,
      summaryOnlyFindings: result.summaryOnlyFindings,
      uncertainInSummary: uncertain.length,
    },
    "Review published to GitHub",
  );
  return result;
}

/**
 * Record a publication failure for the summary comment (status `failed`),
 * best-effort — called when createReview exhausted its retries.
 */
export async function recordPublicationFailure(prisma: PrismaClient, reviewId: string): Promise<void> {
  await prisma.reviewComment
    .create({
      data: {
        reviewId,
        commentType: "summary",
        status: "failed",
        // No githubCommentId: nothing was published.
      },
    })
    .catch(() => {
      /* best-effort */
    });
}
