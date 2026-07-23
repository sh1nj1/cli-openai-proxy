import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePaperclipModel, createRunner, PAPERCLIP_MODEL_IDS } from "./paperclip-registry.js";
import { PaperclipRunner } from "./paperclip-runner.js";
import { ClaudeSubprocess } from "../subprocess/manager.js";

test("resolves a known paperclip model to a spec with an execute fn", () => {
  const spec = resolvePaperclipModel("paperclip/claude_local");
  assert.ok(spec);
  assert.equal(spec!.adapterType, "claude_local");
  assert.equal(typeof spec!.execute, "function");
  assert.equal(spec!.baseConfig.engine, "cli");
});

test("returns null for non-paperclip models", () => {
  assert.equal(resolvePaperclipModel("claude-opus-4"), null);
  assert.equal(resolvePaperclipModel("paperclip/does-not-exist"), null);
});

test("createRunner returns PaperclipRunner for paperclip models, ClaudeSubprocess otherwise", () => {
  assert.ok(createRunner("paperclip/claude_local") instanceof PaperclipRunner);
  assert.ok(createRunner("claude-opus-4") instanceof ClaudeSubprocess);
});

test("PAPERCLIP_MODEL_IDS advertises the registered ids", () => {
  assert.ok(PAPERCLIP_MODEL_IDS.includes("paperclip/claude_local"));
});
