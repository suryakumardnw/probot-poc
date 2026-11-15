import { describe, expect, test } from "vitest";
import { chatCompletionPayloadSchema, providerErrorPayloadSchema } from "./model.js";

const validCompletion = {
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
};

describe("chatCompletionPayloadSchema", () => {
  test("accepts a standard OpenAI-compatible completion", () => {
    const parsed = chatCompletionPayloadSchema.parse(validCompletion);
    expect(parsed.id).toBe("chatcmpl-123");
    expect(parsed.model).toBe("glm-4.7-flash");
    expect(parsed.choices[0]?.finish_reason).toBe("stop");
    expect(parsed.choices[0]?.message?.content).toBe("pong");
    expect(parsed.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });

  test("accepts reasoning-model drift: null content, reasoning_content and extra fields", () => {
    const parsed = chatCompletionPayloadSchema.parse({
      id: "chatcmpl-reasoning",
      model: "glm-4.7-flash",
      object: "chat.completion",
      choices: [
        {
          finish_reason: "length",
          message: { role: "assistant", content: null, reasoning_content: "final answer from reasoning" },
          logprobs: null,
        },
      ],
    });

    expect(parsed.choices[0]?.message?.content).toBeUndefined();
    expect(parsed.choices[0]?.message?.reasoning_content).toBe("final answer from reasoning");
    expect(parsed.usage).toBeUndefined();
  });

  test("tolerates non-numeric and null usage fields per field", () => {
    const parsed = chatCompletionPayloadSchema.parse({
      ...validCompletion,
      usage: { prompt_tokens: "10", completion_tokens: null, total_tokens: 15 },
    });

    expect(parsed.usage).toEqual({ prompt_tokens: undefined, completion_tokens: undefined, total_tokens: 15 });
  });

  test("accepts an empty choices array for the adapter to reject with its stable code", () => {
    const parsed = chatCompletionPayloadSchema.parse({ ...validCompletion, choices: [] });
    expect(parsed.choices).toEqual([]);
  });

  test.each([
    ["a missing choices array", { id: "x" }],
    ["choices as an object", { ...validCompletion, choices: { 0: validCompletion.choices[0] } }],
    ["a non-object choice", { ...validCompletion, choices: [null] }],
    ["a top-level array", [validCompletion]],
    ["an empty body", undefined],
  ])("rejects %s", (_name, candidate) => {
    expect(chatCompletionPayloadSchema.safeParse(candidate).success).toBe(false);
  });
});

describe("providerErrorPayloadSchema", () => {
  test.each([
    ["a plain text body", "upstream unavailable"],
    ["an OpenAI error object", { error: { message: "invalid api key", type: "auth_error" } }],
    ["an error string", { error: "invalid api key" }],
    ["a top-level message", { message: "rate limited" }],
  ])("accepts %s", (_name, body) => {
    expect(providerErrorPayloadSchema.safeParse(body).success).toBe(true);
  });

  test("tolerates a malformed error field so a top-level message can still be read", () => {
    const parsed = providerErrorPayloadSchema.safeParse({ error: { message: 42 }, message: "provider failed" });
    expect(parsed.success).toBe(true);
    if (parsed.success && typeof parsed.data === "object") {
      expect(parsed.data.error).toBeUndefined();
      expect(parsed.data.message).toBe("provider failed");
    }
  });

  test.each([
    ["a number", 500],
    ["an array", []],
    ["null", null],
  ])("rejects %s", (_name, body) => {
    expect(providerErrorPayloadSchema.safeParse(body).success).toBe(false);
  });
});
