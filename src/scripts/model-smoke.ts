/**
 * Real-endpoint smoke test for the model provider (ticket 05 completion
 * evidence). Makes ONE small chat-completions request against the endpoint
 * configured via environment variables and prints a redacted report.
 *
 * Environment:
 *   MODEL_BASE_URL   — OpenAI-compatible base URL (optional)
 *   MODEL_API_KEY    — API key for that endpoint (optional)
 *   GROQ_API_KEY     — fallback provider (Groq is OpenAI-compatible); used
 *                      together with GROQ_MODEL when MODEL_* are not set.
 *   SMOKE_MODEL      — optional model override
 *
 * Usage: npm run build && npm run model:smoke
 *
 * Secrets are never printed: the report contains only endpoint origin,
 * model name, HTTP status, finish reason, latency and token usage.
 */

import "dotenv/config";
import { loadEnv } from "../config/env.js";
import { createLogger } from "../lib/logger.js";
import { ProviderConfigError } from "../platform/models/index.js";
import { createOpenAICompatibleProvider } from "../platform/models/openai-compatible.js";
import { ModelProviderError } from "../shared/errors/index.js";

interface SmokeTarget {
  provider: "configured" | "groq";
  baseURL: string;
  apiKeyEnv: string;
  model: string;
}

function resolveTarget(): SmokeTarget {
  const baseURL = process.env.MODEL_BASE_URL;
  const apiKeyEnv = process.env.MODEL_API_KEY ? "MODEL_API_KEY" : undefined;
  if (baseURL && apiKeyEnv) {
    const model = process.env.SMOKE_MODEL ?? process.env.MODEL_NAME ?? process.env.MODEL_MODEL ?? "glm-4.7-flash";
    return { provider: "configured", baseURL, apiKeyEnv, model };
  }
  if (process.env.GROQ_API_KEY) {
    return {
      provider: "groq",
      baseURL: "https://api.groq.com/openai/v1",
      apiKeyEnv: "GROQ_API_KEY",
      model: process.env.SMOKE_MODEL ?? process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile",
    };
  }
  throw new ProviderConfigError(
    "No smoke-test credentials found. Set MODEL_BASE_URL + MODEL_API_KEY (+ SMOKE_MODEL), " +
      "or GROQ_API_KEY (+ GROQ_MODEL), then re-run: npm run model:smoke",
  );
}

async function main(): Promise<void> {
  loadEnv();
  const target = resolveTarget();
  const provider = createOpenAICompatibleProvider(
    {
      type: "openai-compatible",
      baseURL: target.baseURL,
      apiKeyEnv: target.apiKeyEnv,
      model: target.model,
      temperature: 0,
      maxOutputTokens: 1_000,
      timeoutMs: 30_000,
      failurePolicy: "fail-immediately",
    },
    { logger: createLogger(loadEnv()).child({ component: "model-smoke" }) },
  );

  console.log(
    JSON.stringify({
      smoke: "start",
      providerKind: target.provider,
      endpointOrigin: new URL(target.baseURL).host,
      model: target.model,
      // Never print the key or the full URL with credentials.
    }),
  );

  try {
    const health = await provider.healthCheck();
    console.log(
      JSON.stringify({ smoke: "health", healthy: health.healthy, detail: health.detail, latencyMs: health.latencyMs }),
    );

    const response = await provider.chat({
      messages: [
        { role: "system", content: "Reply with exactly one word." },
        { role: "user", content: "Say the word: pong" },
      ],
      responseFormat: "json",
      maxOutputTokens: 1_000,
    });
    console.log(
      JSON.stringify({
        smoke: "chat",
        finishReason: response.finishReason,
        latencyMs: response.latencyMs,
        usage: response.usage ?? "(not reported)",
        contentPreview: response.content.slice(0, 120),
        json: response.json,
      }),
    );
    console.log(JSON.stringify({ smoke: "result", ok: true }));
  } catch (error) {
    if (error instanceof ModelProviderError) {
      console.log(
        JSON.stringify({
          smoke: "result",
          ok: false,
          code: error.code,
          // PR 3.9: ModelProviderError extends AppError, whose contract requires
          // a numeric statusCode. Programmatic failures (no upstream response)
          // therefore report the shared default (502/503) instead of the old
          // `null`; HTTP failures still report the real upstream status.
          statusCode: error.statusCode,
          providerDetail: error.providerDetail ?? null,
        }),
      );
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ smoke: "fatal", error: (error as Error).message }));
  process.exitCode = 1;
});
