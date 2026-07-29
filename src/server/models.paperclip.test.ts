import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { handleModels } from "./routes.js";
import { PAPERCLIP_MODEL_IDS } from "../adapter/paperclip-registry.js";

function listModels(): { id: string; owned_by: string }[] {
  let payload: any;
  const res = { json: (obj: unknown) => { payload = obj; } } as unknown as Response;
  handleModels({} as Request, res);
  return payload.data;
}

test("/v1/models advertises exactly the registered paperclip adapters", () => {
  const ids = listModels().map((m) => m.id);
  assert.deepEqual(ids.sort(), [...PAPERCLIP_MODEL_IDS].sort());
});

test("/v1/models no longer advertises legacy alias ids", () => {
  // An unadvertised id is a 404. Leaving one listed keeps clients sending it.
  const ids = listModels().map((m) => m.id);
  for (const legacy of ["claude-opus-4", "claude-max/claude-opus-4-6", "anthropic/claude-opus-4-6", "opus"]) {
    assert.ok(!ids.includes(legacy), `${legacy} must not be advertised`);
  }
});

test("/v1/models marks every entry as paperclip-owned", () => {
  for (const model of listModels()) {
    assert.equal(model.owned_by, "paperclip");
  }
});
