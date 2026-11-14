/**
 * GitHub content retrieval for knowledge sources (boot-time only).
 *
 * All network access happens at worker boot through `ensureKnowledgeSources`
 * — never per review. Repositories are addressed as "owner/repo" and a
 * pinned commit SHA; file contents come from the git-trees API (path list)
 * followed by the contents API (base64 blobs). Authentication is optional:
 * public sources work unauthenticated, and a bearer token from
 * KNOWLEDGE_GITHUB_TOKEN / GITHUB_TOKEN is attached when present (the
 * handbook repository is org-private).
 */
import { createHash } from "node:crypto";
import type { KnowledgeFetcher } from "./types.js";

export const DEFAULT_GITHUB_API = "https://api.github.com";

export function sha256Hex(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Resolve a GitHub API bearer token when one is configured (never logged). */
function authHeader(): Record<string, string> {
  const token = process.env.KNOWLEDGE_GITHUB_TOKEN || process.env.GITHUB_TOKEN || "";
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Default fetcher: plain fetch + AbortController timeout, optional bearer token. */
export function createDefaultKnowledgeFetcher(): KnowledgeFetcher {
  return async (url, init) => {
    const timeoutMs = init?.timeoutMs ?? 30_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "ai-pr-reviewer-knowledge",
          ...authHeader(),
        },
        redirect: "follow",
        signal: controller.signal,
      });
      const text = await response.text();
      return { status: response.status, text };
    } finally {
      clearTimeout(timer);
    }
  };
}

export function parseOwnerRepo(repo: string): { owner: string; repo: string } {
  const [owner, name] = repo.split("/");
  if (!owner || !name || repo.split("/").length !== 2) {
    throw new Error(`knowledge source repository must be "owner/repo", got '${repo}'`);
  }
  return { owner, repo: name };
}

export interface GitHubTreeEntry {
  path: string;
  mode: string;
  type: string;
  size?: number;
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
  const body = JSON.parse(response.text) as { sha?: string };
  if (!body.sha || !/^[0-9a-f]{40}$/.test(body.sha)) {
    throw new Error(`ref '${ref}' did not resolve to a commit SHA`);
  }
  return body.sha;
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
  const body = JSON.parse(response.text) as { tree?: GitHubTreeEntry[] };
  if (!Array.isArray(body.tree)) {
    throw new Error("unexpected tree response");
  }
  return body.tree;
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
  const body = JSON.parse(response.text) as { content?: string; encoding?: string };
  if (typeof body.content !== "string") {
    throw new Error(`'${filePath}' has no content`);
  }
  if (body.encoding !== "base64") {
    throw new Error(`'${filePath}' has unsupported encoding '${body.encoding}'`);
  }
  return Buffer.from(body.content, "base64").toString("utf8");
}
