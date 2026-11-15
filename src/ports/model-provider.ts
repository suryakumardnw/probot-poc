/**
 * Model provider port (ARCHITECTURE.md §9.2).
 *
 * The application never depends on a specific model SDK: tickets 06/07 talk
 * to the model exclusively through the `ModelProvider` interface defined
 * here. The concrete adapter is the OpenAI-compatible REST adapter in
 * `src/platform/models/openai-compatible.ts`.
 *
 * Failure semantics (§8.4, §12.4): when the provider is unavailable, the
 * adapter throws a normalized `ModelProviderError` from `src/shared/errors/`.
 * There is no automatic model switching and no unbounded retrying — reviews
 * fail immediately (`provider.failurePolicy: "fail-immediately"`) unless the
 * configuration explicitly opts into a single retry (`"retry-once"`).
 */

// ---------------------------------------------------------------------------
// Requests / responses
// ---------------------------------------------------------------------------

export interface ModelMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ModelRequest {
  messages: ModelMessage[];
  /** Overrides the configured default model identifier for this call. */
  model?: string;
  temperature?: number;
  maxOutputTokens?: number;
  /**
   * "json" asks the provider for a JSON-only response and validates that the
   * content parses. Requires the adapter's `structuredOutput` capability.
   */
  responseFormat?: "text" | "json";
  /**
   * Fail the call when the provider omits usage metadata (§9.4 quality
   * evaluation needs token accounting). Default: usage is optional.
   */
  requireUsage?: boolean;
  /** Caller-side cancellation (e.g. graceful shutdown). */
  signal?: AbortSignal;
}

/** Token usage as reported by the provider (absent when not provided). */
export interface ModelUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export type ModelFinishReason = "stop" | "length" | "content_filter" | "tool_calls" | "other";

export interface ModelResponse {
  /** Assistant message content. For `responseFormat: "json"` this is parsed. */
  content: string;
  /** Parsed JSON when the caller requested `responseFormat: "json"`. */
  json?: unknown;
  /** Chain-of-thought emitted by reasoning models (e.g. GLM-4.7-Flash), when provided. */
  reasoning?: string;
  finishReason: ModelFinishReason;
  /** Provider's original finish-reason string, when present. */
  rawFinishReason?: string;
  model?: string;
  /** Provider response/chat id, when present. */
  id?: string;
  usage?: ModelUsage;
  latencyMs: number;
}

// ---------------------------------------------------------------------------
// Health & capabilities
// ---------------------------------------------------------------------------

export interface ProviderHealth {
  healthy: boolean;
  latencyMs?: number;
  /** Human-readable, secret-free detail (HTTP status class, error class). */
  detail?: string;
  checkedAt: string;
}

/**
 * Explicit feature matrix for the agent runtime (ticket 06). Adapters must
 * declare conservative values: an OpenAI-compatible endpoint accepting a
 * request does not guarantee it implements every feature identically (§9.2).
 */
export interface ModelCapabilities {
  chatCompletions: boolean;
  /** Structured output flavor, or false when unsupported. */
  structuredOutput: "json_object" | false;
  /** Native JSON-schema-constrained output. */
  jsonSchema: boolean;
  /** OpenAI-style tool/function calling. */
  toolCalling: boolean;
  /** Server-sent streaming responses. */
  streaming: boolean;
  /** Usage metadata: always reported / best-effort / never reported. */
  usageReporting: "always" | "optional" | "absent";
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface ModelProvider {
  /** One chat completion. Throws `ModelProviderError` on any failure. */
  chat(request: ModelRequest): Promise<ModelResponse>;
  /** Liveness/reachability probe of the configured endpoint. */
  healthCheck(): Promise<ProviderHealth>;
  /** Explicit capability declaration for this provider configuration. */
  getCapabilities(): Promise<ModelCapabilities>;
}
