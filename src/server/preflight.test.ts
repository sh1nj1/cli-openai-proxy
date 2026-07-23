import { test } from "node:test";
import assert from "node:assert/strict";
import { runPreflight } from "./preflight.js";

test("runPreflight: missing Claude CLI is a warning, not a fatal failure (codex-only host can start)", async () => {
  const warnings: string[] = [];
  const result = await runPreflight({
    verifyClaude: async () => ({ ok: false, error: "not found on PATH" }),
    verifyAuth: async () => ({ ok: true }),
    warn: (m) => warnings.push(m),
  });

  // Non-fatal: server is allowed to start even though Claude is unavailable.
  assert.equal(result.claudeOk, false);
  assert.equal(result.warnings.length, 1);
  // The warning must tell the operator paperclip/* adapters still work.
  assert.match(result.warnings[0], /paperclip/i);
  assert.equal(warnings.length, 1);
});

test("runPreflight: missing Claude auth is a warning, not a fatal failure", async () => {
  const result = await runPreflight({
    verifyClaude: async () => ({ ok: true, version: "2.1.218" }),
    verifyAuth: async () => ({ ok: false, error: "not logged in" }),
  });

  assert.equal(result.claudeOk, false);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /paperclip/i);
});

test("runPreflight: Claude CLI + auth present → claudeOk, no warnings", async () => {
  const logs: string[] = [];
  const result = await runPreflight({
    verifyClaude: async () => ({ ok: true, version: "2.1.218" }),
    verifyAuth: async () => ({ ok: true }),
    log: (m) => logs.push(m),
  });

  assert.equal(result.claudeOk, true);
  assert.equal(result.warnings.length, 0);
});
