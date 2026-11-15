import { z } from "zod";

/**
 * Knowledge-source contracts: GitHub REST responses and the on-disk skill /
 * handbook manifest.
 *
 * Fetched repository content is UNTRUSTED DATA. These schemas describe only
 * the envelope fields this application reads; unknown GitHub fields are
 * allowed (`.loose()`) because the REST API adds keys over time. Structural
 * essentials fail closed so a malformed response can never flow through the
 * knowledge fetcher as an unchecked cast.
 *
 * This module is a wire/disk contract only: it imports Zod and nothing else.
 */

/** One file recorded in a fetched source manifest. */
export const knowledgeFileRecordSchema = z.object({
  /** Cache-relative path. Path safety is enforced by the knowledge module. */
  path: z.string().min(1),
  /** Lowercase hex SHA-256 of the file content. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase hex SHA-256"),
  bytes: z.number().int().min(0),
});
export type KnowledgeFileRecord = z.infer<typeof knowledgeFileRecordSchema>;

/**
 * Manifest written last to a cache entry. `status` is always "fresh" for a
 * reusable entry; anything else means the cache is ignored and refetched.
 */
export const knowledgeManifestSchema = z.object({
  ref: z.string().min(1),
  fetchedAt: z.string().min(1),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/, "must be a lowercase hex SHA-256"),
  status: z.literal("fresh"),
  files: z.array(knowledgeFileRecordSchema).min(1),
});
export type KnowledgeManifest = z.infer<typeof knowledgeManifestSchema>;

/**
 * GET /repos/{owner}/{repo}/commits/{ref} — only the resolved commit SHA is
 * consumed. A non-SHA value is rejected by the caller's 40-hex check so the
 * existing "did not resolve to a commit SHA" error is preserved.
 */
export const githubCommitResponseSchema = z
  .object({
    sha: z.string().optional(),
  })
  .loose();
export type GitHubCommitResponse = z.infer<typeof githubCommitResponseSchema>;

/** One entry of a git tree listing. */
export const githubTreeEntrySchema = z
  .object({
    path: z.string(),
    mode: z.string(),
    type: z.string(),
    size: z.number().optional(),
  })
  .loose();
export type GitHubTreeEntry = z.infer<typeof githubTreeEntrySchema>;

/**
 * GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=1 — the `tree` array is
 * optional in the contract so the caller keeps its existing "unexpected tree
 * response" error for a missing list.
 */
export const githubTreeResponseSchema = z
  .object({
    tree: z.array(githubTreeEntrySchema).optional(),
  })
  .loose();
export type GitHubTreeResponse = z.infer<typeof githubTreeResponseSchema>;

/**
 * GET /repos/{owner}/{repo}/contents/{path}?ref={sha}. Content and encoding
 * stay optional so the caller can keep its specific "has no content" and
 * "unsupported encoding" errors.
 */
export const githubContentResponseSchema = z
  .object({
    content: z.string().optional(),
    encoding: z.string().optional(),
  })
  .loose();
export type GitHubContentResponse = z.infer<typeof githubContentResponseSchema>;
