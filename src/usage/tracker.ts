/**
 * Usage Tracker
 *
 * Tracks token usage, request counts, and estimated cost savings.
 * Persists to disk so usage data survives restarts.
 */

import fs from "fs/promises";
import path from "path";

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

/** Pricing family a model id belongs to. Unknown ids are priced as Sonnet. */
function pricingFamily(model: string): string {
  const id = model.toLowerCase();
  if (id.includes("opus")) return "opus";
  if (id.includes("haiku")) return "haiku";
  return "sonnet";
}

function cost(family: string, inputTokens: number, outputTokens: number): number {
  const pricing = PRICING[family];
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}

/** Per-model usage as the Claude CLI reports it in a result message. */
export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

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
 * Token totals come from `modelUsage` too. Measured against the CLI: top-level
 * `usage` covers the main chain only while `modelUsage` includes sidechains, and
 * they match exactly when no subagent ran — so the fallback totals are only for
 * runs that reported no model at all (a failure, or codex-jsonl's synthesized
 * empty `modelUsage`), plus a cache field no entry reported at all, which would
 * otherwise zero a count the run totals still carry.
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
  const entries = Object.entries(result?.modelUsage ?? {});

  if (entries.length === 0) {
    const family = pricingFamily(fallback.model);
    return {
      model: family,
      inputTokens: fallback.inputTokens,
      outputTokens: fallback.outputTokens,
      cacheReadTokens: fallback.cacheReadTokens ?? 0,
      cacheWriteTokens: fallback.cacheWriteTokens ?? 0,
      costUsd: cost(family, fallback.inputTokens, fallback.outputTokens),
    };
  }

  const billed: BilledRun = {
    model: "sonnet",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  };
  let dominantOutput = -1;
  // Undefined until some entry reports the field, so an absent one keeps the
  // run total rather than zeroing it — the cache fields are optional per model
  // while input/output are not.
  let cacheRead: number | undefined;
  let cacheWrite: number | undefined;

  for (const [model, usage] of entries) {
    const inputTokens = usage?.inputTokens ?? 0;
    const outputTokens = usage?.outputTokens ?? 0;

    billed.inputTokens += inputTokens;
    billed.outputTokens += outputTokens;
    billed.costUsd += cost(pricingFamily(model), inputTokens, outputTokens);

    if (usage?.cacheReadInputTokens !== undefined) {
      cacheRead = (cacheRead ?? 0) + usage.cacheReadInputTokens;
    }
    if (usage?.cacheCreationInputTokens !== undefined) {
      cacheWrite = (cacheWrite ?? 0) + usage.cacheCreationInputTokens;
    }

    if (outputTokens > dominantOutput) {
      dominantOutput = outputTokens;
      billed.model = pricingFamily(model);
    }
  }

  billed.cacheReadTokens = cacheRead ?? fallback.cacheReadTokens ?? 0;
  billed.cacheWriteTokens = cacheWrite ?? fallback.cacheWriteTokens ?? 0;

  return billed;
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
