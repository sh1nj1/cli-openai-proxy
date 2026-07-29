/**
 * Converts Claude CLI output to OpenAI-compatible response format
 */

import type { ClaudeCliResult } from "../types/claude-cli.js";
import type { OpenAIChatResponse, OpenAIChatChunk } from "../types/openai.js";

/**
 * Create a final "done" chunk for streaming
 */
export function createDoneChunk(requestId: string, requestedModel: string): OpenAIChatChunk {
  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "stop",
      },
    ],
  };
}

/**
 * Convert Claude CLI result to OpenAI non-streaming response
 */
export function cliResultToOpenai(
  result: ClaudeCliResult,
  requestId: string,
  requestedModel: string,
  jsonMode?: boolean
): OpenAIChatResponse {
  const content = jsonMode ? extractJsonFromText(result.result) : result.result;

  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    // Echoed verbatim: gateways route and validate on this field, so it has to
    // stay an id the proxy accepts, not one derived from what the CLI reports.
    model: requestedModel,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: result.usage?.input_tokens || 0,
      completion_tokens: result.usage?.output_tokens || 0,
      total_tokens:
        (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0),
    },
  };
}

/**
 * Extract JSON from text that may contain markdown fences or surrounding explanation.
 * Returns the original text if no JSON is found or if it's already valid JSON.
 */
export function extractJsonFromText(text: string): string {
  const trimmed = text.trim();
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    // Try extracting from markdown code fences
    const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenceMatch) {
      const candidate = fenceMatch[1].trim();
      try {
        JSON.parse(candidate);
        return candidate;
      } catch { /* fall through */ }
    }

    // Try finding the first { ... } or [ ... ] block
    const braceStart = trimmed.indexOf("{");
    const bracketStart = trimmed.indexOf("[");
    const start = braceStart === -1 ? bracketStart
      : bracketStart === -1 ? braceStart
      : Math.min(braceStart, bracketStart);

    if (start !== -1) {
      const open = trimmed[start];
      const close = open === "{" ? "}" : "]";
      let depth = 0;
      let inString = false;
      let escape = false;
      for (let i = start; i < trimmed.length; i++) {
        const ch = trimmed[i];
        if (escape) { escape = false; continue; }
        if (ch === "\\") { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === open) depth++;
        else if (ch === close) {
          depth--;
          if (depth === 0) {
            const candidate = trimmed.slice(start, i + 1);
            try {
              JSON.parse(candidate);
              return candidate;
            } catch { break; }
          }
        }
      }
    }
  }
  return text;
}
