/**
 * Converts OpenAI chat request format to Claude CLI input
 */

import type { OpenAIChatRequest, OpenAIContentPart } from "../types/openai.js";

/**
 * Extract text from message content which can be either a string
 * or an array of content parts (OpenAI format).
 */
function extractText(content: string | OpenAIContentPart[]): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((part) => part.type === "text" && part.text)
      .map((part) => part.text!)
      .join("\n");
  }
  // Fallback: try to stringify
  return String(content);
}

export type ClaudeModel = "opus" | "sonnet" | "haiku";

export interface CliInput {
  prompt: string;
  model: ClaudeModel;
  systemPrompt?: string;
  sessionId?: string;
  jsonMode?: boolean;
}

const MODEL_MAP: Record<string, ClaudeModel> = {
  // Direct model names
  "claude-opus-4": "opus",
  "claude-opus-4-6": "opus",
  "claude-sonnet-4": "sonnet",
  "claude-sonnet-4-5-20250929": "sonnet",
  "claude-haiku-4": "haiku",
  "claude-haiku-4-5-20251001": "haiku",
  // With provider prefix
  "claude-code-cli/claude-opus-4": "opus",
  "claude-code-cli/claude-opus-4-6": "opus",
  "claude-code-cli/claude-sonnet-4": "sonnet",
  "claude-code-cli/claude-sonnet-4-5-20250929": "sonnet",
  "claude-code-cli/claude-haiku-4": "haiku",
  "claude-code-cli/claude-haiku-4-5-20251001": "haiku",
  // Anthropic-style model IDs (used by OpenClaw)
  "anthropic/claude-opus-4-6": "opus",
  "anthropic/claude-opus-4": "opus",
  "anthropic/claude-sonnet-4": "sonnet",
  "anthropic/claude-sonnet-4-5-20250929": "sonnet",
  "anthropic/claude-haiku-4": "haiku",
  "anthropic/claude-haiku-4-5-20251001": "haiku",
  // Claude Max provider prefix (used by OpenClaw)
  "claude-max/claude-opus-4-6": "opus",
  "claude-max/claude-opus-4": "opus",
  "claude-max/claude-sonnet-4": "sonnet",
  "claude-max/claude-sonnet-4-5-20250929": "sonnet",
  "claude-max/claude-haiku-4": "haiku",
  "claude-max/claude-haiku-4-5-20251001": "haiku",
  // Aliases
  "opus": "opus",
  "sonnet": "sonnet",
  "haiku": "haiku",
};

/**
 * Extract Claude model alias from request model string
 */
export function extractModel(model: string): ClaudeModel {
  if (MODEL_MAP[model]) {
    return MODEL_MAP[model];
  }

  // Strip any provider prefix (openai/, anthropic/, claude-max/, etc.)
  const slashIdx = model.indexOf("/");
  if (slashIdx !== -1) {
    const stripped = model.slice(slashIdx + 1);
    if (MODEL_MAP[stripped]) {
      return MODEL_MAP[stripped];
    }
  }

  return "opus";
}

/**
 * Extract system messages from OpenAI messages array.
 * Returns the concatenated system prompt text, or undefined if none.
 */
export function extractSystemPrompt(messages: OpenAIChatRequest["messages"]): string | undefined {
  const systemParts: string[] = [];
  for (const msg of messages) {
    if (msg.role === "system" || msg.role === "developer") {
      systemParts.push(extractText(msg.content));
    }
  }
  return systemParts.length > 0 ? systemParts.join("\n") : undefined;
}

/**
 * Convert OpenAI messages array to a single prompt string for Claude CLI
 *
 * Claude Code CLI in --print mode expects a single prompt, not a conversation.
 * System messages are extracted separately (passed via --append-system-prompt).
 */
export function messagesToPrompt(messages: OpenAIChatRequest["messages"]): string {
  const parts: string[] = [];

  for (const msg of messages) {
    const text = extractText(msg.content);
    switch (msg.role) {
      case "system":
      case "developer":
        // System messages handled via --append-system-prompt, skip here
        break;

      case "user":
        // User messages are the main prompt
        parts.push(text);
        break;

      case "assistant":
        // Previous assistant responses for context
        parts.push(`<previous_response>\n${text}\n</previous_response>\n`);
        break;
    }
  }

  return parts.join("\n").trim();
}

export const JSON_MODE_INSTRUCTION = "IMPORTANT: You must respond with a single valid JSON object only. No markdown, no code fences, no explanation, no extra text before or after the JSON. Output raw JSON only.";

// Structural JSON-schema keys that constrain the shape of the output.
// Free-text fields (description, title, $comment, examples, $id, $ref, $schema, $defs, definitions)
// are stripped to prevent prompt injection via schema.
const SCHEMA_STRUCTURAL_KEYS = new Set([
  "type", "required", "items", "enum", "const",
  "additionalProperties", "minItems", "maxItems", "uniqueItems",
  "minLength", "maxLength",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "format", "pattern", "oneOf", "anyOf", "allOf", "not", "nullable",
  "minProperties", "maxProperties",
]);

// Keys whose values are dictionaries of user-named fields to schemas.
// Field names are preserved (they are the output field names the LLM must produce);
// schema values are recursively sanitized.
const SCHEMA_DICT_KEYS = new Set(["properties", "patternProperties"]);

const SAFE_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

function sanitizeSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeSchema);
  }
  if (value && typeof value === "object") {
    const input = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(input)) {
      if (SCHEMA_DICT_KEYS.has(key) && v && typeof v === "object" && !Array.isArray(v)) {
        const dict: Record<string, unknown> = {};
        for (const [propName, propSchema] of Object.entries(v as Record<string, unknown>)) {
          dict[propName] = sanitizeSchema(propSchema);
        }
        result[key] = dict;
      } else if (SCHEMA_STRUCTURAL_KEYS.has(key)) {
        result[key] = sanitizeSchema(v);
      }
      // else: drop free-text fields (description/title/$comment/examples/etc.)
    }
    return result;
  }
  return value;
}

function sanitizeSchemaWrapper(wrapper: unknown): object {
  if (!wrapper || typeof wrapper !== "object") return {};
  const w = wrapper as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  if (typeof w.name === "string" && SAFE_NAME_RE.test(w.name)) {
    result.name = w.name;
  }
  if (typeof w.strict === "boolean") {
    result.strict = w.strict;
  }
  if (w.schema !== undefined) {
    result.schema = sanitizeSchema(w.schema);
  }
  return result;
}

function buildJsonInstruction(responseFormat: OpenAIChatRequest["response_format"]): string {
  if (responseFormat?.type === "json_schema" && responseFormat.json_schema) {
    const sanitized = sanitizeSchemaWrapper(responseFormat.json_schema);
    const schemaJson = JSON.stringify(sanitized);
    return `IMPORTANT: You must respond with a single valid JSON object that conforms to this schema:\n${schemaJson}\nNo markdown, no code fences, no explanation, no extra text before or after the JSON. Output raw JSON only.`;
  }
  return JSON_MODE_INSTRUCTION;
}

/**
 * Convert OpenAI chat request to CLI input format
 */
export function openaiToCli(request: OpenAIChatRequest): CliInput {
  const jsonMode = request.response_format?.type === "json_object" || request.response_format?.type === "json_schema";
  let systemPrompt = extractSystemPrompt(request.messages);

  if (jsonMode) {
    const instruction = buildJsonInstruction(request.response_format);
    systemPrompt = systemPrompt
      ? `${systemPrompt}\n\n${instruction}`
      : instruction;
  }

  return {
    prompt: messagesToPrompt(request.messages),
    model: extractModel(request.model),
    systemPrompt,
    sessionId: request.user,
    jsonMode,
  };
}
