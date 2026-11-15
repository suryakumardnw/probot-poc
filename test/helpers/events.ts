import type { Probot } from "probot";

/**
 * Partial webhook fixtures.
 *
 * Probot's `receive()` expects a complete GitHub payload, but fixtures in this
 * suite intentionally provide only the fields the handlers read. This
 * structural view widens the fixture boundary without a cast; calls still go
 * through the real Probot receiver and the real application handlers.
 */
export interface WebhookReceiver {
  receive(event: { id?: string; name: string; payload: object }): Promise<void>;
}

export function webhookReceiver(probot: Probot): WebhookReceiver {
  return probot;
}
