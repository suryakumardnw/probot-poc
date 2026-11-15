/**
 * GitHub content retrieval for knowledge sources (boot-time only).
 *
 * All network access happens at worker boot through `ensureKnowledgeSources`
 * — never per review. Repositories are addressed as "owner/repo" and a
 * pinned commit SHA; file contents come from the git-trees API (path list)
 * followed by the contents API (base64 blobs). The request itself is performed
 * by the injected `KnowledgeFetcher` port; the default platform adapter
 * (`src/platform/knowledge/fetch.ts`) attaches an optional bearer token.
 *
 * Response bodies are parsed against the contracts in
 * `src/contracts/knowledge.ts` before any field is read.
 */
import { createHash } from "node:crypto";
import {
  githubCommitResponseSchema,
  githubContentResponseSchema,
  githubTreeResponseSchema,
  type GitHubTreeEntry,
} from "../../contracts/knowledge.js";
import type { KnowledgeFetcher } from "../../ports/knowledge.js";

export type { GitHubTreeEntry };

export const DEFAULT_GITHUB_API = "https://api.github.com";

export function sha256Hex(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Parse a response body without leaking its content into the error. */
function parseJsonBody(text: string, description: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    throw new Error(`${description} returned invalid JSON`);
  }
}

export function parseOwnerRepo(repo: string): { owner: string; repo: string } {
  const [owner, name] = repo.split("/");
  if (!owner || !name || repo.split("/").length !== 2) {
    throw new Error(`knowledge source repository must be "owner/repo", got '${repo}'`);
  }
  return { owner, repo: name };
}

/** GET /repos/{owner}/{repo}/commits/{ref} — resolve any ref to a commit SHA. */
export async function resolveCommitSha(
  fetcher: KnowledgeFetcher,
  owner: string,
  repo: string,
  ref: string,
  timeoutMs: number,
): Promise<string> {
  const response = await fetcher(`${DEFAULT_GITHUB_API}/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`, {
    timeoutMs,
  });
  if (response.status !== 200) {
    throw new Error(`resolving ref '${ref}' failed with HTTP ${response.status}`);
  }
  const body = githubCommitResponseSchema.safeParse(parseJsonBody(response.text, `resolving ref '${ref}'`));
  if (!body.success || !body.data.sha || !/^[0-9a-f]{40}$/.test(body.data.sha)) {
    throw new Error(`ref '${ref}' did not resolve to a commit SHA`);
  }
  return body.data.sha;
}

/** GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=1 — blob listing. */
export async function fetchRepoTree(
  fetcher: KnowledgeFetcher,
  owner: string,
  repo: string,
  sha: string,
  timeoutMs: number,
): Promise<GitHubTreeEntry[]> {
  const response = await fetcher(`${DEFAULT_GITHUB_API}/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`, {
    timeoutMs,
  });
  if (response.status !== 200) {
    throw new Error(`fetching tree of ${owner}/${repo}@${sha} failed with HTTP ${response.status}`);
  }
  const body = githubTreeResponseSchema.safeParse(
    parseJsonBody(response.text, `fetching tree of ${owner}/${repo}@${sha}`),
  );
  if (!body.success || !Array.isArray(body.data.tree)) {
    throw new Error("unexpected tree response");
  }
  return body.data.tree;
}

/** GET /repos/{owner}/{repo}/contents/{path}?ref={sha} — base64 file content. */
export async function fetchFileContent(
  fetcher: KnowledgeFetcher,
  owner: string,
  repo: string,
  filePath: string,
  sha: string,
  timeoutMs: number,
): Promise<string> {
  const response = await fetcher(
    `${DEFAULT_GITHUB_API}/repos/${owner}/${repo}/contents/${filePath.split("/").map(encodeURIComponent).join("/")}?ref=${sha}`,
    { timeoutMs },
  );
  if (response.status !== 200) {
    throw new Error(`fetching '${filePath}' failed with HTTP ${response.status}`);
  }
  const body = githubContentResponseSchema.safeParse(parseJsonBody(response.text, `fetching '${filePath}'`));
  if (!body.success || typeof body.data.content !== "string") {
    throw new Error(`'${filePath}' has no content`);
  }
  if (body.data.encoding !== "base64") {
    throw new Error(`'${filePath}' has unsupported encoding '${body.data.encoding}'`);
  }
  return Buffer.from(body.data.content, "base64").toString("utf8");
}
