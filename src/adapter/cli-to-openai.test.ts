import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createDoneChunk,
  createUsageChunk,
  cliResultToOpenai,
  cliUsageToOpenai,
  extractJsonFromText,
} from "./cli-to-openai.js";
import type { ClaudeCliResult } from "../types/claude-cli.js";

const makeResult = (text: string): ClaudeCliResult => ({
  type: "result",
  subtype: "success",
  is_error: false,
  duration_ms: 1000,
  duration_api_ms: 800,
  num_turns: 1,
  result: text,
  session_id: "sess-1",
  total_cost_usd: 0.01,
  usage: { input_tokens: 100, output_tokens: 50 },
  modelUsage: {
    "claude-sonnet-4": { inputTokens: 100, outputTokens: 50, costUSD: 0.01 },
  },
});

/**
 * A run that spawned a subagent: `usage` reports the main chain only, while
 * `modelUsage` reports every model the run touched.
 */
const makeSidechainResult = (): ClaudeCliResult => ({
  ...makeResult("Done"),
  usage: { input_tokens: 2, output_tokens: 7, cache_read_input_tokens: 1_000 },
  modelUsage: {
    "claude-opus-5": {
      inputTokens: 2, outputTokens: 7, cacheReadInputTokens: 1_000, costUSD: 0,
    },
    "claude-haiku-4-5": {
      inputTokens: 40, outputTokens: 900, cacheReadInputTokens: 5_000, costUSD: 0,
    },
  },
});

describe("createDoneChunk", () => {
  it("creates a stop chunk", () => {
    const chunk = createDoneChunk("req-1", "paperclip/claude_local");
    assert.equal(chunk.choices[0].finish_reason, "stop");
    assert.deepEqual(chunk.choices[0].delta, {});
  });

  it("echoes the requested id verbatim", () => {
    // A suffix containing "opus" must not collapse the namespaced id: the done
    // chunk has to report the same model as the content chunks before it.
    const chunk = createDoneChunk("req-1", "paperclip/claude_local/opus");
    assert.equal(chunk.model, "paperclip/claude_local/opus");
  });
});

describe("cliUsageToOpenai", () => {
  it("counts cache tokens as prompt tokens", () => {
    // Anthropic reports input_tokens EXCLUDING both cache fields, so echoing it
    // as prompt_tokens undercounts a cache-heavy turn by orders of magnitude
    // (2 vs 30k) for any client that budgets context or estimates cost.
    const usage = cliUsageToOpenai({
      input_tokens: 2,
      output_tokens: 7,
      cache_read_input_tokens: 30_000,
      cache_creation_input_tokens: 500,
    });
    assert.equal(usage.prompt_tokens, 30_502);
    assert.equal(usage.completion_tokens, 7);
    assert.equal(usage.total_tokens, 30_509);
  });

  it("reports the cached portion as prompt_tokens_details.cached_tokens", () => {
    const usage = cliUsageToOpenai({
      input_tokens: 2,
      output_tokens: 7,
      cache_read_input_tokens: 30_000,
      cache_creation_input_tokens: 500,
    });
    assert.equal(usage.prompt_tokens_details?.cached_tokens, 30_000);
  });

  it("reports zero cached tokens when the run had no cache hits", () => {
    const usage = cliUsageToOpenai({ input_tokens: 100, output_tokens: 50 });
    assert.equal(usage.prompt_tokens, 100);
    assert.equal(usage.prompt_tokens_details?.cached_tokens, 0);
  });

  it("reports zeroes for a missing usage block", () => {
    const usage = cliUsageToOpenai(undefined);
    assert.equal(usage.prompt_tokens, 0);
    assert.equal(usage.completion_tokens, 0);
    assert.equal(usage.total_tokens, 0);
  });
});

describe("createUsageChunk", () => {
  it("carries usage with no choices", () => {
    // The OpenAI streaming contract puts the terminal usage on a chunk whose
    // choices array is empty — a client that reads choices[0] must see nothing.
    const chunk = createUsageChunk("req-1", "paperclip/codex_local", makeResult("hi"));
    assert.deepEqual(chunk.choices, []);
    assert.equal(chunk.usage?.prompt_tokens, 100);
    assert.equal(chunk.usage?.completion_tokens, 50);
    assert.equal(chunk.object, "chat.completion.chunk");
    assert.equal(chunk.model, "paperclip/codex_local");
  });

  it("counts subagent tokens the main chain never saw", () => {
    const chunk = createUsageChunk("req-1", "paperclip/claude_local", makeSidechainResult());
    assert.equal(chunk.usage?.prompt_tokens, 6_042);
    assert.equal(chunk.usage?.completion_tokens, 907);
  });
});

describe("cliResultToOpenai", () => {
  it("converts result to OpenAI response", () => {
    const response = cliResultToOpenai(makeResult("Hello!"), "req-1", "paperclip/claude_local");
    assert.equal(response.object, "chat.completion");
    assert.equal(response.choices[0].message.content, "Hello!");
    assert.equal(response.choices[0].message.role, "assistant");
    assert.equal(response.choices[0].finish_reason, "stop");
  });

  it("includes token usage", () => {
    const response = cliResultToOpenai(makeResult("Hello!"), "req-1", "paperclip/claude_local");
    assert.equal(response.usage.prompt_tokens, 100);
    assert.equal(response.usage.completion_tokens, 50);
    assert.equal(response.usage.total_tokens, 150);
  });

  it("counts subagent tokens the main chain never saw", () => {
    // Anything a subagent spent is billed to the caller but absent from `usage`,
    // so reporting the main chain alone can undercount an agentic turn by orders
    // of magnitude — here 907 completion tokens reported as 7.
    const response = cliResultToOpenai(makeSidechainResult(), "req-1", "paperclip/claude_local");
    assert.equal(response.usage.prompt_tokens, 6_042);
    assert.equal(response.usage.completion_tokens, 907);
    assert.equal(response.usage.total_tokens, 6_949);
    assert.equal(response.usage.prompt_tokens_details?.cached_tokens, 6_000);
  });

  it("falls back to the run totals when no model was reported", () => {
    // codex synthesizes an empty modelUsage, and a failed run reports none at all.
    const result = { ...makeResult("Hello!"), modelUsage: {} };
    const response = cliResultToOpenai(result, "req-1", "paperclip/codex_local");
    assert.equal(response.usage.prompt_tokens, 100);
    assert.equal(response.usage.completion_tokens, 50);
  });

  it("keeps run cache totals when no model reported a cache field", () => {
    // An absent per-model field is a gap, not a measured zero — zeroing it would
    // drop a cache count the run totals still carry.
    const result: ClaudeCliResult = {
      ...makeResult("Hello!"),
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 500 },
      modelUsage: { "claude-opus-5": { inputTokens: 100, outputTokens: 50, costUSD: 0 } },
    };
    const response = cliResultToOpenai(result, "req-1", "paperclip/claude_local");
    assert.equal(response.usage.prompt_tokens_details?.cached_tokens, 500);
    assert.equal(response.usage.prompt_tokens, 600);
  });

  it("echoes the requested id verbatim", () => {
    // Gateways route and validate on the response model, so it has to stay an id
    // the proxy itself still accepts — not a legacy alias derived from a substring.
    const response = cliResultToOpenai(makeResult("Hello!"), "req-1", "paperclip/claude_local/opus");
    assert.equal(response.model, "paperclip/claude_local/opus");
  });

  it("ignores the CLI-reported model", () => {
    const response = cliResultToOpenai(makeResult("Hello!"), "req-1", "paperclip/codex_local/gpt-5.4-mini");
    assert.equal(response.model, "paperclip/codex_local/gpt-5.4-mini");
  });

  it("extracts JSON from mixed content in jsonMode", () => {
    const mixed = '여기 마법입니다:\n```json\n{"name":"메테오"}\n```\n설명입니다.';
    const response = cliResultToOpenai(makeResult(mixed), "req-1", "paperclip/claude_local", true);
    assert.equal(response.choices[0].message.content, '{"name":"메테오"}');
  });

  it("returns raw content when jsonMode is false", () => {
    const mixed = 'Some text {"key":"val"} more text';
    const response = cliResultToOpenai(makeResult(mixed), "req-1", "paperclip/claude_local", false);
    assert.equal(response.choices[0].message.content, mixed);
  });
});

describe("extractJsonFromText", () => {
  it("returns valid JSON as-is", () => {
    const json = '{"name":"test","value":42}';
    assert.equal(extractJsonFromText(json), json);
  });

  it("extracts JSON from markdown code fence", () => {
    const text = 'Here is the spell:\n```json\n{"name":"메테오","element":"red"}\n```\nDesign rationale...';
    assert.equal(extractJsonFromText(text), '{"name":"메테오","element":"red"}');
  });

  it("extracts JSON from code fence without language tag", () => {
    const text = '```\n{"key":"value"}\n```';
    assert.equal(extractJsonFromText(text), '{"key":"value"}');
  });

  it("extracts JSON object from surrounding text", () => {
    const text = 'Here is my answer: {"name":"fireball","blocks":[]} and that is it.';
    assert.equal(extractJsonFromText(text), '{"name":"fireball","blocks":[]}');
  });

  it("extracts JSON array from surrounding text", () => {
    const text = 'Results: [{"a":1},{"b":2}] done.';
    assert.equal(extractJsonFromText(text), '[{"a":1},{"b":2}]');
  });

  it("handles nested braces correctly", () => {
    const json = '{"outer":{"inner":{"deep":true}}}';
    const text = `Some prefix ${json} some suffix`;
    assert.equal(extractJsonFromText(text), json);
  });

  it("handles strings with braces inside", () => {
    const json = '{"msg":"hello {world}"}';
    const text = `prefix ${json} suffix`;
    assert.equal(extractJsonFromText(text), json);
  });

  it("returns original text if no valid JSON found", () => {
    const text = "This is just plain text with no JSON.";
    assert.equal(extractJsonFromText(text), text);
  });
});
