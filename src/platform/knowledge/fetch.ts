/**
 * Default HTTP adapter for knowledge-source retrieval.
 *
 * Network I/O belongs to the platform layer. The adapter implements the
 * `KnowledgeFetcher` port and attaches an optional bearer token from
 * `KNOWLEDGE_GITHUB_TOKEN` / `GITHUB_TOKEN`; the token is never logged.
 *
 * The knowledge module owns response parsing and caching. This adapter only
 * performs the request and returns status + body text, so tests can inject a
 * fake fetcher through the same port.
 */
import type { KnowledgeFetcher } from "../../ports/knowledge.js";
import { readEnv } from "../config/env.js";

/** Resolve a GitHub API bearer token when one is configured (never logged). */
function authHeader(): Record<string, string> {
  // Truthiness, not nullish coalescing: `.env.example` ships an empty
  // `KNOWLEDGE_GITHUB_TOKEN=`, which must fall through to `GITHUB_TOKEN`.
  const token = readEnv("KNOWLEDGE_GITHUB_TOKEN") || readEnv("GITHUB_TOKEN") || "";
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
