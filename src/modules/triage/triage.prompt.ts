/**
 * Prompt construction for issue triage (ARCHITECTURE.md §1.2).
 *
 * The prompt and the truncation limits are preserved from the pre-module
 * triage service: the model sees the same system instructions and the same
 * `Issue #<n>: <title>` user message. Bodies are truncated to roughly
 * `MAX_BODY_TOKENS` tokens (chars / 4) with a visible notice.
 */

import type { ModelMessage } from "../../models/provider.js";

export const TRIAGE_SYSTEM_PROMPT = `You are an experienced maintainer triaging GitHub issues.
Given an issue title and body, respond with:
1. A short classification: Bug / Feature request / Question / Other.
2. 2-4 possible causes or approaches, as a markdown bullet list.
3. Suggested next steps or clarifying questions to ask the reporter.
Be concise (max ~250 words). Use GitHub-flavored markdown. If the issue is unclear, say what information is missing.`;

export const MAX_BODY_TOKENS = 3000;

/** Issue fields needed to build the triage prompt. */
export interface TriageIssue {
  number: number;
  title: string;
  body: string;
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

/** System + user messages sent to the model provider for one issue. */
export function buildTriageMessages(issue: TriageIssue): ModelMessage[] {
  return [
    { role: "system", content: TRIAGE_SYSTEM_PROMPT },
    {
      role: "user",
      content: `Issue #${issue.number}: ${issue.title}\n\n${truncate(issue.body, MAX_BODY_TOKENS)}`,
    },
  ];
}
