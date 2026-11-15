// Requiring our app implementation
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { Probot, ProbotOctokit } from "probot";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createApp } from "../../src/index.js";
import issueOpenedPayload from "../fixtures/issues.opened.json" with { type: "json" };
import { defined } from "../helpers/assert.js";
import { disconnectDatabase } from "../helpers/db.js";
import { webhookReceiver } from "../helpers/events.js";
import { createTestIngestion } from "../helpers/ingestion.js";
import { createTestTriage } from "../helpers/triage.js";
// Requiring our fixtures

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const privateKey = fs.readFileSync(path.join(__dirname, "../fixtures/mock-cert.pem"), "utf-8");

const testIngestion = createTestIngestion({
  queue: {
    enqueue: async () => ({ id: "test-job" }),
    removeTerminalJob: async () => {},
    getJobCounts: async () => ({ waiting: 0, active: 0, delayed: 0 }),
    close: async () => {},
  },
});

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`expected ${label} to be an object`);
  }
  return value as Record<string, unknown>;
}

/** Captured requests, keyed by `METHOD path`. */
function createServer() {
  const captured: Array<{ method: string; url: URL; body: unknown }> = [];
  const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    let body: unknown = null;
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

/** A fresh graph per test keeps the lazily resolved provider env isolated. */
function makeTestApp() {
  return createApp({
    ingestion: testIngestion.services,
    triage: createTestTriage(),
    config: testIngestion.config,
  });
}

describe("probot-poc app", () => {
  let probot: Probot;

  afterAll(async () => {
    await disconnectDatabase();
  });

  beforeEach(() => {
    probot = new Probot({
      appId: 123,
      privateKey,
      log: pino({ level: "silent" }),
      // disable request throttling and retries for testing
      Octokit: ProbotOctokit.defaults((instanceOptions: Record<string, unknown>) => ({
        ...instanceOptions,
        retry: { enabled: false },
        throttle: { enabled: false },
      })),
    });
    // Load our app into probot
    probot.load(makeTestApp());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GROQ_API_KEY;
    delete process.env.GROQ_MODEL;
  });

  test("posts an AI triage comment when an issue is opened", async () => {
    process.env.GROQ_API_KEY = "test-key";
    const { captured } = createServer();

    await webhookReceiver(probot).receive({
      name: "issues",
      payload: issueOpenedPayload,
    });

    const comment = defined(
      captured.find((r) => r.url.pathname === "/repos/hiimbex/testing-things/issues/1/comments"),
      "triage comment request",
    );
    expect(String(asRecord(comment.body, "triage comment").body)).toContain("🤖 **AI Triage**");
    expect(String(asRecord(comment.body, "triage comment").body)).toContain("Classification: Bug");

    // The LLM was called with the issue title in the user message.
    const llm = defined(
      captured.find((r) => r.url.origin === new URL(GROQ_URL).origin),
      "llm request",
    );
    const messages = asRecord(llm.body, "llm request").messages;
    if (!Array.isArray(messages)) {
      throw new Error("expected the llm request to contain messages");
    }
    expect(String(asRecord(messages[1], "llm user message").content)).toContain("Issue #1:");
  });

  test("skips triage for bot users", async () => {
    process.env.GROQ_API_KEY = "test-key";
    const { captured } = createServer();

    await webhookReceiver(probot).receive({
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

    // The triage module's failure boundary logs the provider config error;
    // the delivery still succeeds and no GitHub comment is posted.
    await expect(
      webhookReceiver(probot).receive({
        name: "issues",
        payload: issueOpenedPayload,
      }),
    ).resolves.toBeUndefined();

    const comment = captured.find((r) => r.url.pathname === "/repos/hiimbex/testing-things/issues/1/comments");
    const llm = captured.find((r) => r.url.origin === new URL(GROQ_URL).origin);
    expect(comment).toBeUndefined();
    expect(llm).toBeUndefined();
  });
});
