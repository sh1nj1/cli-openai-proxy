/**
 * Converts Claude CLI output to OpenAI-compatible response format
 */

import type { ClaudeCliResult } from "../types/claude-cli.js";
import type { OpenAIChatResponse, OpenAIChatChunk, OpenAIUsage } from "../types/openai.js";
import { runUsage } from "../usage/run-usage.js";

/**
 * Map CLI token counts onto the OpenAI usage object.
 *
 * The CLI reports the three input buckets disjointly (input_tokens excludes both
 * cache fields), while OpenAI's prompt_tokens is the whole prompt with
 * prompt_tokens_details.cached_tokens as the cached subset of it. Echoing
 * input_tokens alone would report 2 prompt tokens for a 30k-token cached turn.
 * Cache writes have no OpenAI counterpart, so they fold into prompt_tokens —
 * which is where they are billed anyway.
 */
export function cliUsageToOpenai(usage: ClaudeCliResult["usage"] | undefined): OpenAIUsage {
  const cachedTokens = usage?.cache_read_input_tokens || 0;
  const promptTokens =
    (usage?.input_tokens || 0) + cachedTokens + (usage?.cache_creation_input_tokens || 0);
  const completionTokens = usage?.output_tokens || 0;

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: { cached_tokens: cachedTokens },
  };
}

/**
 * Terminal usage chunk for a stream_options.include_usage request. Its `choices`
 * is empty per the OpenAI contract — the answer already streamed.
 */
export function createUsageChunk(
  requestId: string,
  requestedModel: string,
  result: ClaudeCliResult | undefined,
): OpenAIChatChunk {
  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [],
    usage: cliUsageToOpenai(runUsage(result)),
  };
}

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
    usage: cliUsageToOpenai(runUsage(result)),
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
