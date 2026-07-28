import { describe, it, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClaudeSubprocess, isValidSessionId } from "./manager.js";
import { openaiErrorFromError } from "../adapter/adapter-error.js";

describe("isValidSessionId", () => {
  it("accepts canonical UUIDs", () => {
    assert.equal(isValidSessionId("550e8400-e29b-41d4-a716-446655440000"), true);
    assert.equal(isValidSessionId("00000000-0000-0000-0000-000000000000"), true);
    assert.equal(isValidSessionId("F47AC10B-58CC-4372-A567-0E02B2C3D479"), true);
  });

  it("rejects non-UUID strings", () => {
    assert.equal(isValidSessionId("session-123"), false);
    assert.equal(isValidSessionId("user@example.com"), false);
    assert.equal(isValidSessionId("not-a-uuid"), false);
    assert.equal(isValidSessionId(""), false);
  });

  it("rejects UUID-like strings with extra content (CLI arg injection)", () => {
    assert.equal(
      isValidSessionId("550e8400-e29b-41d4-a716-446655440000 --evil-flag"),
      false
    );
    assert.equal(
      isValidSessionId("550e8400-e29b-41d4-a716-446655440000\n--evil"),
      false
    );
    assert.equal(
      isValidSessionId(" 550e8400-e29b-41d4-a716-446655440000"),
      false
    );
  });

  it("rejects malformed UUIDs", () => {
    assert.equal(isValidSessionId("550e8400-e29b-41d4-a716-44665544000"), false);
    assert.equal(isValidSessionId("550e8400e29b41d4a716446655440000"), false);
    assert.equal(isValidSessionId("zzzzzzzz-e29b-41d4-a716-446655440000"), false);
  });
});

/**
 * Auth classification on the DIRECT Claude path.
 *
 * Non-`paperclip/*` models — this repo's documented default — run through
 * ClaudeSubprocess, which has no adapter to classify failures for it. These
 * tests drive the real spawn against a stub `claude` on PATH, so they cover the
 * actual stdout/stderr/exit-code seam rather than a mocked one.
 */
describe("ClaudeSubprocess auth classification", () => {
  let binDir: string;
  let originalPath: string | undefined;

  /** Install a stub `claude` that the next spawn resolves to. */
  const stubClaude = (script: string): void => {
    const file = join(binDir, "claude");
    // Drain stdin first: manager.ts writes the prompt there and would see EPIPE.
    writeFileSync(file, `#!/bin/sh\ncat > /dev/null\n${script}\n`);
    chmodSync(file, 0o755);
  };

  const resultLine = (over: Record<string, unknown>): string =>
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "",
      session_id: "s",
      duration_ms: 1,
      duration_api_ms: 1,
      num_turns: 1,
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: {},
      ...over,
    });

  /** Run to completion, collecting whichever terminal event fired. */
  const run = (): Promise<{ error?: Error; result?: unknown }> => {
    const proc = new ClaudeSubprocess();
    return new Promise((resolve) => {
      const seen: { error?: Error; result?: unknown } = {};
      proc.on("error", (err: Error) => { seen.error ??= err; });
      proc.on("result", (res: unknown) => { seen.result ??= res; });
      proc.on("close", () => resolve(seen));
      void proc.start("hi", { model: "claude-haiku-4-5-20251001", timeout: 10_000 });
    });
  };

  before(() => {
    binDir = mkdtempSync(join(tmpdir(), "claude-stub-"));
    originalPath = process.env.PATH;
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
  });

  after(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    rmSync(binDir, { recursive: true, force: true });
  });

  // Without this the CLI's complaint is relayed as a 200 completion (cliResultToOpenai
  // ignores is_error), so a caller can never tell it needs to re-authenticate.
  test("an auth-failure result becomes a recoverable 401, not a completion", async () => {
    stubClaude(
      `echo '${resultLine({ subtype: "error", is_error: true, result: "Invalid API key - Please run /login" })}'`,
    );
    const { error, result } = await run();

    assert.ok(error, "expected an error event");
    const shape = openaiErrorFromError(error);
    assert.equal(shape.status, 401);
    assert.equal(shape.code, "engine_unauthenticated");
    assert.equal(shape.engine, "claude");
    assert.equal(result, undefined, "the error result must not also be relayed as success");
  });

  // A hard auth failure can kill the CLI before any result line is written.
  test("an auth failure on stderr with a nonzero exit is classified too", async () => {
    stubClaude(`echo 'Not logged in. Please run claude login.' >&2\nexit 1`);
    const { error } = await run();

    assert.ok(error, "expected an error event");
    assert.equal(openaiErrorFromError(error).code, "engine_unauthenticated");
  });

  test("a normal completion is still relayed as a result", async () => {
    stubClaude(`echo '${resultLine({ result: "hello" })}'`);
    const { error, result } = await run();

    assert.equal(error, undefined);
    assert.equal((result as { result: string }).result, "hello");
  });

  // Only an already-failed run is classified, so an answer that merely talks
  // about logging in stays an answer.
  test("a successful result mentioning login is not an auth failure", async () => {
    stubClaude(`echo '${resultLine({ result: "To fix it, please run /login in your terminal." })}'`);
    const { error, result } = await run();

    assert.equal(error, undefined);
    assert.ok(result);
  });

  // A non-auth failure has no /v1/auth recovery, so it must keep its old shape.
  test("a non-auth error result is left alone", async () => {
    stubClaude(`echo '${resultLine({ subtype: "error", is_error: true, result: "Claude usage limit reached" })}'`);
    const { error, result } = await run();

    assert.equal(error, undefined);
    assert.ok(result);
  });
});
