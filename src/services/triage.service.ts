/** Triage service — business logic for triaging GitHub issues via LLM. */

import type { IssueData } from "../models/triage.js";
import { chat, truncate } from "./llm.service.js";

const SYSTEM_PROMPT = `You are an experienced maintainer triaging GitHub issues.
Given an issue title and body, respond with:
1. A short classification: Bug / Feature request / Question / Other.
2. 2-4 possible causes or approaches, as a markdown bullet list.
3. Suggested next steps or clarifying questions to ask the reporter.
Be concise (max ~250 words). Use GitHub-flavored markdown. If the issue is unclear, say what information is missing.`;

const MAX_BODY_TOKENS = 3000;

/** Ask the LLM to triage an issue; returns raw markdown analysis. */
export async function triageIssue(issue: IssueData): Promise<string> {
  return chat([
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `Issue #${issue.number}: ${issue.title}\n\n${truncate(issue.body, MAX_BODY_TOKENS)}`,
    },
  ]);
}
