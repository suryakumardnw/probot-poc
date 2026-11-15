import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDefaultKnowledgeFetcher } from "../src/platform/knowledge/fetch.js";

/**
 * Focused tests for the platform knowledge HTTP adapter's token fallback.
 *
 * `.env.example` ships an empty `KNOWLEDGE_GITHUB_TOKEN=`, so an empty value
 * must not mask `GITHUB_TOKEN` for private sources.
 */

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const saved = {
  knowledge: process.env.KNOWLEDGE_GITHUB_TOKEN,
  github: process.env.GITHUB_TOKEN,
};
let requests: Array<{ url: string; init?: RequestInit }> = [];

const fakeFetch: FetchLike = async (input, init) => {
  requests.push({ url: String(input), ...(init ? { init } : {}) });
  return new Response("{}", { status: 200 });
};

function restoreEnv(name: "KNOWLEDGE_GITHUB_TOKEN" | "GITHUB_TOKEN", value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function authorizationFor(): Promise<string | null> {
  const fetcher = createDefaultKnowledgeFetcher();
  await fetcher("https://api.github.com/repos/owner/repo/git/trees/sha", { timeoutMs: 1_000 });
  const request = requests[0];
  if (!request) {
    throw new Error("expected the adapter to perform one request");
  }
  return new Headers(request.init?.headers).get("Authorization");
}

beforeEach(() => {
  requests = [];
  vi.stubGlobal("fetch", fakeFetch);
  delete process.env.KNOWLEDGE_GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
});

afterEach(() => {
  vi.unstubAllGlobals();
  restoreEnv("KNOWLEDGE_GITHUB_TOKEN", saved.knowledge);
  restoreEnv("GITHUB_TOKEN", saved.github);
});

describe("default knowledge fetcher auth header", () => {
  test("empty KNOWLEDGE_GITHUB_TOKEN falls through to GITHUB_TOKEN", async () => {
    process.env.KNOWLEDGE_GITHUB_TOKEN = "";
    process.env.GITHUB_TOKEN = "fallback-token";

    await expect(authorizationFor()).resolves.toBe("Bearer fallback-token");
  });

  test("GITHUB_TOKEN is used when KNOWLEDGE_GITHUB_TOKEN is unset", async () => {
    process.env.GITHUB_TOKEN = "fallback-token";

    await expect(authorizationFor()).resolves.toBe("Bearer fallback-token");
  });

  test("KNOWLEDGE_GITHUB_TOKEN wins when both are configured", async () => {
    process.env.KNOWLEDGE_GITHUB_TOKEN = "knowledge-token";
    process.env.GITHUB_TOKEN = "fallback-token";

    await expect(authorizationFor()).resolves.toBe("Bearer knowledge-token");
  });

  test("no Authorization header is sent when neither token is configured", async () => {
    await expect(authorizationFor()).resolves.toBeNull();
  });
});
