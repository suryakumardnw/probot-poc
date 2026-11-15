import type { TriageServiceDependencies } from "../../src/modules/triage/index.js";
import { createGroqTriageProvider } from "../../src/platform/models/groq-triage.js";

/**
 * Production-equivalent triage wiring for webhook tests.
 *
 * The provider resolves `GROQ_API_KEY` / `GROQ_MODEL` lazily on the first
 * triage call, so each test can arrange the environment (and the HTTP stub)
 * after the app graph is built.
 */
export function createTestTriage(): TriageServiceDependencies {
  return { provider: createGroqTriageProvider({ env: process.env }) };
}
