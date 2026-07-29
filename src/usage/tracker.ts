/**
 * Usage Tracker
 *
 * Tracks token usage, request counts, and estimated cost savings.
 * Persists to disk so usage data survives restarts.
 */

import fs from "fs/promises";
import path from "path";
import { aggregateRunTokens, type ModelUsage, type RunTokens } from "./run-usage.js";

export interface RequestRecord {
  timestamp: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  durationMs: number;
  estimatedApiCostUsd: number;
  stream: boolean;
  success: boolean;
}

export interface UsageSummary {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  estimatedApiCostSavedUsd: number;
  avgResponseMs: number;
  byModel: Record<string, {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
  }>;
  since: number;
  lastRequest: number | null;
}

// Anthropic API pricing (per million tokens)
const PRICING: Record<string, { input: number; output: number }> = {
  opus:   { input: 15.00, output: 75.00 },
  sonnet: { input: 3.00,  output: 15.00 },
  haiku:  { input: 0.25,  output: 1.25  },
};

const PER_MILLION = 1_000_000;

// Cached prompt tokens are billed off the input rate, not free: a cache read
// costs a tenth of it, writing the cache 1.25x (5-minute TTL). The tenth is
// applied as a divisor rather than a 0.1 multiplier because 0.1 is not
// binary-exact — see cost().
const CACHE_READ_DIVISOR = PER_MILLION * 10;
const CACHE_WRITE_RATE = 1.25;

/** Pricing family a model id belongs to. Unknown ids are priced as Sonnet. */
function pricingFamily(model: string): string {
  const id = model.toLowerCase();
  if (id.includes("opus")) return "opus";
  if (id.includes("haiku")) return "haiku";
  return "sonnet";
}

/**
 * Token counts are integers and the per-million rates are binary-exact, so
 * scaling each bucket by its rate first and dividing once keeps the dollars
 * exact. Folding the buckets into a token subtotal via a 0.1 multiplier instead
 * leaves a ulp of dust in every cached run.
 */
function cost(family: string, tokens: RunTokens): number {
  const pricing = PRICING[family];
  return (tokens.inputTokens * pricing.input) / PER_MILLION
    + (tokens.cacheReadTokens * pricing.input) / CACHE_READ_DIVISOR
    + (tokens.cacheWriteTokens * pricing.input * CACHE_WRITE_RATE) / PER_MILLION
    + (tokens.outputTokens * pricing.output) / PER_MILLION;
}

/**
 * Round a cost for a reader. Only ever applied on the way out: rounding what a
 * run stores would bias the running total, since a short Haiku turn costs less
 * than the increment being rounded to.
 */
export function displayCostUsd(usd: number): number {
  return Math.round(usd * PER_MILLION) / PER_MILLION;
}

export type { ModelUsage };

export interface BilledRun {
  /** Pricing family the run is grouped under in `byModel`. */
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

/**
 * Price one run from what the CLI reported running.
 *
 * A requested id names an adapter, not a model — `paperclip/claude_local` runs
 * whatever the CLI's own default currently is, so pricing the adapter id would
 * bill an Opus run at Sonnet rates. `modelUsage` says what actually ran, and a
 * turn can span families (subagents), so every entry is priced at its own rate:
 * one family over the whole run is wrong in both directions — a verbose Haiku
 * sidechain would drag an Opus turn down, a short Opus answer would bill a large
 * Haiku sidechain up.
 *
 * Token totals come from `modelUsage` too — see aggregateRunTokens.
 *
 * The run stays one record, labelled with the family that produced the most
 * output, so request counts stay honest and a Haiku sidechain does not relabel
 * an Opus turn.
 */
export function billRun(
  result: { modelUsage?: Record<string, ModelUsage> } | null | undefined,
  fallback: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  },
): BilledRun {
  const tokens = aggregateRunTokens(result?.modelUsage, {
    inputTokens: fallback.inputTokens,
    outputTokens: fallback.outputTokens,
    cacheReadTokens: fallback.cacheReadTokens ?? 0,
    cacheWriteTokens: fallback.cacheWriteTokens ?? 0,
  });

  const entries = Object.entries(result?.modelUsage ?? {});
  if (entries.length === 0) {
    const family = pricingFamily(fallback.model);
    return {
      model: family,
      ...tokens,
      costUsd: cost(family, tokens),
    };
  }

  let model = "sonnet";
  let dominantOutput = -1;
  let costUsd = 0;
  let pricedCacheRead = 0;
  let pricedCacheWrite = 0;

  for (const [name, usage] of entries) {
    const outputTokens = usage?.outputTokens ?? 0;
    const cacheReadTokens = usage?.cacheReadInputTokens ?? 0;
    const cacheWriteTokens = usage?.cacheCreationInputTokens ?? 0;
    pricedCacheRead += cacheReadTokens;
    pricedCacheWrite += cacheWriteTokens;

    costUsd += cost(pricingFamily(name), {
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
    });

    if (outputTokens > dominantOutput) {
      dominantOutput = outputTokens;
      model = pricingFamily(name);
    }
  }

  // Cache detail is optional per model, so the aggregate can carry run totals no
  // entry accounted for. Price the remainder at the dominant family's rate —
  // otherwise cache tokens the record does report would cost nothing.
  costUsd += cost(model, {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: tokens.cacheReadTokens - pricedCacheRead,
    cacheWriteTokens: tokens.cacheWriteTokens - pricedCacheWrite,
  });

  return { model, ...tokens, costUsd };
}

export const DATA_DIR_NAME = ".cli-openai-proxy";
// Pre-rename location. Kept only so an upgrade adopts existing history.
export const LEGACY_DATA_DIR_NAME = ".claude-max-proxy";

// Resolved per instance, not at module load, so HOME stays overridable.
function defaultDataDir(): string {
  return path.join(process.env.HOME || "/tmp", DATA_DIR_NAME);
}

function legacyDataDir(): string {
  return path.join(process.env.HOME || "/tmp", LEGACY_DATA_DIR_NAME);
}

export class UsageTracker {
  private records: RequestRecord[] = [];
  private dataDir: string;
  private legacyDir: string | null;
  private loaded = false;
  private saveDebounce: NodeJS.Timeout | null = null;
  private startedAt: number;

  constructor(dataDir?: string) {
    this.dataDir = dataDir || defaultDataDir();
    // An explicitly chosen directory is the caller's business — never migrate into it.
    this.legacyDir = dataDir ? null : legacyDataDir();
    this.startedAt = Date.now();
  }

  /**
   * Adopt the pre-rename data directory. Without this, renaming the package
   * would silently reset every existing user's usage history to zero — load()
   * treats a missing file as "no data yet", so the loss would be invisible.
   */
  private async migrateLegacyDataDir(): Promise<void> {
    if (this.legacyDir === null) return;

    try {
      await fs.access(this.dataDir);
      return; // already on the new layout
    } catch {
      // new dir absent — a legacy dir may be waiting
    }

    try {
      await fs.access(this.legacyDir);
    } catch {
      return; // nothing to adopt
    }

    try {
      await fs.rename(this.legacyDir, this.dataDir);
    } catch {
      try {
        await fs.access(this.dataDir);
        return; // another process won the migration race
      } catch {
        // destination is still absent — keep using the readable legacy data
      }
      // Read in place rather than start empty; retried on the next boot.
      this.dataDir = this.legacyDir;
    }
  }

  async load(): Promise<void> {
    if (this.loaded) return;

    await this.migrateLegacyDataDir();

    try {
      await fs.mkdir(this.dataDir, { recursive: true });
      const filePath = path.join(this.dataDir, "usage.json");
      const data = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(data);
      this.records = parsed.records || [];
      this.startedAt = parsed.startedAt || Date.now();
      this.loaded = true;
    } catch {
      this.records = [];
      this.loaded = true;
    }
  }

  /**
   * Record a completed request
   */
  record(entry: {
    /** Requested id. Only used when the run reported no model of its own. */
    model: string;
    /** What the CLI reported running, when it reported anything. */
    modelUsage?: Record<string, ModelUsage>;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    durationMs: number;
    stream: boolean;
    success: boolean;
  }): void {
    const billed = billRun({ modelUsage: entry.modelUsage }, entry);

    const record: RequestRecord = {
      timestamp: Date.now(),
      model: billed.model,
      inputTokens: billed.inputTokens,
      outputTokens: billed.outputTokens,
      cacheReadTokens: billed.cacheReadTokens,
      cacheWriteTokens: billed.cacheWriteTokens,
      durationMs: entry.durationMs,
      estimatedApiCostUsd: billed.costUsd,
      stream: entry.stream,
      success: entry.success,
    };

    this.records.push(record);
    this.debouncedSave();
  }

  /**
   * Get usage summary
   */
  getSummary(since?: number): UsageSummary {
    const cutoff = since || 0;
    const filtered = this.records.filter(r => r.timestamp >= cutoff);

    const summary: UsageSummary = {
      totalRequests: filtered.length,
      successfulRequests: filtered.filter(r => r.success).length,
      failedRequests: filtered.filter(r => !r.success).length,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      estimatedApiCostSavedUsd: 0,
      avgResponseMs: 0,
      byModel: {},
      since: this.startedAt,
      lastRequest: filtered.length > 0 ? filtered[filtered.length - 1].timestamp : null,
    };

    let totalDuration = 0;

    for (const r of filtered) {
      summary.totalInputTokens += r.inputTokens;
      summary.totalOutputTokens += r.outputTokens;
      summary.totalCacheReadTokens += r.cacheReadTokens;
      summary.totalCacheWriteTokens += r.cacheWriteTokens;
      summary.estimatedApiCostSavedUsd += r.estimatedApiCostUsd;
      totalDuration += r.durationMs;

      if (!summary.byModel[r.model]) {
        summary.byModel[r.model] = {
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: 0,
        };
      }
      summary.byModel[r.model].requests++;
      summary.byModel[r.model].inputTokens += r.inputTokens;
      summary.byModel[r.model].outputTokens += r.outputTokens;
      summary.byModel[r.model].estimatedCostUsd += r.estimatedApiCostUsd;
    }

    summary.avgResponseMs = filtered.length > 0
      ? Math.round(totalDuration / filtered.length)
      : 0;

    // Round cost to 4 decimal places
    summary.estimatedApiCostSavedUsd = Math.round(summary.estimatedApiCostSavedUsd * 10000) / 10000;
    for (const model of Object.values(summary.byModel)) {
      model.estimatedCostUsd = Math.round(model.estimatedCostUsd * 10000) / 10000;
    }

    return summary;
  }

  /**
   * Get recent requests (last N)
   */
  getRecent(limit: number = 20): RequestRecord[] {
    return this.records.slice(-limit);
  }

  /**
   * Clear all usage data
   */
  async clear(): Promise<void> {
    this.records = [];
    this.startedAt = Date.now();
    await this.save();
  }

  private debouncedSave(): void {
    if (this.saveDebounce) clearTimeout(this.saveDebounce);
    this.saveDebounce = setTimeout(() => this.save(), 5000);
  }

  private async save(): Promise<void> {
    try {
      await fs.mkdir(this.dataDir, { recursive: true });
      const filePath = path.join(this.dataDir, "usage.json");
      await fs.writeFile(filePath, JSON.stringify({
        startedAt: this.startedAt,
        records: this.records,
      }, null, 2));
    } catch (err) {
      console.error("[UsageTracker] Save error:", err);
    }
  }
}

// Singleton
export const usageTracker = new UsageTracker();

// Initialize on load
usageTracker.load().catch(err =>
  console.error("[UsageTracker] Load error:", err)
);
