import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";

import { handleUsageRecent } from "./routes.js";
import { usageTracker } from "../usage/tracker.js";

function fakeRes(): Response & { payload: unknown } {
  const res: any = {};
  res.payload = undefined;
  res.status = () => res;
  res.json = (obj: unknown) => { res.payload = obj; return res; };
  return res;
}

test("/v1/usage/recent reports a run's cost without float dust", () => {
  // Records keep full precision so long-run totals do not drift, which means a
  // run whose per-model costs do not sum exactly in binary (0.1 + 0.2) carries a
  // trailing ulp. That is an artifact of the representation, not of the
  // estimate, so it is rounded off where the number is handed to a reader.
  usageTracker.record({
    model: "paperclip/claude_local",
    modelUsage: {
      "claude-haiku-4-5": { inputTokens: 400_000, outputTokens: 0 },
      "claude-haiku-3-5": { inputTokens: 800_000, outputTokens: 0 },
    },
    inputTokens: 1_200_000,
    outputTokens: 0,
    durationMs: 1,
    stream: false,
    success: true,
  });

  const req = { query: { limit: "1" } } as unknown as Request;
  const res = fakeRes();
  handleUsageRecent(req, res);

  const { data } = res.payload as { data: Array<{ estimatedApiCostUsd: number }> };
  assert.equal(data.length, 1);
  assert.equal(data[0].estimatedApiCostUsd, 0.3);
});
