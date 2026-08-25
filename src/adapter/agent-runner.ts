import type { EventEmitter } from "events";

/** Options shared by every CLI adapter runner behind the OpenAI route layer. */
export interface RunnerOptions {
  /** Accepted for the OpenAI `user` contract; current runners are stateless. */
  sessionId?: string;
  systemPrompt?: string;
  /** Milliseconds; 0 means unbounded. */
  timeout?: number;
  /**
   * Reasoning effort the request asked for. Honoured only by adapters whose
   * CLI takes one; the rest run identically with or without it.
   */
  reasoningEffort?: string;
}

/**
 * Agent-agnostic execution contract consumed by the OpenAI-compatible routes.
 * Implementations emit content_delta/result/error/close events.
 */
export interface AgentRunner extends EventEmitter {
  start(prompt: string, options: RunnerOptions): Promise<void>;
  kill(signal?: NodeJS.Signals): void;
}
