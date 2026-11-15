import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { Probot, ProbotOctokit } from "probot";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createApp } from "../../src/index.js";
import { disconnectDatabase } from "../helpers/db.js";
import { createTestIngestion } from "../helpers/ingestion.js";
import { createTestTriage } from "../helpers/triage.js";

/**
 * Characterization: issue triage (ARCHITECTURE.md §1.2 triage flow).
 *
 * Deliveries go through the real `issues.opened` Probot handler. The provider
 * call is observed at the HTTP transport boundary (global fetch) and the
 * resulting GitHub comment is asserted from the captured request.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const privateKey = fs.readFileSync(path.join(__dirname, "../fixtures/mock-cert.pem"), "utf-8");

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_ORIGIN = new URL(GROQ_URL).origin;
const GROQ_PATH = new URL(GROQ_URL).pathname;

/** A captured request to the exact Groq chat-completions endpoint. */
function isGroqProviderCall(request: CapturedRequest): boolean {
  return request.url.origin === GROQ_ORIGIN && request.url.pathname === GROQ_PATH;
}

const testIngestion = createTestIngestion({
  queue: {
    enqueue: async () => ({ id: "test-job" }),
    close: async () => {},
  },
});

/** A fresh graph per test keeps the lazily resolved provider env isolated. */
function makeTestApp() {
  return createApp({
    ingestion: testIngestion.services,
    ingestionRepositories: testIngestion.repositories,
    ingestionUnitOfWork: testIngestion.unitOfWork,
    triage: createTestTriage(),
    config: testIngestion.config,
  });
}

interface CapturedRequest {
  method: string;
  url: URL;
  body: any;
}

const jsonResponse = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

let captured: CapturedRequest[] = [];
let providerStatus = 200;

function installFetchStub(): void {
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

    if (url.pathname.startsWith("/app/installations/")) {
      return jsonResponse({ token: "test-installation-token", permissions: { issues: "write" } });
    }
    if (url.origin === new URL(GROQ_URL).origin) {
      if (providerStatus >= 400) {
        return new Response("provider unavailable", { status: providerStatus });
      }
      return jsonResponse({
        choices: [
          {
            message: {
              role: "assistant",
              content: "Classification: Bug\n- Possible cause: configuration file is missing.",
            },
          },
        ],
      });
    }
    return jsonResponse({});
  });
  vi.stubGlobal("fetch", stub);
}

function issuePayload(overrides: { userType?: string; pullRequest?: boolean } = {}) {
  const issue = {
    number: 5,
    title: "Crash on startup",
    body: "The app crashes immediately after install.",
    state: "open",
    user: { type: overrides.userType ?? "User", login: "reporter" },
    ...(overrides.pullRequest ? { pull_request: { url: "https://api.github.com/repos/octo-org/widget/pulls/5" } } : {}),
  };
  return {
    action: "opened",
    installation: { id: 2 },
    repository: {
      name: "widget",
      full_name: "octo-org/widget",
      owner: { login: "octo-org" },
    },
    issue,
  };
}

function makeProbot(log?: pino.Logger): Probot {
  const probot = new Probot({
    appId: 123,
    privateKey,
    ...(log ? { log } : {}),
    Octokit: ProbotOctokit.defaults((instanceOptions: any) => ({
      ...instanceOptions,
      retry: { enabled: false },
      throttle: { enabled: false },
    })),
  });
  probot.load(makeTestApp());
  return probot;
}

function commentPosts(): CapturedRequest[] {
  return captured.filter(
    (request) => request.method === "POST" && request.url.pathname === "/repos/octo-org/widget/issues/5/comments",
  );
}

beforeEach(() => {
  captured = [];
  providerStatus = 200;
  process.env.GROQ_API_KEY = "characterization-key";
  installFetchStub();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GROQ_API_KEY;
  delete process.env.GROQ_MODEL;
});

afterAll(async () => {
  await disconnectDatabase();
});

describe("issues.opened triage", () => {
  test("posts the rendered triage comment for a human-authored issue", async () => {
    const probot = makeProbot(pino({ level: "silent" }));
    await probot.receive({ name: "issues", payload: issuePayload() });
    await probot.teardown?.();

    const providerCall = captured.find(isGroqProviderCall);
    expect(providerCall).toBeDefined();
    if (!providerCall) {
      throw new Error("expected a Groq chat-completions request");
    }
    expect(providerCall.body.model).toBe("llama-3.3-70b-versatile");
    expect(providerCall.body.max_tokens).toBe(1024);
    expect(providerCall.body.temperature).toBe(0.2);
    expect(providerCall.body.messages[1].content).toContain("Issue #5:");
    expect(providerCall.body.messages[1].content).toContain("Crash on startup");

    const posts = commentPosts();
    expect(posts).toHaveLength(1);
    const post = posts[0];
    expect(post).toBeDefined();
    if (!post) {
      throw new Error("expected a triage comment post");
    }
    expect(post.body.body).toContain("🤖 **AI Triage**");
    expect(post.body.body).toContain("Classification: Bug");
    expect(post.body.body).toContain("human review still required");
  });

  test("uses GROQ_MODEL when configured", async () => {
    process.env.GROQ_MODEL = "custom-groq-model";
    const probot = makeProbot(pino({ level: "silent" }));
    await probot.receive({ name: "issues", payload: issuePayload() });
    await probot.teardown?.();

    const providerCall = captured.find(isGroqProviderCall);
    expect(providerCall).toBeDefined();
    if (!providerCall) {
      throw new Error("expected a Groq chat-completions request");
    }
    expect(providerCall.body.model).toBe("custom-groq-model");
  });

  test("bot-authored issues are skipped without calling the provider", async () => {
    const probot = makeProbot(pino({ level: "silent" }));
    await probot.receive({ name: "issues", payload: issuePayload({ userType: "Bot" }) });
    await probot.teardown?.();

    expect(captured).toHaveLength(0);
    expect(commentPosts()).toHaveLength(0);
  });

  test("pull request issues are skipped without calling the provider", async () => {
    const probot = makeProbot(pino({ level: "silent" }));
    await probot.receive({ name: "issues", payload: issuePayload({ pullRequest: true }) });
    await probot.teardown?.();

    expect(captured).toHaveLength(0);
    expect(commentPosts()).toHaveLength(0);
  });

  test("a provider failure is logged and does not crash the webhook", async () => {
    providerStatus = 503;
    const logs: string[] = [];
    const probot = makeProbot(
      pino(
        { level: "error" },
        {
          write(chunk: string) {
            logs.push(chunk);
          },
        },
      ),
    );

    await expect(probot.receive({ name: "issues", payload: issuePayload() })).resolves.toBeUndefined();
    await probot.teardown?.();

    expect(captured.some(isGroqProviderCall)).toBe(true);
    expect(commentPosts()).toHaveLength(0);
    expect(logs.join("")).toContain("AI issue triage failed");
  });

  test("a missing GROQ_API_KEY is logged and does not crash the webhook", async () => {
    delete process.env.GROQ_API_KEY;
    const logs: string[] = [];
    const probot = makeProbot(
      pino(
        { level: "error" },
        {
          write(chunk: string) {
            logs.push(chunk);
          },
        },
      ),
    );

    await expect(probot.receive({ name: "issues", payload: issuePayload() })).resolves.toBeUndefined();
    await probot.teardown?.();

    expect(captured).toHaveLength(0);
    expect(commentPosts()).toHaveLength(0);
    expect(logs.join("")).toContain("AI issue triage failed");
  });
});
