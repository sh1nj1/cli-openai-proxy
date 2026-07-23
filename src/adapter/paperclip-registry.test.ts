import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolvePaperclipModel,
  createRunner,
  PAPERCLIP_MODEL_IDS,
  UnknownPaperclipModelError,
} from "./paperclip-registry.js";
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

test("resolves paperclip/codex_local to the codex adapter with per-adapter strategies", () => {
  // codex diverges from claude on all three seams: its prompt comes from a
  // rendered promptTemplate (not paperclipTaskMarkdown), it rejects claude-only
  // CLI flags, and it emits its own JSONL so the final text comes from summary.
  const spec = resolvePaperclipModel("paperclip/codex_local");
  assert.ok(spec);
  assert.equal(spec!.adapterType, "codex_local");
  assert.equal(typeof spec!.execute, "function");
  assert.equal(spec!.baseConfig.command, "codex");
  // codex reads its own bypass key (claude's dangerouslySkipPermissions is ignored).
  assert.equal(spec!.baseConfig.dangerouslyBypassApprovalsAndSandbox, true);
  assert.equal(spec!.promptInjection, "prompt-template");
  assert.equal(spec!.outputMode, "summary");
  assert.deepEqual(spec!.cliFlags, [], "no claude-only flags for codex");
});

test("createRunner returns PaperclipRunner for paperclip models, ClaudeSubprocess otherwise", () => {
  assert.ok(createRunner("paperclip/claude_local") instanceof PaperclipRunner);
  assert.ok(createRunner("paperclip/codex_local") instanceof PaperclipRunner);
  assert.ok(createRunner("claude-opus-4") instanceof ClaudeSubprocess);
});

test("createRunner NEVER silently falls back to Claude for an unknown paperclip/* model", () => {
  // Regression: an unregistered paperclip/* id used to fall through to
  // `new ClaudeSubprocess()`, so requesting a Paperclip adapter silently ran
  // Claude instead. A paperclip/* prefix must resolve to a Paperclip adapter or error.
  assert.throws(() => createRunner("paperclip/gemini_local"), UnknownPaperclipModelError);
  assert.throws(() => createRunner("paperclip/definitely_not_registered"), UnknownPaperclipModelError);
});

test("UnknownPaperclipModelError names the model and lists the known ids", () => {
  try {
    createRunner("paperclip/definitely_not_registered");
    assert.fail("expected createRunner to throw");
  } catch (err) {
    if (!(err instanceof UnknownPaperclipModelError)) throw err;
    assert.equal(err.model, "paperclip/definitely_not_registered");
    assert.ok(err.message.includes("paperclip/definitely_not_registered"));
    assert.ok(err.message.includes("paperclip/claude_local")); // a known id is surfaced
  }
});

test("PAPERCLIP_MODEL_IDS advertises the registered ids", () => {
  assert.ok(PAPERCLIP_MODEL_IDS.includes("paperclip/claude_local"));
  assert.ok(PAPERCLIP_MODEL_IDS.includes("paperclip/codex_local"));
});
