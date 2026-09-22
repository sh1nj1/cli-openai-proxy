/**
 * Types for OpenAI-compatible API
 * Used for Clawdbot integration
 */

import type { ToolEvent } from "../adapter/tool-events.js";

export interface OpenAIContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string; detail?: string };
}

export interface OpenAIChatMessage {
  role: "system" | "developer" | "user" | "assistant";
  content: string | OpenAIContentPart[];
}

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  response_format?: { type: "text" | "json_object" | "json_schema"; json_schema?: unknown };
  stream_options?: { include_usage?: boolean };
  user?: string; // Used for session mapping
  /** OpenAI reasoning control. Only adapters that run a reasoning model act on it. */
  reasoning_effort?: string;
  /**
   * Proxy extension. "reasoning" surfaces the tool calls/results the CLI already ran
   * as `reasoning_content` (plus structured `x_cli_events`); default "off".
   */
  x_cli_events?: "off" | "reasoning";
}

export interface OpenAIChatResponseChoice {
  index: number;
  message: {
    role: "assistant";
    content: string;
    reasoning_content?: string;
    x_cli_events?: ToolEvent[];
  };
  finish_reason: "stop" | "length" | "content_filter" | null;
}

export interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
}

export interface OpenAIChatResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: OpenAIChatResponseChoice[];
  usage: OpenAIUsage;
}

export interface OpenAIChatChunkDelta {
  role?: "assistant";
  content?: string;
  reasoning_content?: string;
  x_cli_events?: ToolEvent[];
}

export interface OpenAIChatChunkChoice {
  index: number;
  delta: OpenAIChatChunkDelta;
  finish_reason: "stop" | "length" | "content_filter" | null;
}

export interface OpenAIChatChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: OpenAIChatChunkChoice[];
  /**
   * Only present when the caller sent stream_options.include_usage: null on every
   * chunk but the terminal one, which carries the totals and an empty `choices`.
   */
  usage?: OpenAIUsage | null;
}

export interface OpenAIModel {
  id: string;
  object: "model";
  owned_by: string;
  created?: number;
}

export interface OpenAIModelList {
  object: "list";
  data: OpenAIModel[];
}

export interface OpenAIError {
  error: {
    message: string;
    type: string;
    code: string | null;
  };
}
