/**
 * Minimal structural types for the `@opencode/sdk` host surface used by the
 * Phase 2a SDK runtime adapter (docs/architecture-sdk-runtime.md §12).
 *
 * IMPORTANT: `@opencode/sdk` cannot be imported on Node 20.18 / 22.14 (its
 * `@opencode/util` dependency uses `await using`). It is a devDependency only
 * and is loaded through a dynamic import with a variable specifier behind an
 * injectable loader. These local interfaces keep `tsc` independent of the SDK
 * package and deliberately model only the APIs the adapter calls.
 */

/** One session row as returned by `host.sessions.create/get`. */
export interface SdkSessionRow {
  id: string;
  /** Epoch-ms timestamps; `idle` marks the end of the last turn. */
  time?: {
    created?: number;
    updated?: number;
    idle?: number;
  };
  /** Terminal outcome of the last turn, e.g. "failed". */
  outcome?: string;
  /** Extra fields are ignored by the adapter. */
  [key: string]: unknown;
}

/** Best-effort token usage shape found on messages/parts. */
export interface SdkUsage {
  input?: number;
  output?: number;
  reasoning?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  [key: string]: unknown;
}

/** A content part inside an assistant message. */
export interface SdkMessagePart {
  type?: string;
  text?: string;
  usage?: SdkUsage;
  tokens?: SdkUsage | { usage?: SdkUsage };
  [key: string]: unknown;
}

/** A message returned by `host.message.list`. */
export interface SdkMessage {
  type?: string;
  content?: SdkMessagePart[];
  usage?: SdkUsage;
  tokens?: SdkUsage | { usage?: SdkUsage };
  [key: string]: unknown;
}

export interface SdkMessageListResult {
  data?: SdkMessage[];
  [key: string]: unknown;
}

export interface SdkCreateSessionInput {
  location: { directory: string };
  metadata?: Record<string, unknown>;
  title?: string;
  model?: { id: string; providerID: string };
}

export interface SdkSessionRef {
  sessionID: string;
}

export interface SdkPromptInput extends SdkSessionRef {
  text: string;
}

/** The subset of `host.sessions` the adapter uses. */
export interface SdkSessionsApi {
  create(input: SdkCreateSessionInput): Promise<SdkSessionRow>;
  get(input: SdkSessionRef): Promise<SdkSessionRow>;
  prompt(input: SdkPromptInput): Promise<unknown>;
  remove(input: SdkSessionRef): Promise<unknown>;
}

/** The subset of `host.message` the adapter uses. */
export interface SdkMessageApi {
  list(input: SdkSessionRef & { order?: "asc" | "desc" }): Promise<SdkMessageListResult | SdkMessage[]>;
}

/** Inline host log entry (secret-free lifecycle/diagnostic messages). */
export interface SdkLogEntry {
  level?: unknown;
  message?: unknown;
  cause?: unknown;
  [key: string]: unknown;
}

/**
 * Options bed for `OpenCode.create` passed by the adapter. Only the fields the
 * adapter sets are modelled.
 */
export interface SdkHostOptions {
  config: { content: string; project: boolean; claude: boolean };
  database: { path: string };
  models: { fetch: boolean };
  fs: { filewatcher: boolean };
  log: { level: "error"; emit: (entry: SdkLogEntry) => void };
  /**
   * Egress seam: an optional proxy-aware fetch supplied by the SDK worker
   * (Phase 2b). The adapter never chooses a proxy itself.
   */
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

/** The created OpenCode host. */
export interface SdkHost {
  sessions: SdkSessionsApi;
  message: SdkMessageApi;
  /** Explicit single shutdown path (`try/finally`), never `await using`. */
  close(): Promise<void>;
}

/** The resolved module shape of `@opencode/sdk` that the adapter needs. */
export interface SdkModule {
  OpenCode: {
    create(options: SdkHostOptions): Promise<SdkHost>;
  };
}

/** Injectable dynamic loader (the default uses a variable specifier). */
export type SdkLoader = () => Promise<SdkModule>;
