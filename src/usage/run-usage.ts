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
 * Whether a `modelUsage` key and an init-message model name the same model.
 *
 * The key carries the context window (`claude-opus-5[1m]`) where the init
 * message names the model alone, so the two only line up once that is stripped.
 */
function sameModel(usageKey: string, model: string): boolean {
  const bare = (id: string) => id.toLowerCase().replace(/\[[^\]]*\]$/, "");
  return bare(usageKey) === bare(model);
}

/**
 * Sum the per-model totals, falling back to the run totals for anything the
 * models did not report.
 *
 * Input and output are always reported, so their sum is complete. Cache detail
 * is optional per model, which makes an absent field a gap rather than a
 * measured zero — and the run totals cover exactly one gap, the main chain's,
 * since that is whose tokens they are. So the main chain's bucket is added back
 * when its own entry omitted the field, whether or not some other model reported
 * one: taking any single report as the whole run's total drops the one count the
 * run states outright. With no model reported at all (a failed run, or the codex
 * adapter's synthesized empty map) the run totals stand alone.
 *
 * A run that never named its main chain keeps the older all-or-nothing rule —
 * without the name there is no telling whether the run totals are already inside
 * the reported sum, and double-counting them is the worse error.
 */
export function aggregateRunTokens(
  modelUsage: Record<string, ModelUsage | undefined> | undefined,
  fallback: RunTokens,
  mainChainModel?: string,
): RunTokens {
  const entries = Object.entries(modelUsage ?? {});
  if (entries.length === 0) return { ...fallback };

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead: number | undefined;
  let cacheWrite: number | undefined;
  let mainChainSeen = false;
  let mainChainRead = false;
  let mainChainWrite = false;

  for (const [name, usage] of entries) {
    inputTokens += usage?.inputTokens ?? 0;
    outputTokens += usage?.outputTokens ?? 0;
    const isMainChain = mainChainModel !== undefined && sameModel(name, mainChainModel);
    mainChainSeen ||= isMainChain;
    if (usage?.cacheReadInputTokens !== undefined) {
      cacheRead = (cacheRead ?? 0) + usage.cacheReadInputTokens;
      mainChainRead ||= isMainChain;
    }
    if (usage?.cacheCreationInputTokens !== undefined) {
      cacheWrite = (cacheWrite ?? 0) + usage.cacheCreationInputTokens;
      mainChainWrite ||= isMainChain;
    }
  }

  const withMainChain = (
    reported: number | undefined,
    accounted: boolean,
    runTotal: number,
  ) => mainChainSeen
    ? (reported ?? 0) + (accounted ? 0 : runTotal)
    : reported ?? runTotal;

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: withMainChain(cacheRead, mainChainRead, fallback.cacheReadTokens),
    cacheWriteTokens: withMainChain(cacheWrite, mainChainWrite, fallback.cacheWriteTokens),
  };
}

/** The same aggregation, back in the result's own `usage` shape. */
export function runUsage(
  result:
    | {
        usage?: ClaudeCliResult["usage"];
        modelUsage?: Record<string, ModelUsage | undefined>;
        mainChainModel?: string;
      }
    | undefined,
): ClaudeCliResult["usage"] {
  const totals = aggregateRunTokens(
    result?.modelUsage,
    {
      inputTokens: result?.usage?.input_tokens ?? 0,
      outputTokens: result?.usage?.output_tokens ?? 0,
      cacheReadTokens: result?.usage?.cache_read_input_tokens ?? 0,
      cacheWriteTokens: result?.usage?.cache_creation_input_tokens ?? 0,
    },
    result?.mainChainModel,
  );

  return {
    input_tokens: totals.inputTokens,
    output_tokens: totals.outputTokens,
    cache_read_input_tokens: totals.cacheReadTokens,
    cache_creation_input_tokens: totals.cacheWriteTokens,
  };
}
