import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { handleModels } from "./routes.js";

test("/v1/models includes paperclip/claude_local", () => {
  let payload: any;
  const res = { json: (obj: unknown) => { payload = obj; } } as unknown as Response;
  handleModels({} as Request, res);
  const ids: string[] = payload.data.map((m: { id: string }) => m.id);
  assert.ok(ids.includes("paperclip/claude_local"), "paperclip model advertised");
});
