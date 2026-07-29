/**
 * Whole-run token totals from a CLI result.
 *
 * A result reports its tokens twice: `usage` covers the main chain only, while
 * `modelUsage` covers every model the run touched, sidechains included. The two
 * agree exactly when no subagent ran, so the per-model totals are the truth
 * whenever the run reported any — reading `usage` alone drops everything a
 * subagent spent, which the caller is still billed for.
 */

import type { ClaudeCliResult } from "../types/claude-cli.js";

/** Per-model usage as the Claude CLI reports it in a result message. */
export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

export interface RunTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * Sum the per-model totals, falling back to the run totals for anything the
 * models did not report: no model at all (a failed run, or the codex adapter's
 * synthesized empty map), and each cache field independently — those are
 * optional per model while input/output are not, so an absent one is a gap
 * rather than a measured zero and must not zero a count the run still carries.
 */
export function aggregateRunTokens(
  modelUsage: Record<string, ModelUsage | undefined> | undefined,
  fallback: RunTokens,
): RunTokens {
  const entries = Object.values(modelUsage ?? {});
  if (entries.length === 0) return { ...fallback };

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead: number | undefined;
  let cacheWrite: number | undefined;

  for (const usage of entries) {
    inputTokens += usage?.inputTokens ?? 0;
    outputTokens += usage?.outputTokens ?? 0;
    if (usage?.cacheReadInputTokens !== undefined) {
      cacheRead = (cacheRead ?? 0) + usage.cacheReadInputTokens;
    }
    if (usage?.cacheCreationInputTokens !== undefined) {
      cacheWrite = (cacheWrite ?? 0) + usage.cacheCreationInputTokens;
    }
  }

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: cacheRead ?? fallback.cacheReadTokens,
    cacheWriteTokens: cacheWrite ?? fallback.cacheWriteTokens,
  };
}

/** The same aggregation, back in the result's own `usage` shape. */
export function runUsage(
  result:
    | {
        usage?: ClaudeCliResult["usage"];
        modelUsage?: Record<string, ModelUsage | undefined>;
      }
    | undefined,
): ClaudeCliResult["usage"] {
  const totals = aggregateRunTokens(result?.modelUsage, {
    inputTokens: result?.usage?.input_tokens ?? 0,
    outputTokens: result?.usage?.output_tokens ?? 0,
    cacheReadTokens: result?.usage?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: result?.usage?.cache_creation_input_tokens ?? 0,
  });

  return {
    input_tokens: totals.inputTokens,
    output_tokens: totals.outputTokens,
    cache_read_input_tokens: totals.cacheReadTokens,
    cache_creation_input_tokens: totals.cacheWriteTokens,
  };
}
