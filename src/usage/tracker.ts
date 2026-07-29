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
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    durationMs: number;
    stream: boolean;
    success: boolean;
  }): void {
    const cliModel = entry.model.toLowerCase();
    let pricingKey = "sonnet";
    if (cliModel.includes("opus")) pricingKey = "opus";
    else if (cliModel.includes("haiku")) pricingKey = "haiku";

    const pricing = PRICING[pricingKey];
    const estimatedCost =
      (entry.inputTokens / 1_000_000) * pricing.input +
      (entry.outputTokens / 1_000_000) * pricing.output;

    const record: RequestRecord = {
      timestamp: Date.now(),
      model: pricingKey,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      cacheReadTokens: entry.cacheReadTokens || 0,
      cacheWriteTokens: entry.cacheWriteTokens || 0,
      durationMs: entry.durationMs,
      estimatedApiCostUsd: estimatedCost,
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
