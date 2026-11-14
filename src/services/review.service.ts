/** Review service — business logic for reviewing PRs via LLM. */

import type { PullRequestData } from "../models/review.js";
import { chat, truncate } from "./llm.service.js";

const SYSTEM_PROMPT = `You are a senior software engineer performing code reviews.
Review the pull request diff and respond with:
1. A one-line summary of what the PR does.
2. Findings as a bullet list: bugs, security issues, performance concerns, style problems. Reference file names. If there are none, say the changes look good.
3. One or two concrete suggestions (optional).
Be concise (max ~300 words). Use GitHub-flavored markdown. Do not invent code that is not in the diff.`;

/** Max tokens of diff we send to the model. */
const MAX_DIFF_TOKENS = 6000;

/** Ask the LLM to review a PR diff; returns raw markdown review. */
export async function reviewPullRequest(pr: PullRequestData, diff: string): Promise<string> {
  return chat([
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `PR title: ${pr.title}\nPR body:\n${pr.body}\n\nDiff:\n\`\`\`diff\n${truncate(diff, MAX_DIFF_TOKENS)}\n\`\`\``,
    },
  ]);
}
