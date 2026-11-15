import type { Clock } from "../../src/ports/clock.js";
import type {
  ModelCapabilities,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ProviderHealth,
} from "../../src/ports/model-provider.js";
import { ModelProviderError } from "../../src/shared/errors/index.js";
import { FakeClock } from "./clock.js";

export type FakeChatResponder = (request: ModelRequest, callIndex: number) => ModelResponse;

export interface FakeModelProviderOptions {
  clock?: Clock;
  health?: ProviderHealth;
  capabilities?: ModelCapabilities;
}

const DEFAULT_CAPABILITIES: ModelCapabilities = {
  chatCompletions: true,
  structuredOutput: "json_object",
  jsonSchema: false,
  toolCalling: false,
  streaming: false,
  usageReporting: "optional",
};

/**
 * Scripted model provider for unit tests.
 *
 * Records every request and supports queued responses plus queued failures, so
 * service-level tests can exercise retry/fallback branches without an HTTP
 * server. The adapter contract (parsing, HTTP, timeout) is still covered by
 * `test/model-provider.test.ts`.
 */
export class FakeModelProvider implements ModelProvider {
  readonly requests: ModelRequest[] = [];
  private readonly responders: FakeChatResponder[] = [];
  private readonly chatErrors: unknown[] = [];
  private readonly healthErrors: unknown[] = [];
  private health: ProviderHealth;
  private capabilities: ModelCapabilities;
  private readonly clock: Clock;

  constructor(options: FakeModelProviderOptions = {}) {
    this.clock = options.clock ?? new FakeClock();
    this.health = options.health ?? { healthy: true, detail: "fake", checkedAt: this.clock.now().toISOString() };
    this.capabilities = options.capabilities ?? DEFAULT_CAPABILITIES;
  }

  queueResponse(response: ModelResponse): this {
    this.responders.push(() => response);
    return this;
  }

  queueResponder(responder: FakeChatResponder): this {
    this.responders.push(responder);
    return this;
  }

  queueChatError(error: unknown): this {
    this.chatErrors.push(error);
    return this;
  }

  queueHealthError(error: unknown): this {
    this.healthErrors.push(error);
    return this;
  }

  setHealth(health: ProviderHealth): void {
    this.health = health;
  }

  setCapabilities(capabilities: ModelCapabilities): void {
    this.capabilities = capabilities;
  }

  async chat(request: ModelRequest): Promise<ModelResponse> {
    const callIndex = this.requests.length;
    this.requests.push(request);

    const error = this.chatErrors.shift();
    if (error !== undefined) {
      throw error;
    }
    const respond = this.responders[callIndex];
    if (respond === undefined) {
      throw new ModelProviderError("provider_unavailable", `no scripted model response for call ${callIndex}`);
    }
    return respond(request, callIndex);
  }

  async healthCheck(): Promise<ProviderHealth> {
    const error = this.healthErrors.shift();
    if (error !== undefined) {
      throw error;
    }
    return { ...this.health };
  }

  async getCapabilities(): Promise<ModelCapabilities> {
    return { ...this.capabilities };
  }
}
