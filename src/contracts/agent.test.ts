import { describe, expect, test } from "vitest";
import {
  agentEventSchema,
  parseAgentEventLine,
  parseSdkHostRequestLine,
  parseSdkHostResponseLine,
  sdkHealthResultSchema,
  sdkHostRequestSchema,
  sdkHostResponseSchema,
  sdkMessageListResultSchema,
  sdkMessageListSchema,
  sdkMessageSchema,
  sdkPackageManifestSchema,
  sdkSessionRowSchema,
  sdkUsageSchema,
} from "./agent.js";

const textEvent = { type: "text", part: { type: "text", messageID: "msg_1", text: "hello" } };
const nestedStepFinish = {
  type: "step_finish",
  part: { type: "step_finish", tokens: { usage: { input: 120, output: 64, reasoning: 10, cache: {} } } },
};
const flatStepFinish = {
  type: "step_finish",
  part: {
    type: "step-finish",
    tokens: { total: 194, input: 120, output: 64, reasoning: 10, cache: { read: 0, write: 0 } },
  },
};

describe("agentEventSchema", () => {
  test("accepts the text and step_finish event shapes emitted by OpenCode", () => {
    expect(agentEventSchema.parse(textEvent)).toMatchObject(textEvent);
    expect(agentEventSchema.parse(nestedStepFinish)).toMatchObject(nestedStepFinish);
    expect(agentEventSchema.parse(flatStepFinish)).toMatchObject(flatStepFinish);
  });

  test("accepts error events, unknown event types and events without a part", () => {
    expect(agentEventSchema.parse({ type: "error", message: "provider auth failed" }).message).toBe(
      "provider auth failed",
    );
    expect(agentEventSchema.parse({ type: "tool", part: { type: "tool", index: 1 } }).type).toBe("tool");
    expect(agentEventSchema.parse({ type: "step_start" }).part).toBeUndefined();
    expect(agentEventSchema.parse({ type: "future.event", extra: true }).type).toBe("future.event");
  });

  test("tolerates non-string optional part fields instead of rejecting the stream", () => {
    const parsed = agentEventSchema.parse({ type: "text", part: { type: "text", text: 42, messageID: null } });
    expect(parsed.part?.text).toBeUndefined();
    expect(parsed.part?.messageID).toBeUndefined();
  });

  test.each([
    ["a missing type", { part: { text: "x" } }],
    ["a non-string type", { type: 7 }],
    ["an empty type", { type: "" }],
    ["a top-level array", [textEvent]],
    ["null", null],
    ["a JSON string", "text"],
  ])("rejects %s", (_name, candidate) => {
    expect(agentEventSchema.safeParse(candidate).success).toBe(false);
  });
});

describe("parseAgentEventLine", () => {
  test("parses a valid NDJSON line", () => {
    const parsed = parseAgentEventLine(JSON.stringify(textEvent));
    expect(parsed).toEqual({ ok: true, value: expect.objectContaining(textEvent) });
  });

  test("reports malformed JSON and contract mismatches without throwing", () => {
    expect(parseAgentEventLine("not json")).toEqual({ ok: false, error: expect.stringContaining("not valid JSON") });
    const mismatch = parseAgentEventLine(JSON.stringify({ type: 7 }));
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) {
      expect(mismatch.error).toContain("type");
    }
  });
});

describe("SDK host request/response protocol", () => {
  test("accepts a create request and a request without params", () => {
    const withParams = sdkHostRequestSchema.parse({
      id: 1,
      method: "create",
      params: { configContent: "{}", databasePath: "/tmp/opencode.db" },
    });
    expect(withParams).toMatchObject({ id: 1, method: "create" });
    expect(sdkHostRequestSchema.parse({ id: 2, method: "health" }).params).toBeUndefined();
  });

  test.each([
    ["a missing id", { method: "health" }],
    ["a string id", { id: "1", method: "health" }],
    ["a fractional id", { id: 1.5, method: "health" }],
    ["an unknown method", { id: 1, method: "bogus" }],
    ["a missing method", { id: 1 }],
  ])("rejects %s", (_name, candidate) => {
    expect(sdkHostRequestSchema.safeParse(candidate).success).toBe(false);
  });

  test("parseSdkHostRequestLine separates invalid JSON from a schema mismatch", () => {
    expect(parseSdkHostRequestLine("{")).toEqual({ ok: false, error: expect.stringContaining("not valid JSON") });
    const mismatch = parseSdkHostRequestLine(JSON.stringify({ id: "1", method: "health" }));
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) {
      expect(mismatch.error).toContain("id");
    }
  });

  test("accepts success and failure response envelopes", () => {
    const success = sdkHostResponseSchema.parse({ id: 1, ok: true, result: { id: "sess_1" } });
    expect(success.ok).toBe(true);
    const failure = sdkHostResponseSchema.parse({
      id: 2,
      ok: false,
      error: { message: "session not found", code: "not_found" },
    });
    expect(failure.ok).toBe(false);
  });

  test.each([
    ["a missing ok discriminator", { id: 1 }],
    ["a string id", { id: "1", ok: true }],
    ["a failure without an error object", { id: 1, ok: false }],
    ["a failure with an empty message", { id: 1, ok: false, error: { message: "" } }],
    ["a top-level array", [{ id: 1, ok: true }]],
  ])("rejects %s", (_name, candidate) => {
    expect(sdkHostResponseSchema.safeParse(candidate).success).toBe(false);
  });

  test("parseSdkHostResponseLine rejects an invalid protocol line", () => {
    expect(parseSdkHostResponseLine("this is not json")).toEqual({
      ok: false,
      error: expect.stringContaining("not valid JSON"),
    });
    expect(parseSdkHostResponseLine(JSON.stringify({ id: 1, ok: "yes" })).ok).toBe(false);
  });
});

describe("SDK host result contracts", () => {
  test("session rows accept optional time/outcome and extra SDK fields", () => {
    const row = sdkSessionRowSchema.parse({
      id: "sess_1",
      time: { created: 1, updated: 2, idle: 3, extra: true },
      outcome: "completed",
      extra: "ignored by the adapter",
    });
    expect(row.id).toBe("sess_1");
    expect(row.time?.idle).toBe(3);
    expect(sdkSessionRowSchema.safeParse({}).success).toBe(false);
    expect(sdkSessionRowSchema.safeParse({ id: "" }).success).toBe(false);
  });

  test("usage accepts nested and flattened token counts and ignores non-numeric values", () => {
    expect(sdkUsageSchema.parse({ input: 1, output: 2, reasoning: 3 })).toMatchObject({
      input: 1,
      output: 2,
      reasoning: 3,
    });
    expect(sdkUsageSchema.parse({ usage: { input: 4, output: 5 } }).usage).toEqual({
      input: 4,
      output: 5,
      reasoning: undefined,
      inputTokens: undefined,
      outputTokens: undefined,
      reasoningTokens: undefined,
    });
    const drift = sdkUsageSchema.parse({ input: "1", output: 2 });
    expect(drift.input).toBeUndefined();
    expect(drift.output).toBe(2);
  });

  test("messages accept content parts and tolerate a non-array content field", () => {
    const message = sdkMessageSchema.parse({
      type: "assistant",
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second", tokens: { usage: { input: 1 } } },
      ],
    });
    expect(message.content).toHaveLength(2);
    expect(message.content?.[1]?.tokens?.usage?.input).toBe(1);

    const drift = sdkMessageSchema.parse({ type: "assistant", content: "not an array" });
    expect(drift.content).toBeUndefined();
    expect(sdkMessageSchema.safeParse("not a message").success).toBe(false);
  });

  test("message list contracts accept an array or a data envelope", () => {
    const messages = [{ type: "assistant", content: [{ type: "text", text: "ok" }] }];
    expect(sdkMessageListSchema.parse(messages)).toHaveLength(1);
    const result = sdkMessageListResultSchema.parse({ data: messages });
    expect(result).toEqual({ data: messages });
    expect(sdkMessageListResultSchema.parse(messages)).toHaveLength(1);
    expect(sdkMessageListResultSchema.parse({})).toEqual({ data: undefined });
  });

  test("health and package manifest contracts are diagnostic and permissive", () => {
    expect(sdkHealthResultSchema.parse({ version: "2.3.0" })?.version).toBe("2.3.0");
    expect(sdkHealthResultSchema.parse({ version: 3 })).toEqual({ version: 3 });
    expect(sdkHealthResultSchema.parse("not a result")).toBeUndefined();
    expect(sdkPackageManifestSchema.parse({ name: "@opencode/sdk", version: "2.3.0" }).version).toBe("2.3.0");
    expect(sdkPackageManifestSchema.safeParse({ version: 3 }).success).toBe(false);
  });
});
