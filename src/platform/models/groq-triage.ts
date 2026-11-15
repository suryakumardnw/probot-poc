/**
 * Groq triage provider factory (ARCHITECTURE.md §9.2).
 *
 * Preserves the environment behavior of the legacy triage client: the API key
 * comes from `GROQ_API_KEY`, the model defaults to `llama-3.3-70b-versatile`
 * and can be overridden with `GROQ_MODEL`. The provider is built lazily on the
 * first triage call so a missing key never prevents the app (or the other
 * webhook handlers) from starting; the triage handler logs the failure.
 *
 * The concrete HTTP adapter is the reusable OpenAI-compatible provider in
 * `src/platform/models`; this factory only owns the Groq endpoint/limits
 * wiring.
 */

import type { ModelProvider } from "../../ports/model-provider.js";
import { createOpenAICompatibleProvider } from "./openai-compatible.js";

/** Groq exposes an OpenAI-compatible API under this base path. */
export const GROQ_TRIAGE_BASE_URL = "https://api.groq.com/openai/v1";
/** Model used when `GROQ_MODEL` is not set (pre-module default). */
export const GROQ_TRIAGE_DEFAULT_MODEL = "llama-3.3-70b-versatile";
export const GROQ_TRIAGE_DEFAULT_TIMEOUT_MS = 30_000;

export interface GroqTriageProviderOptions {
  /** Environment to read `GROQ_API_KEY` / `GROQ_MODEL` from (injected; no global reads). */
  env: NodeJS.ProcessEnv;
  /** Provider request timeout. Defaults to 30s so a hung request cannot pin a webhook. */
  timeoutMs?: number;
  /** Injectable fetch for tests; defaults to globalThis.fetch in the adapter. */
  fetchImpl?: typeof fetch;
}

/**
 * Create the Groq-backed model provider for triage.
 *
 * Construction is deferred until the first call: `ModelProvider` failures
 * (including a missing `GROQ_API_KEY`) surface from `chat()` and are handled by
 * the triage webhook boundary instead of aborting composition.
 */
export function createGroqTriageProvider(options: GroqTriageProviderOptions): ModelProvider {
  let provider: ModelProvider | undefined;

  function resolveProvider(): ModelProvider {
    provider ??= createOpenAICompatibleProvider(
      {
        type: "openai-compatible",
        baseURL: GROQ_TRIAGE_BASE_URL,
        apiKeyEnv: "GROQ_API_KEY",
        model: options.env.GROQ_MODEL ?? GROQ_TRIAGE_DEFAULT_MODEL,
        timeoutMs: options.timeoutMs ?? GROQ_TRIAGE_DEFAULT_TIMEOUT_MS,
        failurePolicy: "fail-immediately",
      },
      {
        env: options.env,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      },
    );
    return provider;
  }

  return {
    chat: (request) => resolveProvider().chat(request),
    healthCheck: () => resolveProvider().healthCheck(),
    getCapabilities: () => resolveProvider().getCapabilities(),
  };
}
