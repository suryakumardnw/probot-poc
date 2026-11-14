import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { Probot, ProbotOctokit } from "probot";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import myProbotApp from "../../src/index.js";

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

function issuePayload(overrides: { userType?: string } = {}) {
  return {
    action: "opened",
    installation: { id: 2 },
    repository: {
      name: "widget",
      full_name: "octo-org/widget",
      owner: { login: "octo-org" },
    },
    issue: {
      number: 5,
      title: "Crash on startup",
      body: "The app crashes immediately after install.",
      state: "open",
      user: { type: overrides.userType ?? "User", login: "reporter" },
    },
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
  probot.load(myProbotApp);
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
});

describe("issues.opened triage", () => {
  test("posts the rendered triage comment for a human-authored issue", async () => {
    const probot = makeProbot(pino({ level: "silent" }));
    await probot.receive({ name: "issues", payload: issuePayload() });
    await probot.teardown?.();

    const providerCall = captured.find((request) => request.url.origin === new URL(GROQ_URL).origin);
    expect(providerCall).toBeDefined();
    expect(providerCall!.body.messages[1].content).toContain("Issue #5:");
    expect(providerCall!.body.messages[1].content).toContain("Crash on startup");

    const posts = commentPosts();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body.body).toContain("🤖 **AI Triage**");
    expect(posts[0]!.body.body).toContain("Classification: Bug");
    expect(posts[0]!.body.body).toContain("human review still required");
  });

  test("bot-authored issues are skipped without calling the provider", async () => {
    const probot = makeProbot(pino({ level: "silent" }));
    await probot.receive({ name: "issues", payload: issuePayload({ userType: "Bot" }) });
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

    expect(captured.some((request) => request.url.origin === new URL(GROQ_URL).origin)).toBe(true);
    expect(commentPosts()).toHaveLength(0);
    expect(logs.join("")).toContain("AI issue triage failed");
  });
});
