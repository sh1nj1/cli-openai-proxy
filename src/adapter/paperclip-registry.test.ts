import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolvePaperclipModel,
  createRunner,
  PAPERCLIP_MODEL_IDS,
  UnknownPaperclipModelError,
} from "./paperclip-registry.js";
import { PaperclipRunner } from "./paperclip-runner.js";

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
  // CLI flags, and it emits its own JSONL that the runner parses live (codex-jsonl).
  const spec = resolvePaperclipModel("paperclip/codex_local");
  assert.ok(spec);
  assert.equal(spec!.adapterType, "codex_local");
  assert.equal(typeof spec!.execute, "function");
  assert.equal(spec!.baseConfig.command, "codex");
  // codex reads its own bypass key (claude's dangerouslySkipPermissions is ignored).
  assert.equal(spec!.baseConfig.dangerouslyBypassApprovalsAndSandbox, true);
  assert.equal(spec!.promptInjection, "prompt-template");
  assert.equal(spec!.outputMode, "codex-jsonl");
  // No claude-only flags, but codex needs --skip-git-repo-check because the runner
  // executes it in a fresh non-git /tmp dir (buildCodexExecArgs only self-adds it for
  // its sandbox lane, not for local `codex exec`).
  assert.deepEqual(spec!.cliFlags, ["--skip-git-repo-check"], "codex gets git-repo bypass, no claude flags");
  assert.ok(!spec!.cliFlags.includes("--include-partial-messages"), "no claude-only flags for codex");
});

test("createRunner returns PaperclipRunner for every supported model path", () => {
  assert.ok(createRunner("paperclip/claude_local") instanceof PaperclipRunner);
  assert.ok(createRunner("paperclip/codex_local") instanceof PaperclipRunner);
  assert.ok(createRunner("claude-opus-4") instanceof PaperclipRunner);
  assert.ok(createRunner("claude-sonnet-4") instanceof PaperclipRunner);
  assert.ok(createRunner("claude-haiku-4") instanceof PaperclipRunner);
});

test("createRunner NEVER silently falls back to Claude for an unknown paperclip/* model", () => {
  // Regression: an unregistered paperclip/* id used to fall through to
  // the default Claude runner, so requesting a Paperclip adapter silently ran
  // the wrong adapter. A paperclip/* prefix must resolve explicitly or error.
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
