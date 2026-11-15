import type {
  AgentResult,
  AgentRuntime,
  AgentSession,
  AgentSessionOptions,
  AgentTask,
  RuntimeHealth,
} from "../../src/ports/agent-runtime.js";
import type { Clock } from "../../src/ports/clock.js";
import { AgentRuntimeError } from "../../src/shared/errors/index.js";
import { FakeClock } from "./clock.js";

export type FakeAgentResponder = (task: AgentTask, callIndex: number, session: AgentSession) => unknown;

export interface FakeAgentRuntimeOptions {
  clock?: Clock;
  health?: RuntimeHealth;
  /** Wall-clock duration reported by `execute`; defaults to 5ms. */
  durationMs?: number;
}

/**
 * Scripted agent runtime for unit tests.
 *
 * Implements the full `AgentRuntime` port: sessions are recorded and
 * isolated by id, results go through `task.validate` exactly like the real
 * adapter, and start/execute/terminate/health can each fail on demand so
 * callers can pin failure semantics without spawning a process.
 */
export class FakeAgentRuntime implements AgentRuntime {
  readonly started: AgentSessionOptions[] = [];
  readonly sessions: AgentSession[] = [];
  readonly tasks: AgentTask[] = [];
  readonly terminatedSessions: Array<AgentSession | undefined> = [];
  /** Scripted outputs, consumed in call order (public for concise fixtures). */
  responders: FakeAgentResponder[] = [];
  /** Usage attached to the next execute result, oldest first. */
  usageQueue: Array<AgentResult["usage"]> = [];
  durationMs: number;
  terminated = 0;

  private readonly clock: Clock;
  private health: RuntimeHealth;
  private readonly startErrors: unknown[] = [];
  private readonly executeErrors: unknown[] = [];
  private readonly terminateErrors: unknown[] = [];
  private readonly healthErrors: unknown[] = [];

  constructor(options: FakeAgentRuntimeOptions = {}) {
    this.clock = options.clock ?? new FakeClock();
    this.durationMs = options.durationMs ?? 5;
    this.health = options.health ?? { healthy: true, detail: "fake", checkedAt: this.clock.now().toISOString() };
  }

  queueResponse(value: unknown): this {
    this.responders.push(() => value);
    return this;
  }

  queueResponder(responder: FakeAgentResponder): this {
    this.responders.push(responder);
    return this;
  }

  queueStartSessionError(error: unknown): this {
    this.startErrors.push(error);
    return this;
  }

  queueExecuteError(error: unknown): this {
    this.executeErrors.push(error);
    return this;
  }

  queueTerminateError(error: unknown): this {
    this.terminateErrors.push(error);
    return this;
  }

  queueHealthError(error: unknown): this {
    this.healthErrors.push(error);
    return this;
  }

  setHealth(health: RuntimeHealth): void {
    this.health = health;
  }

  async startSession(options: AgentSessionOptions): Promise<AgentSession> {
    const error = this.startErrors.shift();
    if (error !== undefined) {
      throw error;
    }
    const session: AgentSession = {
      id: `sess-fake-${this.sessions.length + 1}`,
      reviewId: options.reviewId,
      workspacePath: options.workspacePath,
      createdAt: this.clock.now().toISOString(),
      timeoutMs: options.timeoutMs ?? 0,
    };
    this.started.push(options);
    this.sessions.push(session);
    return session;
  }

  async execute(session: AgentSession, task: AgentTask): Promise<AgentResult> {
    const callIndex = this.tasks.length;
    this.tasks.push(task);

    const error = this.executeErrors.shift();
    if (error !== undefined) {
      throw error;
    }
    const respond = this.responders[callIndex];
    if (respond === undefined) {
      throw new AgentRuntimeError("invalid_output", `no scripted response for call ${callIndex}`);
    }
    const value = await respond(task, callIndex, session);
    if (task.validate) {
      const outcome = task.validate(value);
      if (!outcome.ok) {
        // Mirrors the real runtime: invalid structured output fails immediately.
        throw new AgentRuntimeError("invalid_output", `agent output failed validation: ${outcome.error}`, {
          sessionId: session.id,
        });
      }
      return {
        sessionId: session.id,
        text: "",
        ...(task.output === "json" ? { json: value } : {}),
        value: outcome.value,
        durationMs: this.durationMs,
        usage: this.usageQueue.shift(),
      };
    }
    return {
      sessionId: session.id,
      text: typeof value === "string" ? value : "",
      ...(task.output === "json" ? { json: value } : {}),
      value,
      durationMs: this.durationMs,
      usage: this.usageQueue.shift(),
    };
  }

  async terminate(session?: AgentSession): Promise<void> {
    const error = this.terminateErrors.shift();
    this.terminated += 1;
    this.terminatedSessions.push(session);
    if (error !== undefined) {
      throw error;
    }
  }

  async healthCheck(): Promise<RuntimeHealth> {
    const error = this.healthErrors.shift();
    if (error !== undefined) {
      throw error;
    }
    return { ...this.health };
  }
}
