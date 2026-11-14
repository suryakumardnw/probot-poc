/**
 * LLM service — minimal Groq client (OpenAI-compatible chat completions API).
 * Uses Node's built-in fetch, so no extra dependency is required.
 */

import type { ChatMessage, ChatOptions } from "../models/chat.js";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

export async function chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("GROQ_API_KEY is not set");
  }

  const response = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: opts.model ?? process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile",
      messages,
      max_tokens: opts.maxTokens ?? 1024,
      temperature: opts.temperature ?? 0.2,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Groq API error ${response.status}: ${body.slice(0, 500)}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Groq API returned no content");
  }
  return content;
}

/** Rough token estimate (chars / 4) used to keep prompts within limits. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Truncate text to roughly `maxTokens` tokens, appending a notice. */
export function truncate(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) {
    return text;
  }
  const maxChars = maxTokens * 4;
  return text.slice(0, maxChars) + "\n\n... [truncated: diff/content too large to analyze fully]";
}
