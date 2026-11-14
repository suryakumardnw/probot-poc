/**
 * OpenAI-compatible REST model provider adapter (ARCHITECTURE.md §9.1–§9.3).
 *
 * Talks to any OpenAI-compatible `/chat/completions` endpoint (initial
 * target: Cloudflare GLM-4.7-Flash via AI Gateway / Workers AI) using only
 * the standard `fetch` API — no model SDK dependency.
 *
 * Security:
 * - The API key is read from the environment variable *named* by
 *   `config.apiKeyEnv` (ticket 02 decision); it is never stored, logged or
 *   echoed. Request logging records URL origin, model, status and usage
 *   only — never headers, credentials or message content.
 *
 * Failure semantics (§8.4, §12.4):
 * - `failurePolicy: "fail-immediately"` (default): any provider failure
 *   throws a normalized `ModelProviderError` on the first attempt. The
 *   review fails; the provider never silently switches models.
 * - `failurePolicy: "retry-once"`: a single retry is allowed for transient
 *   failures (rate limit, network, 5xx). Still no model switching.
 */

import type {
  ModelCapabilities,
  ModelErrorCode,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ProviderHealth,
} from "./provider.js";
import { ModelProviderError, ProviderConfigError } from "./provider.js";

export { ModelProviderError, ProviderConfigError };

export interface OpenAICompatibleProviderConfig {
  type: "openai-compatible";
  /** Resolved base URL (e.g. "https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/openai"). */
  baseURL: string;
  /** Name of the env var holding the API key — never the key value itself. */
  apiKeyEnv: string;
  model: string;
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs: number;
  failurePolicy: "fail-immediately" | "retry-once";
}

export interface CreateModelProviderOptions {
  logger?: {
    debug: (obj: Record<string, unknown>, msg: string) => void;
    warn: (obj: Record<string, unknown>, msg: string) => void;
    info: (obj: Record<string, unknown>, msg: string) => void;
  };
  env?: NodeJS.ProcessEnv;
  /** Injectable fetch for tests; defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Capability overrides for endpoints whose feature set differs from the
   * conservative defaults (e.g. an AI Gateway that strips tools/streaming).
   */
  capabilities?: Partial<ModelCapabilities>;
}

// ---------------------------------------------------------------------------
// Conservative capability defaults for OpenAI-compatible gateways. Ticket 06
// must consult getCapabilities() instead of assuming streaming/tools work.
// ---------------------------------------------------------------------------
const DEFAULT_CAPABILITIES: ModelCapabilities = {
  chatCompletions: true,
  structuredOutput: "json_object",
  jsonSchema: false,
  toolCalling: false,
  streaming: false,
  usageReporting: "optional",
};

const MAX_PROVIDER_DETAIL_LENGTH = 512;

function truncateDetail(value: string): string {
  const single = value.replace(/\s+/g, " ").trim();
  return single.length > MAX_PROVIDER_DETAIL_LENGTH ? `${single.slice(0, MAX_PROVIDER_DETAIL_LENGTH)}…` : single;
}

function joinUrl(baseURL: string, path: string): string {
  return `${baseURL.replace(/\/+$/, "")}${path}`;
}

/** Secret-free endpoint label for logs: scheme + host + path, no query, no credentials. */
function endpointLabel(baseURL: string): string {
  const url = new URL(baseURL);
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

function normalizeFinishReason(raw: unknown): {
  finishReason: ModelResponse["finishReason"];
  rawFinishReason?: string;
} {
  if (typeof raw !== "string" || raw.length === 0) {
    return { finishReason: "other" };
  }
  switch (raw) {
    case "stop":
      return { finishReason: "stop", rawFinishReason: raw };
    case "length":
    case "max_tokens":
      return { finishReason: "length", rawFinishReason: raw };
    case "content_filter":
      return { finishReason: "content_filter", rawFinishReason: raw };
    case "tool_calls":
    case "function_call":
      return { finishReason: "tool_calls", rawFinishReason: raw };
    default:
      return { finishReason: "other", rawFinishReason: raw };
  }
}

function normalizeUsage(raw: unknown): ModelResponse["usage"] {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const usage = raw as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const prompt = num(usage.prompt_tokens);
  const completion = num(usage.completion_tokens);
  const total = num(usage.total_tokens);
  if (prompt === undefined && completion === undefined && total === undefined) {
    return undefined;
  }
  return { promptTokens: prompt, completionTokens: completion, totalTokens: total };
}

function extractErrorDetail(body: unknown): string | undefined {
  if (body === undefined) {
    return undefined;
  }
  if (typeof body === "string") {
    return truncateDetail(body);
  }
  if (typeof body === "object" && body !== null) {
    const record = body as Record<string, unknown>;
    const error = record.error;
    if (typeof error === "string") {
      return truncateDetail(error);
    }
    if (typeof error === "object" && error !== null) {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === "string") {
        return truncateDetail(message);
      }
    }
    if (typeof record.message === "string") {
      return truncateDetail(record.message);
    }
  }
  return undefined;
}

function statusToErrorCode(status: number): { code: ModelErrorCode; retryable: boolean; label: string } {
  if (status === 401 || status === 403) {
    return { code: "auth_failure", retryable: false, label: "authentication failed" };
  }
  if (status === 429) {
    return { code: "rate_limit", retryable: true, label: "rate limited" };
  }
  if (status === 400 || status === 422) {
    return { code: "invalid_request", retryable: false, label: "invalid request" };
  }
  if (status >= 500) {
    return { code: "provider_unavailable", retryable: true, label: "provider unavailable" };
  }
  return { code: "unknown", retryable: false, label: `unexpected HTTP status ${status}` };
}

/** No-op logger used when none is supplied. */
const silentLogger = {
  debug: () => undefined,
  warn: () => undefined,
  info: () => undefined,
};

/** Chat-completions response body, minimally typed. */
interface ChatCompletionPayload {
  id?: unknown;
  model?: unknown;
  choices?: unknown;
  usage?: unknown;
  error?: unknown;
  message?: unknown;
}

/**
 * Create an OpenAI-compatible model provider.
 *
 * The API key is resolved once from `env[config.apiKeyEnv]`; a missing
 * variable throws `ProviderConfigError` at construction time (fail fast,
 * before any review work starts).
 */
export function createOpenAICompatibleProvider(
  config: OpenAICompatibleProviderConfig,
  options: CreateModelProviderOptions = {},
): ModelProvider {
  if (config.type !== "openai-compatible") {
    throw new ProviderConfigError(`Unsupported provider type: ${String(config.type)}`);
  }
  const env = options.env ?? process.env;
  const apiKey = env[config.apiKeyEnv];
  if (!apiKey) {
    throw new ProviderConfigError(
      `Provider API key is missing: environment variable '${config.apiKeyEnv}' is not set. ` +
        `Secrets are only ever read from the environment, never from configuration files.`,
    );
  }
  let endpoint: string;
  try {
    const parsedUrl = new URL(config.baseURL);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error("not http(s)");
    }
    endpoint = endpointLabel(config.baseURL);
  } catch {
    throw new ProviderConfigError(`Provider baseURL must be an http(s) URL, got: ${config.baseURL}`);
  }

  const logger = options.logger ?? silentLogger;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const capabilities: ModelCapabilities = { ...DEFAULT_CAPABILITIES, ...(options.capabilities ?? {}) };

  async function readBody(response: Response): Promise<unknown> {
    const text = await response.text();
    if (text.length === 0) {
      return undefined;
    }
    try {
      return JSON.parse(text) as ChatCompletionPayload;
    } catch {
      // Non-JSON body: carried as a plain string for classification below.
      return text;
    }
  }

  async function attemptChat(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    const started = Date.now();
    const model = request.model ?? config.model;
    const wantsJson = request.responseFormat === "json";

    if (wantsJson && !capabilities.structuredOutput) {
      throw new ModelProviderError(
        "invalid_request",
        "Provider does not support structured output (responseFormat 'json') per its declared capabilities",
      );
    }

    const body: Record<string, unknown> = {
      model,
      messages: request.messages,
      temperature: request.temperature ?? config.temperature,
      max_tokens: request.maxOutputTokens ?? config.maxOutputTokens,
      stream: false,
    };
    if (wantsJson) {
      body.response_format = { type: "json_object" };
    }

    logger.debug(
      { event: "model_request", endpoint, model, messages: request.messages.length, wantsJson },
      "Sending model request",
    );

    let response: Response;
    try {
      response = await fetchImpl(joinUrl(config.baseURL, "/chat/completions"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (signal.aborted && (error as Error)?.name === "TimeoutError") {
        throw new ModelProviderError("timeout", `Model request timed out after ${config.timeoutMs}ms`, {
          cause: error,
        });
      }
      if (signal.aborted) {
        throw new ModelProviderError("network", "Model request aborted by the caller", {
          cause: error,
          retryable: false,
        });
      }
      throw new ModelProviderError("network", `Model request failed: ${truncateDetail((error as Error).message)}`, {
        cause: error,
      });
    }

    const latencyMs = Date.now() - started;
    const payload = await readBody(response);

    if (!response.ok) {
      const classified = statusToErrorCode(response.status);
      const detail = extractErrorDetail(payload);
      logger.warn(
        { event: "model_failure", endpoint, model, status: response.status, code: classified.code, latencyMs },
        "Model request failed",
      );
      throw new ModelProviderError(
        classified.code,
        `Model request failed: ${classified.label} (HTTP ${response.status})`,
        {
          statusCode: response.status,
          retryable: classified.retryable,
          providerDetail: detail,
        },
      );
    }

    // --- Structured response parsing / normalization -----------------------
    if (typeof payload === "string" || payload === undefined || typeof payload !== "object") {
      throw new ModelProviderError(
        typeof payload === "string" ? "invalid_json" : "unexpected_format",
        typeof payload === "string"
          ? "Provider returned a non-JSON response body"
          : "Provider returned an empty or malformed response body",
        { statusCode: response.status },
      );
    }

    const parsed = payload as ChatCompletionPayload;
    if (!Array.isArray(parsed.choices) || parsed.choices.length === 0) {
      throw new ModelProviderError("unexpected_format", "Provider response has no choices array", {
        statusCode: response.status,
      });
    }
    const first = parsed.choices[0] as Record<string, unknown>;
    const message = (typeof first.message === "object" && first.message !== null ? first.message : {}) as Record<
      string,
      unknown
    >;
    const rawContent = typeof message.content === "string" ? message.content : undefined;
    // Reasoning models (e.g. GLM-4.7-Flash) put chain-of-thought in
    // `reasoning_content`/`reasoning` and may return `content: null` when the
    // token budget was exhausted mid-thought (finish_reason "length").
    const reasoning =
      typeof message.reasoning_content === "string" && message.reasoning_content.length > 0
        ? message.reasoning_content
        : typeof message.reasoning === "string" && message.reasoning.length > 0
          ? message.reasoning
          : undefined;
    const content = rawContent !== undefined && rawContent.length > 0 ? rawContent : reasoning;
    if (content === undefined) {
      throw new ModelProviderError("unexpected_format", "Provider response is missing assistant message content", {
        statusCode: response.status,
      });
    }

    const { finishReason, rawFinishReason } = normalizeFinishReason(first.finish_reason);
    const usage = normalizeUsage(parsed.usage);
    if (!usage && (capabilities.usageReporting === "always" || request.requireUsage === true)) {
      throw new ModelProviderError("missing_usage", "Provider did not report token usage metadata", {
        statusCode: response.status,
      });
    }
    if (!usage) {
      logger.warn(
        { event: "model_usage_missing", endpoint, model },
        "Provider response did not include usage metadata; token accounting unavailable",
      );
    }

    let json: unknown;
    if (wantsJson) {
      try {
        json = JSON.parse(content);
      } catch (error) {
        throw new ModelProviderError("invalid_json", "Provider content is not valid JSON but JSON was requested", {
          statusCode: response.status,
          cause: error,
        });
      }
    }

    const modelResponse: ModelResponse = {
      content,
      ...(json !== undefined ? { json } : {}),
      ...(reasoning ? { reasoning } : {}),
      finishReason,
      ...(rawFinishReason ? { rawFinishReason } : {}),
      ...(typeof parsed.model === "string" ? { model: parsed.model } : { model }),
      ...(typeof parsed.id === "string" ? { id: parsed.id } : {}),
      ...(usage ? { usage } : {}),
      latencyMs,
    };
    logger.info(
      {
        event: "model_response",
        endpoint,
        model: modelResponse.model,
        status: response.status,
        latencyMs,
        finishReason,
        usage: usage
          ? {
              promptTokens: usage.promptTokens,
              completionTokens: usage.completionTokens,
              totalTokens: usage.totalTokens,
            }
          : undefined,
        contentBytes: Buffer.byteLength(content, "utf8"),
      },
      "Model request completed",
    );
    return modelResponse;
  }

  async function chat(request: ModelRequest): Promise<ModelResponse> {
    const timeoutSignal = AbortSignal.timeout(config.timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeoutSignal]) : timeoutSignal;

    try {
      return await attemptChat(request, signal);
    } catch (error) {
      const mayRetry =
        config.failurePolicy === "retry-once" &&
        error instanceof ModelProviderError &&
        error.retryable &&
        !(request.signal?.aborted ?? false);
      if (!mayRetry) {
        throw error;
      }
      logger.warn(
        { event: "model_retry", endpoint, code: error.code, policy: config.failurePolicy },
        "Transient model failure; performing the single configured retry",
      );
      const retrySignal = request.signal
        ? AbortSignal.any([request.signal, AbortSignal.timeout(config.timeoutMs)])
        : AbortSignal.timeout(config.timeoutMs);
      return attemptChat(request, retrySignal);
    }
  }

  async function healthCheck(): Promise<ProviderHealth> {
    const started = Date.now();
    try {
      const response = await fetchImpl(joinUrl(config.baseURL, "/models"), {
        method: "GET",
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(Math.min(config.timeoutMs, 10_000)),
      });
      const latencyMs = Date.now() - started;
      // 401/403 mean the endpoint is up but credentials are bad: unhealthy.
      // 404/405 mean the endpoint is up but /models is unsupported: healthy
      // with a caveat — chat/completions is the actual contract.
      if (response.status === 401 || response.status === 403) {
        return {
          healthy: false,
          latencyMs,
          detail: `endpoint reachable but authentication failed (HTTP ${response.status})`,
          checkedAt: new Date().toISOString(),
        };
      }
      const caveat =
        response.status === 404 || response.status === 405 ? " (/models not supported; chat/completions assumed)" : "";
      return {
        healthy: true,
        latencyMs,
        detail: `endpoint reachable (HTTP ${response.status})${caveat}`,
        checkedAt: new Date().toISOString(),
      };
    } catch (error) {
      const latencyMs = Date.now() - started;
      const name = (error as Error)?.name;
      return {
        healthy: false,
        latencyMs,
        detail:
          name === "TimeoutError"
            ? "health probe timed out"
            : `endpoint unreachable: ${truncateDetail((error as Error).message)}`,
        checkedAt: new Date().toISOString(),
      };
    }
  }

  async function getCapabilities(): Promise<ModelCapabilities> {
    return { ...capabilities };
  }

  return { chat, healthCheck, getCapabilities };
}

/**
 * Build a provider from the effective review configuration
 * (`config.provider`, ticket 02). The API key is read from the env var
 * named by `provider.apiKeyEnv` — never from configuration values.
 */
export function createModelProviderFromConfig(
  provider: OpenAICompatibleProviderConfig,
  logger?: CreateModelProviderOptions["logger"],
  env: NodeJS.ProcessEnv = process.env,
): ModelProvider {
  return createOpenAICompatibleProvider(provider, { logger, env });
}
