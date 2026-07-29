import { test } from "node:test";
import assert from "node:assert/strict";
import type { PathLike } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  UsageTracker,
  billRun,
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
const RUN_TOTALS = {
  model: "paperclip/claude_local",
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

test("bills an adapter-only id by the model the CLI reported running", () => {
  const billed = billRun(
    { modelUsage: { "claude-opus-5[1m]": { inputTokens: 0, outputTokens: 1_000_000 } } },
    { ...RUN_TOTALS, outputTokens: 1_000_000 },
  );
  assert.equal(billed.model, "opus");
  assert.equal(billed.costUsd, 75);
});

test("prices each model of a mixed run at its own rate", () => {
  // One rate over the whole run is wrong in both directions: a verbose Haiku
  // sidechain would drag an Opus turn down to Haiku rates, and a short Opus
  // answer would bill a large Haiku sidechain at Opus rates.
  const billed = billRun(
    {
      modelUsage: {
        "claude-opus-5": { inputTokens: 1_000_000, outputTokens: 0 },
        "claude-haiku-4-5": { inputTokens: 0, outputTokens: 1_000_000 },
      },
    },
    { ...RUN_TOTALS, inputTokens: 1_000_000 },
  );

  assert.equal(billed.costUsd, 15 + 1.25);
});

test("keeps a sub-cent run at full precision", async () => {
  // Rounding a run to the nearest microdollar is a third of what a short Haiku
  // turn costs, and the error compounds across a workload of them: 10k such
  // requests would read as $0.02 spent against $0.015 actually incurred.
  const billed = billRun(
    { modelUsage: { "claude-haiku-4-5": { inputTokens: 6, outputTokens: 0 } } },
    RUN_TOTALS,
  );
  assert.equal(billed.costUsd, 0.0000015);

  await withFakeHome(async (home) => {
    const tracker = new UsageTracker(path.join(home, "usage"));
    await tracker.load();

    for (let i = 0; i < 10_000; i++) {
      tracker.record({
        model: "paperclip/claude_local",
        modelUsage: { "claude-haiku-4-5": { inputTokens: 6, outputTokens: 0 } },
        inputTokens: 6,
        outputTokens: 0,
        durationMs: 1,
        stream: false,
        success: true,
      });
    }

    assert.equal(tracker.getSummary().estimatedApiCostSavedUsd, 0.015);
  });
});

test("prices a cache-heavy run without float dust", () => {
  // A rate of 0.1x is not binary-exact, so multiplying tokens by it leaves the
  // dollars a ulp off (1.5000000000000002). Scaling the whole token count in
  // one divide keeps the arithmetic exact instead of rounding the result after.
  const billed = billRun(
    { modelUsage: { "claude-opus-5": { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 3 } } },
    RUN_TOTALS,
  );

  assert.equal(billed.costUsd, 0.0000045);
});

test("counts the tokens a subagent added", () => {
  // Verified against the real CLI: top-level `usage` covers the main chain only,
  // while `modelUsage` includes sidechains — pricing the main-chain totals drops
  // subagent work from the saved-cost estimate entirely.
  const billed = billRun(
    {
      modelUsage: {
        "claude-sonnet-5": {
          inputTokens: 8,
          outputTokens: 418,
          cacheReadInputTokens: 91_526,
          cacheCreationInputTokens: 45_310,
        },
      },
    },
    { ...RUN_TOTALS, inputTokens: 4, outputTokens: 337, cacheReadTokens: 67_164, cacheWriteTokens: 20_005 },
  );

  assert.equal(billed.inputTokens, 8);
  assert.equal(billed.outputTokens, 418);
  assert.equal(billed.cacheReadTokens, 91_526);
  assert.equal(billed.cacheWriteTokens, 45_310);
});

test("labels a mixed run by the model that produced the most output", () => {
  // One request stays one record, so `byModel` groups it under the model that
  // did the work — a Haiku sidechain does not relabel an Opus turn.
  const billed = billRun(
    {
      modelUsage: {
        "claude-haiku-4-5": { inputTokens: 0, outputTokens: 20 },
        "claude-opus-5": { inputTokens: 0, outputTokens: 900 },
      },
    },
    RUN_TOTALS,
  );
  assert.equal(billed.model, "opus");
});

test("keeps the run's cache totals when no model entry reports them", () => {
  // The cache fields are optional per model, and input/output are not — so a
  // result that reports models without cache detail would otherwise zero counts
  // the top-level totals still carry.
  const billed = billRun(
    { modelUsage: { "claude-opus-5": { inputTokens: 4, outputTokens: 337 } } },
    { ...RUN_TOTALS, inputTokens: 4, outputTokens: 337, cacheReadTokens: 67_164, cacheWriteTokens: 20_005 },
  );

  assert.equal(billed.cacheReadTokens, 67_164);
  assert.equal(billed.cacheWriteTokens, 20_005);
});

test("prefers a reported cache total of zero over the run total", () => {
  // A reported 0 is a measurement, not a gap: `modelUsage` covers the whole run,
  // so it cannot be missing cache reads the main chain performed.
  const billed = billRun(
    {
      modelUsage: {
        "claude-opus-5": { inputTokens: 4, outputTokens: 337, cacheReadInputTokens: 0 },
      },
    },
    { ...RUN_TOTALS, cacheReadTokens: 67_164, cacheWriteTokens: 20_005 },
  );

  assert.equal(billed.cacheReadTokens, 0);
  assert.equal(billed.cacheWriteTokens, 20_005);
});

test("prices cached prompt tokens at their own API rates", () => {
  // The saved-cost estimate answers "what would this have cost on the API", and
  // there cached input is not free: a read bills at a tenth of the input rate,
  // writing the cache at 1.25x. Pricing only uncached input reports a prompt
  // served entirely from cache as costing nothing.
  const read = billRun(
    { modelUsage: { "claude-opus-5": { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 1_000_000 } } },
    RUN_TOTALS,
  );
  assert.equal(read.costUsd, 1.5);

  const write = billRun(
    { modelUsage: { "claude-opus-5": { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 1_000_000 } } },
    RUN_TOTALS,
  );
  assert.equal(write.costUsd, 18.75);
});

test("prices cache totals the models left unreported", () => {
  // billRun keeps the run's cache totals when no entry reports them, so those
  // tokens are in the record; pricing only per-entry cache would bill them at 0.
  const billed = billRun(
    { modelUsage: { "claude-opus-5": { inputTokens: 0, outputTokens: 0 } } },
    { ...RUN_TOTALS, cacheReadTokens: 1_000_000 },
  );

  assert.equal(billed.cacheReadTokens, 1_000_000);
  assert.equal(billed.costUsd, 1.5);
});

test("prices unreported cache against the main chain, not the loudest sidechain", () => {
  // Those tokens come from the top-level totals, which are the main chain's — so
  // charging them to whichever model produced the most output prices an Opus
  // prompt at Haiku rates whenever a sidechain out-talks the turn that cached it.
  // `modelUsage` never labels the main chain, but the entry matching the
  // top-level input/output is it.
  const billed = billRun(
    {
      modelUsage: {
        "claude-opus-5": { inputTokens: 0, outputTokens: 0 },
        "claude-haiku-4-5": { inputTokens: 0, outputTokens: 1_000_000 },
      },
    },
    { ...RUN_TOTALS, cacheReadTokens: 1_000_000 },
  );

  assert.equal(billed.model, "haiku");
  assert.equal(billed.costUsd, 1.25 + 1.5);
});

test("prices unreported cache at the dominant rate when no entry is the main chain", () => {
  // A main chain that itself spanned models matches no single entry. Nothing
  // identifies it then, so the run keeps the model that did the most work.
  const billed = billRun(
    {
      modelUsage: {
        "claude-opus-5": { inputTokens: 0, outputTokens: 0 },
        "claude-haiku-4-5": { inputTokens: 0, outputTokens: 1_000_000 },
      },
    },
    { ...RUN_TOTALS, outputTokens: 100, cacheReadTokens: 1_000_000 },
  );

  assert.equal(billed.costUsd, 1.25 + 0.025);
});

test("prices a fully cached run that reported no model", () => {
  // The codex adapter synthesizes an empty modelUsage, so its whole prompt is
  // priced through the fallback — a cache-heavy turn there must not bill zero.
  const billed = billRun(
    { modelUsage: {} },
    { ...RUN_TOTALS, model: "paperclip/codex_local", cacheReadTokens: 1_000_000 },
  );

  assert.equal(billed.model, "sonnet");
  assert.equal(billed.costUsd, 0.3);
});

test("falls back to the requested id and run totals when no model was reported", () => {
  // Failed runs produce no result at all, and codex-jsonl synthesizes an empty
  // modelUsage — neither knows more than the request did.
  const noResult = billRun(null, { ...RUN_TOTALS, model: "paperclip/claude_local/opus", outputTokens: 1_000_000 });
  assert.equal(noResult.model, "opus");
  assert.equal(noResult.costUsd, 75);

  const codex = billRun({ modelUsage: {} }, { ...RUN_TOTALS, model: "paperclip/codex_local", inputTokens: 7 });
  assert.equal(codex.model, "sonnet");
  assert.equal(codex.inputTokens, 7);
});

test("records an adapter-only Claude run at Opus pricing", async () => {
  await withFakeHome(async (home) => {
    const tracker = new UsageTracker(path.join(home, "usage"));
    await tracker.load();

    tracker.record({
      model: "paperclip/claude_local",
      modelUsage: { "claude-opus-5[1m]": { inputTokens: 0, outputTokens: 1_000_000 } },
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

test("a mixed run stays one request priced per model", async () => {
  await withFakeHome(async (home) => {
    const tracker = new UsageTracker(path.join(home, "usage"));
    await tracker.load();

    tracker.record({
      model: "paperclip/claude_local",
      modelUsage: {
        "claude-opus-5": { inputTokens: 1_000_000, outputTokens: 0 },
        "claude-haiku-4-5": { inputTokens: 0, outputTokens: 1_000_000 },
      },
      inputTokens: 1_000_000,
      outputTokens: 0,
      durationMs: 1,
      stream: false,
      success: true,
    });

    const summary = tracker.getSummary();
    assert.equal(summary.totalRequests, 1);
    assert.equal(summary.totalInputTokens, 1_000_000);
    assert.equal(summary.totalOutputTokens, 1_000_000);
    assert.equal(summary.estimatedApiCostSavedUsd, 16.25);
  });
});
