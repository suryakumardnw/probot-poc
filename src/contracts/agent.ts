import { z } from "zod";

/**
 * Agent runtime and SDK host protocol contracts.
 *
 * Two external protocols meet here:
 *
 * 1. `opencode run --format json` emits one JSON event per line (NDJSON). The
 *    adapter parses every line against `agentEventSchema`; malformed lines are
 *    reported to the caller and become `AgentRuntimeError("invalid_output")`,
 *    never an unchecked cast or an unexpected crash.
 * 2. The SDK host speaks line-delimited JSON over stdin/stdout: one
 *    `SdkHostRequest` per line in, one `SdkHostResponse` per line out. Both
 *    directions and every method's params/result are parsed at the process
 *    boundary.
 *
 * Schemas are permissive about fields that legitimately vary by runtime
 * version (`part.tokens` is nested in older OpenCode releases and flattened in
 * newer ones) and strict about the envelope (`type`, request `id`/`method`,
 * response `ok`), so protocol drift fails closed with a stable error rather
 * than producing a partially-typed object.
 */

/** A numeric count/timestamp. A non-numeric or missing value is treated as absent. */
const tokenCountSchema = z.number().finite().optional().catch(undefined);

/** An optional protocol string. `null` and wrong types are treated as absent. */
const optionalStringSchema = z.string().optional().catch(undefined);

// ---------------------------------------------------------------------------
// OpenCode CLI NDJSON events
// ---------------------------------------------------------------------------

/** Token usage as reported by OpenCode (`step_finish` events). */
export const agentTokenUsageSchema = z
  .object({
    input: tokenCountSchema,
    output: tokenCountSchema,
    reasoning: tokenCountSchema,
  })
  .loose();
export type AgentTokenUsage = z.infer<typeof agentTokenUsageSchema>;

/**
 * The `part` payload of an event. Older OpenCode versions nest token usage in
 * `part.tokens.usage`; 2.2.6 flattens it onto `part.tokens`. Both shapes are
 * accepted, and unknown parts are ignored by the runtime.
 */
export const agentEventPartSchema = z
  .object({
    type: optionalStringSchema,
    messageID: optionalStringSchema,
    text: optionalStringSchema,
    tokens: z
      .object({
        input: tokenCountSchema,
        output: tokenCountSchema,
        reasoning: tokenCountSchema,
        usage: agentTokenUsageSchema.optional().catch(undefined),
      })
      .loose()
      .optional()
      .catch(undefined),
  })
  .loose()
  .optional()
  .catch(undefined);
export type AgentEventPart = z.infer<typeof agentEventPartSchema>;

/**
 * One NDJSON event. `type` is the only required field: unknown event types are
 * ignored by the adapter (forward compatibility), but an event without a
 * string type is malformed and fails the stream.
 */
export const agentEventSchema = z
  .object({
    type: z.string().min(1),
    part: agentEventPartSchema,
    message: optionalStringSchema,
  })
  .loose();
export type AgentEvent = z.infer<typeof agentEventSchema>;

// ---------------------------------------------------------------------------
// SDK host protocol — line-delimited JSON
// ---------------------------------------------------------------------------

/** Methods the SDK host accepts. */
export const SDK_HOST_METHODS = [
  "create",
  "session.create",
  "session.get",
  "session.prompt",
  "message.list",
  "session.remove",
  "close",
  "health",
] as const;
export const sdkHostMethodSchema = z.enum(SDK_HOST_METHODS);
export type SdkHostMethod = z.infer<typeof sdkHostMethodSchema>;

/** One request line. `id` correlates the response; `params` is method-specific. */
export const sdkHostRequestSchema = z
  .object({
    id: z.number().int().nonnegative(),
    method: sdkHostMethodSchema,
    params: z.unknown().optional(),
  })
  .loose();
export type SdkHostRequest = z.infer<typeof sdkHostRequestSchema>;

const sdkHostErrorSchema = z
  .object({
    message: z.string().min(1),
    code: z.string().optional(),
  })
  .loose();

/**
 * One response line. Success and failure are a discriminated union on `ok`;
 * `result` is method-specific and stays `unknown` until the caller parses it
 * against the schema for the method it invoked.
 */
export const sdkHostResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      id: z.number().int().nonnegative(),
      ok: z.literal(true),
      result: z.unknown().optional(),
    })
    .loose(),
  z
    .object({
      id: z.number().int().nonnegative(),
      ok: z.literal(false),
      error: sdkHostErrorSchema,
    })
    .loose(),
]);
export type SdkHostResponse = z.infer<typeof sdkHostResponseSchema>;

/** A log entry forwarded on stderr. Never parsed as protocol by the parent. */
export const sdkHostLogEventSchema = z
  .object({
    type: z.literal("log"),
    level: optionalStringSchema,
    message: optionalStringSchema,
    cause: optionalStringSchema,
  })
  .loose();
export type SdkHostLogEvent = z.infer<typeof sdkHostLogEventSchema>;

// ---------------------------------------------------------------------------
// SDK host protocol — method params and results
// ---------------------------------------------------------------------------

/** `create` params. */
export const sdkHostCreateParamsSchema = z.object({
  configContent: z.string().min(1),
  databasePath: z.string().min(1),
});
export type SdkHostCreateParams = z.infer<typeof sdkHostCreateParamsSchema>;

/** `session.create` params. */
export const sdkCreateSessionInputSchema = z
  .object({
    location: z.object({ directory: z.string().min(1) }).loose(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    title: z.string().optional(),
    model: z
      .object({ id: z.string().min(1), providerID: z.string().min(1) })
      .loose()
      .optional(),
  })
  .loose();
export type SdkCreateSessionInputPayload = z.infer<typeof sdkCreateSessionInputSchema>;

/** `session.get`, `session.remove`, and the shared part of `session.prompt`. */
export const sdkSessionRefSchema = z.object({
  sessionID: z.string().min(1),
});
export type SdkSessionRefPayload = z.infer<typeof sdkSessionRefSchema>;

/** `session.prompt` params. */
export const sdkPromptInputSchema = sdkSessionRefSchema.extend({
  text: z.string(),
});
export type SdkPromptInputPayload = z.infer<typeof sdkPromptInputSchema>;

/** `message.list` params. */
export const sdkMessageListParamsSchema = sdkSessionRefSchema.extend({
  order: z.enum(["asc", "desc"]).optional(),
});
export type SdkMessageListParams = z.infer<typeof sdkMessageListParamsSchema>;

/** A session row returned by `session.create` / `session.get`. */
export const sdkSessionRowSchema = z
  .object({
    id: z.string().min(1),
    time: z
      .object({
        created: tokenCountSchema,
        updated: tokenCountSchema,
        idle: tokenCountSchema,
      })
      .loose()
      .optional()
      .catch(undefined),
    outcome: optionalStringSchema,
  })
  .loose();
export type SdkSessionRowPayload = z.infer<typeof sdkSessionRowSchema>;

/** Best-effort token usage found on an SDK message or content part. */
const sdkTokenFields = {
  input: tokenCountSchema,
  output: tokenCountSchema,
  reasoning: tokenCountSchema,
  inputTokens: tokenCountSchema,
  outputTokens: tokenCountSchema,
  reasoningTokens: tokenCountSchema,
} as const;

export const sdkUsageSchema = z.looseObject({
  ...sdkTokenFields,
  usage: z.looseObject(sdkTokenFields).optional().catch(undefined),
});
export type SdkUsagePayload = z.infer<typeof sdkUsageSchema>;

/** One content part of an SDK message. */
export const sdkMessagePartSchema = z.looseObject({
  type: optionalStringSchema,
  text: optionalStringSchema,
  usage: sdkUsageSchema.optional().catch(undefined),
  tokens: sdkUsageSchema.optional().catch(undefined),
});
export type SdkMessagePartPayload = z.infer<typeof sdkMessagePartSchema>;

/** One message returned by `message.list`. */
export const sdkMessageSchema = z.looseObject({
  type: optionalStringSchema,
  content: z.array(sdkMessagePartSchema).optional().catch(undefined),
  usage: sdkUsageSchema.optional().catch(undefined),
  tokens: sdkUsageSchema.optional().catch(undefined),
});
export type SdkMessagePayload = z.infer<typeof sdkMessageSchema>;

/** The normalized `message.list` result sent over the protocol: an array. */
export const sdkMessageListSchema = z.array(sdkMessageSchema);
export type SdkMessageListPayload = z.infer<typeof sdkMessageListSchema>;

/**
 * The raw SDK `message.list` result: newer SDKs return `{ data: [...] }`,
 * older call sites return the array directly. `data` may be absent.
 */
export const sdkMessageListResultSchema = z.union([
  z.array(sdkMessageSchema),
  z
    .object({
      data: z.array(sdkMessageSchema).optional().catch(undefined),
    })
    .loose(),
]);
export type SdkMessageListResultPayload = z.infer<typeof sdkMessageListResultSchema>;

/** `health` result. The version is diagnostic only and may be absent. */
export const sdkHealthResultSchema = z
  .object({
    version: z.unknown().optional(),
  })
  .loose()
  .optional()
  .catch(undefined);
export type SdkHealthResultPayload = z.infer<typeof sdkHealthResultSchema>;

/** The subset of an SDK `package.json` used by the health probe. */
export const sdkPackageManifestSchema = z
  .object({
    name: z.string().optional(),
    version: z.string().optional(),
  })
  .loose();
export type SdkPackageManifest = z.infer<typeof sdkPackageManifestSchema>;

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/** Result of parsing one untrusted protocol value. */
export type ContractParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Issue paths and messages only; received values never reach error details. */
function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

/** Parse an untrusted value against a schema without throwing. */
export function parseSdkHostValue<T>(schema: z.ZodType<T>, value: unknown): ContractParseResult<T> {
  const parsed = schema.safeParse(value);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: formatIssues(parsed.error) };
}

function parseJsonLine<T>(line: string, schema: z.ZodType<T>): ContractParseResult<T> {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { ok: false, error: "line is not valid JSON" };
  }
  return parseSdkHostValue(schema, raw);
}

/** Parse one OpenCode NDJSON event line. Never throws. */
export function parseAgentEventLine(line: string): ContractParseResult<AgentEvent> {
  return parseJsonLine(line, agentEventSchema);
}

/** Parse one SDK host request line. Never throws. */
export function parseSdkHostRequestLine(line: string): ContractParseResult<SdkHostRequest> {
  return parseJsonLine(line, sdkHostRequestSchema);
}

/** Parse one SDK host response line. Never throws. */
export function parseSdkHostResponseLine(line: string): ContractParseResult<SdkHostResponse> {
  return parseJsonLine(line, sdkHostResponseSchema);
}
