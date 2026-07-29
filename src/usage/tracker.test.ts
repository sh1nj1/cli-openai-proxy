import { test } from "node:test";
import assert from "node:assert/strict";
import type { PathLike } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  UsageTracker,
  billedModel,
  DATA_DIR_NAME,
  LEGACY_DATA_DIR_NAME,
} from "./tracker.js";

const SAMPLE_RECORD = {
  timestamp: 1_700_000_000_000,
  model: "sonnet",
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  durationMs: 1234,
  estimatedApiCostUsd: 0.001,
  stream: false,
  success: true,
};

async function withFakeHome(
  fn: (home: string) => Promise<void>,
): Promise<void> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tracker-home-"));
  const realHome = process.env.HOME;
  process.env.HOME = home;
  try {
    await fn(home);
  } finally {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    await fs.rm(home, { recursive: true, force: true });
  }
}

async function seed(dir: string, records: unknown[]): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "usage.json"),
    JSON.stringify({ records, startedAt: 1_600_000_000_000 }),
  );
}

test("adopts the pre-rename data directory instead of starting empty", async () => {
  await withFakeHome(async (home) => {
    await seed(path.join(home, LEGACY_DATA_DIR_NAME), [SAMPLE_RECORD]);

    const tracker = new UsageTracker();
    await tracker.load();

    assert.equal(tracker.getSummary().totalRequests, 1);
    // The legacy directory is moved, not copied, so there is one source of truth.
    await assert.rejects(() => fs.access(path.join(home, LEGACY_DATA_DIR_NAME)));
    await fs.access(path.join(home, DATA_DIR_NAME, "usage.json"));
  });
});

test("leaves an existing new-layout directory alone", async () => {
  await withFakeHome(async (home) => {
    await seed(path.join(home, DATA_DIR_NAME), [SAMPLE_RECORD, SAMPLE_RECORD]);
    await seed(path.join(home, LEGACY_DATA_DIR_NAME), [SAMPLE_RECORD]);

    const tracker = new UsageTracker();
    await tracker.load();

    // Migration must not overwrite data already written under the new name.
    assert.equal(tracker.getSummary().totalRequests, 2);
    await fs.access(path.join(home, LEGACY_DATA_DIR_NAME, "usage.json"));
  });
});

test("uses the new directory when another process wins the migration race", async (t) => {
  await withFakeHome(async (home) => {
    const legacyDir = path.join(home, LEGACY_DATA_DIR_NAME);
    const dataDir = path.join(home, DATA_DIR_NAME);
    await seed(legacyDir, [SAMPLE_RECORD]);

    const realRename = fs.rename.bind(fs);
    t.mock.method(fs, "rename", async (oldPath: PathLike, newPath: PathLike) => {
      // Model the other process completing the move after both initial access
      // checks, but before this process's rename returns its source-missing error.
      await realRename(oldPath, newPath);
      throw new Error("ENOENT: migration source was moved by another process");
    });

    const tracker = new UsageTracker();
    await tracker.load();

    assert.equal(tracker.getSummary().totalRequests, 1);
    await fs.access(path.join(dataDir, "usage.json"));
    await assert.rejects(() => fs.access(legacyDir));
  });
});

test("starts empty when neither directory exists", async () => {
  await withFakeHome(async () => {
    const tracker = new UsageTracker();
    await tracker.load();

    assert.equal(tracker.getSummary().totalRequests, 0);
  });
});

test("never migrates into an explicitly supplied directory", async () => {
  await withFakeHome(async (home) => {
    await seed(path.join(home, LEGACY_DATA_DIR_NAME), [SAMPLE_RECORD]);
    const explicit = path.join(home, "explicit");

    const tracker = new UsageTracker(explicit);
    await tracker.load();

    assert.equal(tracker.getSummary().totalRequests, 0);
    await fs.access(path.join(home, LEGACY_DATA_DIR_NAME, "usage.json"));
  });
});

// A request id names an adapter, not a model: `paperclip/claude_local` runs whatever
// the CLI's current default is. Pricing must follow what actually ran, or /v1/usage
// reports Sonnet rates for an Opus run and understates the saved cost ~5x.
const modelUsage = (entries: Record<string, number>) =>
  Object.fromEntries(
    Object.entries(entries).map(([model, outputTokens]) => [
      model,
      { inputTokens: 0, outputTokens, costUSD: 0 },
    ]),
  );

test("bills an adapter-only id by the model the CLI reported running", () => {
  assert.equal(
    billedModel({ modelUsage: modelUsage({ "claude-opus-5[1m]": 5 }) }, "paperclip/claude_local"),
    "claude-opus-5[1m]",
  );
});

test("bills the dominant model when subagents ran on another one", () => {
  assert.equal(
    billedModel(
      { modelUsage: modelUsage({ "claude-haiku-4-5": 20, "claude-opus-5": 900 }) },
      "paperclip/claude_local",
    ),
    "claude-opus-5",
  );
});

test("falls back to the requested id when the run reported no model", () => {
  // Failed runs produce no result at all, and codex-jsonl synthesizes an empty
  // modelUsage — neither knows more than the request did.
  assert.equal(billedModel(null, "paperclip/claude_local/opus"), "paperclip/claude_local/opus");
  assert.equal(billedModel({ modelUsage: {} }, "paperclip/codex_local"), "paperclip/codex_local");
});

test("records an adapter-only Claude run at Opus pricing", async () => {
  await withFakeHome(async (home) => {
    const tracker = new UsageTracker(path.join(home, "usage"));
    await tracker.load();

    tracker.record({
      model: billedModel({ modelUsage: modelUsage({ "claude-opus-5[1m]": 1_000_000 }) },
        "paperclip/claude_local"),
      inputTokens: 0,
      outputTokens: 1_000_000,
      durationMs: 1,
      stream: false,
      success: true,
    });

    const { byModel } = tracker.getSummary();
    assert.deepEqual(Object.keys(byModel), ["opus"]);
    assert.equal(byModel.opus.estimatedCostUsd, 75);
  });
});
