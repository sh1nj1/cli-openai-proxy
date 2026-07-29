import type { EventEmitter } from "events";
import type { ClaudeModel } from "./openai-to-cli.js";

/** Options shared by every CLI adapter runner behind the OpenAI route layer. */
export interface RunnerOptions {
  model: ClaudeModel | (string & {});
  /** Accepted for the OpenAI `user` contract; current runners are stateless. */
  sessionId?: string;
  systemPrompt?: string;
  /** Milliseconds; 0 means unbounded. */
  timeout?: number;
}

/**
 * Agent-agnostic execution contract consumed by the OpenAI-compatible routes.
 * Implementations emit content_delta/result/error/close events.
 */
export interface AgentRunner extends EventEmitter {
  start(prompt: string, options: RunnerOptions): Promise<void>;
  kill(signal?: NodeJS.Signals): void;
}
