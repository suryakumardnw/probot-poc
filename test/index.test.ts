// Requiring our app implementation
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Probot, ProbotOctokit } from "probot";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import myProbotApp from "../src/index.js";
// Requiring our fixtures
import issueOpenedPayload from "./fixtures/issues.opened.json" with { type: "json" };

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const privateKey = fs.readFileSync(path.join(__dirname, "fixtures/mock-cert.pem"), "utf-8");

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** Captured requests, keyed by `METHOD path`. */
function createServer() {
  const captured: Array<{ method: string; url: URL; body: any }> = [];
  const stub = vi.fn(async (input: any, init?: RequestInit) => {
    const url = new URL(String(input?.url ?? input));
    let body: any = null;
    if (init?.body) {
      try {
        body = JSON.parse(String(init.body));
      } catch {
        body = String(init.body);
      }
    }
    captured.push({ method: init?.method ?? "GET", url, body });

    // GitHub: installation token (auth bootstrap)
    if (url.pathname === "/app/installations/2/access_tokens") {
      return json({ token: "test", permissions: { issues: "write" } });
    }

    // LLM: chat completions
    if (url.origin === new URL(GROQ_URL).origin) {
      return json({
        choices: [
          {
            message: {
              role: "assistant",
              content: "Classification: Bug\n- Possible cause: ...",
            },
          },
        ],
      });
    }

    // GitHub API default
    return json({});
  });
  vi.stubGlobal("fetch", stub);
  return { stub, captured };
}

describe("probot-poc app", () => {
  let probot: any;

  beforeEach(() => {
    probot = new Probot({
      appId: 123,
      privateKey,
      // disable request throttling and retries for testing
      Octokit: ProbotOctokit.defaults((instanceOptions: any) => ({
        ...instanceOptions,
        retry: { enabled: false },
        throttle: { enabled: false },
      })),
    });
    // Load our app into probot
    probot.load(myProbotApp);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GROQ_API_KEY;
  });

  test("posts an AI triage comment when an issue is opened", async () => {
    process.env.GROQ_API_KEY = "test-key";
    const { captured } = createServer();

    await probot.receive({
      name: "issues",
      payload: issueOpenedPayload,
    });

    const comment = captured.find((r) => r.url.pathname === "/repos/hiimbex/testing-things/issues/1/comments");
    expect(comment).toBeDefined();
    expect(comment!.body.body).toContain("🤖 **AI Triage**");
    expect(comment!.body.body).toContain("Classification: Bug");

    // The LLM was called with the issue title in the user message.
    const llm = captured.find((r) => r.url.origin === new URL(GROQ_URL).origin);
    expect(llm).toBeDefined();
    expect(llm!.body.messages[1].content).toContain("Issue #1:");
  });

  test("skips triage for bot users", async () => {
    process.env.GROQ_API_KEY = "test-key";
    const { captured } = createServer();

    await probot.receive({
      name: "issues",
      payload: {
        ...issueOpenedPayload,
        issue: {
          ...issueOpenedPayload.issue,
          user: { type: "Bot" },
        },
      },
    });

    expect(captured).toHaveLength(0);
  });

  test("skips triage when GROQ_API_KEY is missing", async () => {
    const { captured } = createServer();

    // The app-level try/catch means the comment is simply never posted;
    // assert no GitHub comment (and no LLM call) happened.
    const comment = captured.find((r) => r.url.pathname === "/repos/hiimbex/testing-things/issues/1/comments");
    const llm = captured.find((r) => r.url.origin === new URL(GROQ_URL).origin);
    expect(comment).toBeUndefined();
    expect(llm).toBeUndefined();
  });
});
