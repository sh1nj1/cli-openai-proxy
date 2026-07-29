import { test } from "node:test";
import assert from "node:assert/strict";
import { runUsage } from "./run-usage.js";

const MAIN_CHAIN = {
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: 1_000,
  cache_creation_input_tokens: 2_000,
};

test("keeps the main chain's cache when only a sidechain reported the field", () => {
  // Cache detail is optional per model, so a run can report it for one model and
  // not another. Treating any single report as the whole run's total discards
  // the main chain's own bucket — the one count the run states outright.
  const usage = runUsage({
    mainChainModel: "claude-opus-5",
    usage: MAIN_CHAIN,
    modelUsage: {
      "claude-opus-5": { inputTokens: 10, outputTokens: 5 },
      "claude-haiku-4-5": {
        inputTokens: 2,
        outputTokens: 40,
        cacheReadInputTokens: 5_000,
        cacheCreationInputTokens: 6_000,
      },
    },
  });

  assert.equal(usage?.cache_read_input_tokens, 6_000);
  assert.equal(usage?.cache_creation_input_tokens, 8_000);
});

test("does not re-add the main chain's cache when its own entry reported it", () => {
  // The entry already carries those tokens; folding the top-level totals in
  // again would bill the main chain's cache twice.
  const usage = runUsage({
    mainChainModel: "claude-opus-5",
    usage: MAIN_CHAIN,
    modelUsage: {
      "claude-opus-5": {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 1_000,
        cacheCreationInputTokens: 2_000,
      },
      "claude-haiku-4-5": { inputTokens: 2, outputTokens: 40 },
    },
  });

  assert.equal(usage?.cache_read_input_tokens, 1_000);
  assert.equal(usage?.cache_creation_input_tokens, 2_000);
});

test("matches the main chain across the context-window suffix on a usage key", () => {
  // `modelUsage` keys carry the context window (`claude-opus-5[1m]`) while the
  // init message names the model alone, so the two only match once stripped.
  const usage = runUsage({
    mainChainModel: "claude-opus-5",
    usage: MAIN_CHAIN,
    modelUsage: {
      "claude-opus-5[1m]": { inputTokens: 10, outputTokens: 5 },
      "claude-haiku-4-5": { inputTokens: 2, outputTokens: 40, cacheReadInputTokens: 5_000 },
    },
  });

  assert.equal(usage?.cache_read_input_tokens, 6_000);
});

test("falls back to the run totals when no entry reported cache at all", () => {
  // Unchanged behaviour, and the same rule: the main chain omitted the field, so
  // its top-level bucket stands in — here nothing else reported one to add to.
  const usage = runUsage({
    mainChainModel: "claude-opus-5",
    usage: MAIN_CHAIN,
    modelUsage: {
      "claude-opus-5": { inputTokens: 10, outputTokens: 5 },
      "claude-haiku-4-5": { inputTokens: 2, outputTokens: 40 },
    },
  });

  assert.equal(usage?.cache_read_input_tokens, 1_000);
  assert.equal(usage?.cache_creation_input_tokens, 2_000);
});

test("keeps the all-or-nothing fallback when the run never named its main chain", () => {
  // Without the name there is no way to tell whether the top-level bucket is
  // already inside the reported sum, so adding it could double-count.
  const usage = runUsage({
    usage: MAIN_CHAIN,
    modelUsage: {
      "claude-opus-5": { inputTokens: 10, outputTokens: 5 },
      "claude-haiku-4-5": { inputTokens: 2, outputTokens: 40, cacheReadInputTokens: 5_000 },
    },
  });

  assert.equal(usage?.cache_read_input_tokens, 5_000);
  assert.equal(usage?.cache_creation_input_tokens, 2_000);
});
