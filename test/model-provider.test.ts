import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { logRedactPaths } from "../src/platform/logger.js";
import {
  createModelProviderFromConfig,
  createOpenAICompatibleProvider,
} from "../src/platform/models/openai-compatible.js";
import { ProviderConfigError } from "../src/platform/models/provider-config-error.js";
import type { ModelCapabilities, ProviderHealth } from "../src/ports/model-provider.js";
import { ModelProviderError } from "../src/shared/errors/index.js";

// ---------------------------------------------------------------------------
// Mock HTTP server (no external network — all failure/success modes are
// exercised against a local node:http server per the ticket's test rules).
// ---------------------------------------------------------------------------

interface RecordedRequest {
  method: string;
  url: string | undefined;
  authorization: string | undefined;
  body: unknown;
}

type Handler = (req: IncomingMessage, res: ServerResponse, body: unknown) => void;

function makeServer(handler: Handler): Promise<{ server: Server; url: string; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = undefined;
      try {
        body = raw.length > 0 ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      requests.push({
        method: req.method ?? "",
        url: req.url,
        authorization: req.headers.authorization,
        body,
      });
      handler(req, res, body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}/v1`, requests });
    });
  });
}

const completionBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "chatcmpl-123",
  model: "glm-4.7-flash",
  choices: [
    {
      index: 0,
      finish_reason: "stop",
      message: { role: "assistant", content: "pong" },
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  ...overrides,
});

function providerConfig(url: string, overrides: Record<string, unknown> = {}) {
  return {
    type: "openai-compatible" as const,
    baseURL: url,
    apiKeyEnv: "TEST_PROVIDER_API_KEY",
    model: "glm-4.7-flash",
    temperature: 0.1,
    maxOutputTokens: 256,
    timeoutMs: 2_000,
    failurePolicy: "fail-immediately" as const,
    ...overrides,
  };
}

const ENV_WITH_KEY = { TEST_PROVIDER_API_KEY: "test-key-value-xyz" };

const baseMessage = [{ role: "user" as const, content: "ping" }];

describe("OpenAI-compatible model provider", () => {
  let servers: Server[] = [];

  beforeEach(() => {
    servers = [];
  });

  afterEach(async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  async function start(handler: Handler) {
    const started = await makeServer(handler);
    servers.push(started.server);
    return started;
  }

  // -- Construction & credentials ------------------------------------------

  it("throws ProviderConfigError when the apiKeyEnv variable is missing", async () => {
    expect(() => createOpenAICompatibleProvider(providerConfig("http://127.0.0.1:1"), { env: {} })).toThrow(
      ProviderConfigError,
    );
  });

  it("reads the API key from the env var named by apiKeyEnv, never from config values", async () => {
    const { url, requests } = await start((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(completionBody()));
    });
    const provider = createOpenAICompatibleProvider(providerConfig(url), { env: ENV_WITH_KEY });
    await provider.chat({ messages: baseMessage });
    expect(requests).toHaveLength(1);
    expect(requests[0].authorization).toBe("Bearer test-key-value-xyz");
    expect(requests[0].url).toBe("/v1/chat/completions");
  });

  it("rejects non-http baseURLs at construction", () => {
    expect(() => createOpenAICompatibleProvider(providerConfig("ftp://example.com"), { env: ENV_WITH_KEY })).toThrow(
      ProviderConfigError,
    );
  });

  // -- Successful completion, usage capture, structured parsing ------------

  it("returns a normalized response with token usage and finish reason", async () => {
    const { url, requests } = await start((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(completionBody()));
    });
    const provider = createOpenAICompatibleProvider(providerConfig(url), { env: ENV_WITH_KEY });
    const response = await provider.chat({ messages: baseMessage });
    expect(response.content).toBe("pong");
    expect(response.finishReason).toBe("stop");
    expect(response.model).toBe("glm-4.7-flash");
    expect(response.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    expect(response.latencyMs).toBeGreaterThanOrEqual(0);
    // Request shape normalization: model, stream:false, max_tokens.
    const sent = requests[0].body as Record<string, unknown>;
    expect(sent.model).toBe("glm-4.7-flash");
    expect(sent.stream).toBe(false);
    expect(sent.max_tokens).toBe(256);
    expect(sent.response_format).toBeUndefined();
  });

  it("normalizes non-standard finish reasons", async () => {
    const { url } = await start((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(completionBody({ choices: [{ finish_reason: "max_tokens", message: { content: "cut" } }] })),
      );
    });
    const provider = createOpenAICompatibleProvider(providerConfig(url), { env: ENV_WITH_KEY });
    const response = await provider.chat({ messages: baseMessage });
    expect(response.finishReason).toBe("length");
    expect(response.rawFinishReason).toBe("max_tokens");
  });

  it("parses structured JSON output when responseFormat is json", async () => {
    const { url, requests } = await start((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          completionBody({ choices: [{ finish_reason: "stop", message: { content: '{"verdict":"ok"}' } }] }),
        ),
      );
    });
    const provider = createOpenAICompatibleProvider(providerConfig(url), { env: ENV_WITH_KEY });
    const response = await provider.chat({ messages: baseMessage, responseFormat: "json" });
    expect(response.json).toEqual({ verdict: "ok" });
    expect((requests[0].body as Record<string, unknown>).response_format).toEqual({ type: "json_object" });
  });

  it("falls back to reasoning_content when content is empty (reasoning models)", async () => {
    const { url } = await start((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            { finish_reason: "stop", message: { content: null, reasoning_content: "final answer from reasoning" } },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
        }),
      );
    });
    const provider = createOpenAICompatibleProvider(providerConfig(url), { env: ENV_WITH_KEY });
    const response = await provider.chat({ messages: baseMessage });
    expect(response.content).toBe("final answer from reasoning");
    expect(response.reasoning).toBe("final answer from reasoning");
  });

  it("tolerates missing usage metadata by default and warns", async () => {
    const warnings: string[] = [];
    const { url } = await start((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "x", choices: [{ finish_reason: "stop", message: { content: "hi" } }] }));
    });
    const provider = createOpenAICompatibleProvider(providerConfig(url), {
      env: ENV_WITH_KEY,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: (obj) => warnings.push(JSON.stringify(obj)),
      },
    });
    const response = await provider.chat({ messages: baseMessage });
    expect(response.content).toBe("hi");
    expect(response.usage).toBeUndefined();
    expect(warnings.join("\n")).toContain("model_usage_missing");
  });

  it("fails with missing_usage when the caller requires usage metadata", async () => {
    const { url } = await start((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "x", choices: [{ finish_reason: "stop", message: { content: "hi" } }] }));
    });
    const provider = createOpenAICompatibleProvider(providerConfig(url), { env: ENV_WITH_KEY });
    await expect(provider.chat({ messages: baseMessage, requireUsage: true })).rejects.toMatchObject({
      code: "missing_usage",
    });
  });

  // -- Error normalization ---------------------------------------------------

  it("normalizes authentication failures (401)", async () => {
    const { url } = await start((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid api key" } }));
    });
    const provider = createOpenAICompatibleProvider(providerConfig(url), { env: ENV_WITH_KEY });
    const error = await provider.chat({ messages: baseMessage }).catch((e) => e);
    expect(error).toBeInstanceOf(ModelProviderError);
    expect(error.code).toBe("auth_failure");
    expect(error.statusCode).toBe(401);
    expect(error.retryable).toBe(false);
  });

  it("normalizes rate limiting (429) and does not retry under fail-immediately", async () => {
    let attempts = 0;
    const { url, requests } = await start((_req, res) => {
      attempts += 1;
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "slow down" } }));
    });
    const provider = createOpenAICompatibleProvider(providerConfig(url), { env: ENV_WITH_KEY });
    await expect(provider.chat({ messages: baseMessage })).rejects.toMatchObject({ code: "rate_limit" });
    expect(attempts).toBe(1);
    expect(requests).toHaveLength(1);
  });

  it("normalizes provider outages (5xx) as provider_unavailable", async () => {
    const { url } = await start((_req, res) => {
      res.writeHead(503, { "content-type": "text/plain" });
      res.end("upstream unavailable");
    });
    const provider = createOpenAICompatibleProvider(providerConfig(url), { env: ENV_WITH_KEY });
    const error = await provider.chat({ messages: baseMessage }).catch((e) => e);
    expect(error.code).toBe("provider_unavailable");
    expect(error.retryable).toBe(true);
    expect(error.providerDetail).toContain("upstream unavailable");
  });

  it("normalizes connection failures as network errors (provider unreachable → fail immediately)", async () => {
    // Find a port with no listener: start, capture, then stop.
    const { server, url } = await start((_req, res) => res.end());
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const provider = createOpenAICompatibleProvider(providerConfig(url), { env: ENV_WITH_KEY });
    const error = await provider.chat({ messages: baseMessage }).catch((e) => e);
    expect(error).toBeInstanceOf(ModelProviderError);
    expect(error.code).toBe("network");
    expect(error.retryable).toBe(true);
  });

  it("enforces timeoutMs and normalizes timeouts", async () => {
    const { url } = await start((_req, res) => {
      // Never respond; the adapter must time out well before the test timeout.
      const timer = setTimeout(() => res.end(), 5_000);
      res.on("close", () => clearTimeout(timer));
    });
    const provider = createOpenAICompatibleProvider(providerConfig(url, { timeoutMs: 150 }), { env: ENV_WITH_KEY });
    const error = await provider.chat({ messages: baseMessage }).catch((e) => e);
    expect(error.code).toBe("timeout");
  });

  it("rejects non-JSON success bodies as invalid_json", async () => {
    const { url } = await start((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>not json</html>");
    });
    const provider = createOpenAICompatibleProvider(providerConfig(url), { env: ENV_WITH_KEY });
    await expect(provider.chat({ messages: baseMessage })).rejects.toMatchObject({ code: "invalid_json" });
  });

  it("rejects unexpected response shapes (no choices / no content)", async () => {
    const { url } = await start((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "x", data: "unexpected" }));
    });
    const provider = createOpenAICompatibleProvider(providerConfig(url), { env: ENV_WITH_KEY });
    await expect(provider.chat({ messages: baseMessage })).rejects.toMatchObject({ code: "unexpected_format" });
  });

  it("rejects structurally malformed choices as unexpected_format instead of crashing", async () => {
    const { url } = await start((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "x", choices: [null] }));
    });
    const provider = createOpenAICompatibleProvider(providerConfig(url), { env: ENV_WITH_KEY });
    const error = await provider.chat({ messages: baseMessage }).catch((cause) => cause);
    expect(error).toBeInstanceOf(ModelProviderError);
    expect(error.code).toBe("unexpected_format");
    expect(error.providerDetail).toContain("choices");
  });

  it("rejects JSON output that does not parse as invalid_json", async () => {
    const { url } = await start((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(completionBody({ choices: [{ finish_reason: "stop", message: { content: "{nope" } }] })));
    });
    const provider = createOpenAICompatibleProvider(providerConfig(url), { env: ENV_WITH_KEY });
    await expect(provider.chat({ messages: baseMessage, responseFormat: "json" })).rejects.toMatchObject({
      code: "invalid_json",
    });
  });

  it("refuses structured output when the provider lacks the capability", async () => {
    const { url } = await start(() => undefined);
    const provider = createOpenAICompatibleProvider(providerConfig(url), {
      env: ENV_WITH_KEY,
      capabilities: { structuredOutput: false },
    });
    await expect(provider.chat({ messages: baseMessage, responseFormat: "json" })).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  // -- Retry policy ----------------------------------------------------------

  it("retry-once performs exactly one retry for transient failures and succeeds", async () => {
    let attempts = 0;
    const { url, requests } = await start((_req, res) => {
      attempts += 1;
      if (attempts === 1) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "warming up" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(completionBody()));
    });
    const provider = createOpenAICompatibleProvider(providerConfig(url, { failurePolicy: "retry-once" }), {
      env: ENV_WITH_KEY,
    });
    const response = await provider.chat({ messages: baseMessage });
    expect(response.content).toBe("pong");
    expect(attempts).toBe(2);
    expect(requests).toHaveLength(2);
  });

  it("retry-once gives up after the single retry on persistent failures", async () => {
    let attempts = 0;
    const { url } = await start((_req, res) => {
      attempts += 1;
      res.writeHead(500, { "content-type": "application/json" });
      res.end("{}");
    });
    const provider = createOpenAICompatibleProvider(providerConfig(url, { failurePolicy: "retry-once" }), {
      env: ENV_WITH_KEY,
    });
    await expect(provider.chat({ messages: baseMessage })).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(attempts).toBe(2);
  });

  it("retry-once never retries non-retryable failures (auth)", async () => {
    let attempts = 0;
    const { url } = await start((_req, res) => {
      attempts += 1;
      res.writeHead(403, { "content-type": "application/json" });
      res.end("{}");
    });
    const provider = createOpenAICompatibleProvider(providerConfig(url, { failurePolicy: "retry-once" }), {
      env: ENV_WITH_KEY,
    });
    await expect(provider.chat({ messages: baseMessage })).rejects.toMatchObject({ code: "auth_failure" });
    expect(attempts).toBe(1);
  });

  // -- Health & capabilities ---------------------------------------------------

  it("healthCheck reports healthy for a reachable endpoint", async () => {
    const { url, requests } = await start((req, res) => {
      if ((req.url ?? "").endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const provider = createOpenAICompatibleProvider(providerConfig(url), { env: ENV_WITH_KEY });
    const health: ProviderHealth = await provider.healthCheck();
    expect(health.healthy).toBe(true);
    expect(typeof health.latencyMs).toBe("number");
    expect(health.checkedAt).toBeTruthy();
    expect(requests[0].authorization).toBe("Bearer test-key-value-xyz");
  });

  it("healthCheck treats auth failures as unhealthy and missing /models as reachable", async () => {
    const { url } = await start((req, res) => {
      if ((req.url ?? "").endsWith("/models")) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const provider = createOpenAICompatibleProvider(providerConfig(url), { env: ENV_WITH_KEY });
    const unhealthy = await provider.healthCheck();
    expect(unhealthy.healthy).toBe(false);
    expect(unhealthy.detail).toContain("authentication failed");
  });

  it("healthCheck reports unreachable endpoints as unhealthy", async () => {
    const { server, url } = await start((_req, res) => res.end());
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const provider = createOpenAICompatibleProvider(providerConfig(url), { env: ENV_WITH_KEY });
    const health = await provider.healthCheck();
    expect(health.healthy).toBe(false);
    expect(health.detail).toContain("unreachable");
  });

  it("declares conservative capabilities and honors overrides", async () => {
    const { url } = await start(() => undefined);
    const provider = createOpenAICompatibleProvider(providerConfig(url), { env: ENV_WITH_KEY });
    const caps: ModelCapabilities = await provider.getCapabilities();
    expect(caps.chatCompletions).toBe(true);
    expect(caps.structuredOutput).toBe("json_object");
    expect(caps.toolCalling).toBe(false);
    expect(caps.streaming).toBe(false);
    expect(caps.usageReporting).toBe("optional");

    const patched = createOpenAICompatibleProvider(providerConfig(url), {
      env: ENV_WITH_KEY,
      capabilities: { toolCalling: true },
    });
    expect((await patched.getCapabilities()).toolCalling).toBe(true);
  });

  // -- Redacted logging --------------------------------------------------------

  it("never logs the API key or message content", async () => {
    const secretKey = "SUPERSECRET-KEY-DO-NOT-LOG";
    const lines: string[] = [];
    const logger = {
      debug: (obj: Record<string, unknown>) => lines.push(JSON.stringify(obj)),
      info: (obj: Record<string, unknown>) => lines.push(JSON.stringify(obj)),
      warn: (obj: Record<string, unknown>) => lines.push(JSON.stringify(obj)),
    };
    const { url } = await start((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(completionBody()));
    });
    const provider = createOpenAICompatibleProvider(providerConfig(url), {
      env: { TEST_PROVIDER_API_KEY: secretKey },
      logger,
    });
    await provider.chat({ messages: [{ role: "user", content: "classified-code-content" }], model: "m" });
    const output = lines.join("\n");
    expect(output).not.toContain(secretKey);
    expect(output).not.toContain("classified-code-content");
    // Structured, secret-free fields are present.
    expect(output).toContain("model_response");
    expect(output).toContain("totalTokens");
  });

  it("pino's redact paths defensively cover apiKey fields", () => {
    expect(logRedactPaths).toContain("apiKey");
    expect(logRedactPaths).toContain("authorization");
  });

  // -- Config integration ------------------------------------------------------

  it("createModelProviderFromConfig builds a provider from review-config provider section", async () => {
    const { url } = await start((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(completionBody()));
    });
    const provider = createModelProviderFromConfig(providerConfig(url), undefined, ENV_WITH_KEY);
    const response = await provider.chat({ messages: baseMessage });
    expect(response.content).toBe("pong");
  });
});
