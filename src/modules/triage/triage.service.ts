/**
 * Triage service — business logic for triaging GitHub issues.
 *
 * The model is reached exclusively through the `ModelProvider` port: no HTTP
 * client, API key or provider-specific payload lives in this module. The
 * composition root supplies the configured provider (Groq in production).
 */

import type { ModelProvider } from "../../ports/model-provider.js";
import { buildTriageMessages, type TriageIssue } from "./triage.prompt.js";

/** Request parameters preserved from the pre-module Groq client. */
const TRIAGE_MAX_OUTPUT_TOKENS = 1024;
const TRIAGE_TEMPERATURE = 0.2;

export interface TriageServiceDependencies {
  provider: ModelProvider;
}

export interface TriageService {
  /** Ask the provider to triage an issue; returns raw markdown analysis. */
  triageIssue(issue: TriageIssue): Promise<string>;
}

export function createTriageService(deps: TriageServiceDependencies): TriageService {
  return {
    async triageIssue(issue: TriageIssue): Promise<string> {
      const response = await deps.provider.chat({
        messages: buildTriageMessages(issue),
        temperature: TRIAGE_TEMPERATURE,
        maxOutputTokens: TRIAGE_MAX_OUTPUT_TOKENS,
      });
      return response.content;
    },
  };
}
