import { test } from "node:test";
import assert from "node:assert/strict";
import { PaperclipRunner, type AdapterExecute } from "./paperclip-runner.js";
import type { ClaudeCliStreamEvent, ClaudeCliResult } from "../types/claude-cli.js";

const deltaLine = JSON.stringify({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } },
  session_id: "s", uuid: "u",
}) + "\n";
const resultLine = JSON.stringify({
  type: "result", subtype: "success", is_error: false, result: "Hi",
  session_id: "s", total_cost_usd: 0, duration_ms: 1, duration_api_ms: 1,
  num_turns: 1, usage: { input_tokens: 5, output_tokens: 1 }, modelUsage: {},
}) + "\n";

test("streams onLog stdout through the parser and emits events, then close(0)", async () => {
  const fakeExecute: AdapterExecute = async (ctx) => {
    assert.equal(ctx.config.engine, "cli", "must pin CLI lane");
    // Raw prompt must NOT go through promptTemplate (the adapter renders {{...}} there).
    assert.notEqual(ctx.config.promptTemplate, "hello prompt", "raw prompt must not sit in promptTemplate");
    assert.equal(
      (ctx.context as Record<string, unknown>).paperclipTaskMarkdown,
      "hello prompt",
      "raw prompt goes through the non-templated task context section",
    );
    await ctx.onLog("stdout", deltaLine);
    await ctx.onLog("stdout", resultLine);
    return { exitCode: 0, signal: null, timedOut: false, sessionId: "s",
      usage: { inputTokens: 5, outputTokens: 1 } };
  };

  const runner = new PaperclipRunner(fakeExecute, { engine: "cli", command: "claude" });
  const deltas: string[] = [];
  const results: ClaudeCliResult[] = [];
  const closeCode = new Promise<number | null>((resolve) => {
    runner.on("content_delta", (ev: ClaudeCliStreamEvent) => { deltas.push(ev.event.delta?.text || ""); });
    runner.on("result", (r: ClaudeCliResult) => { results.push(r); });
    runner.on("close", (code: number | null) => resolve(code));
  });

  await runner.start("hello prompt", { model: "opus" });
  const code = await closeCode;

  assert.deepEqual(deltas, ["Hi"]);
  assert.ok(results.length > 0, "result event fired");
  assert.equal(results[0].usage.output_tokens, 1);
  assert.equal(code, 0);
});

test("preserves {{ }} template delimiters verbatim and disables session persistence", async () => {
  const rawPrompt = "Explain what {{agent.name}} means in a Handlebars {{template}}.";
  let captured: import("@paperclipai/adapter-utils").AdapterExecutionContext | undefined;
  const fakeExecute: AdapterExecute = async (ctx) => {
    captured = ctx;
    return { exitCode: 0, signal: null, timedOut: false, sessionId: "s",
      usage: { inputTokens: 1, outputTokens: 1 } };
  };
  const runner = new PaperclipRunner(fakeExecute, { engine: "cli" });
  const closed = new Promise<void>((resolve) => runner.on("close", () => resolve()));
  await runner.start(rawPrompt, { model: "opus" });
  await closed;

  assert.ok(captured, "execute received a ctx");
  const ctx = captured!;
  // The verbatim prompt (delimiters intact) reaches the non-templated context section.
  assert.equal((ctx.context as Record<string, unknown>).paperclipTaskMarkdown, rawPrompt);
  // promptTemplate must be non-empty (empty => default Paperclip agent instructions) but not the raw prompt.
  assert.notEqual(ctx.config.promptTemplate, rawPrompt);
  assert.ok(
    typeof ctx.config.promptTemplate === "string" && ctx.config.promptTemplate.length > 0,
    "promptTemplate stays non-empty to avoid the default template fallback",
  );
  // Stateless (Option 1): Claude must not persist a transcript per run.
  assert.ok(
    Array.isArray(ctx.config.extraArgs) && ctx.config.extraArgs.includes("--no-session-persistence"),
    "extraArgs forwards --no-session-persistence to the Claude CLI",
  );
});

test("emits error and close(1) when execute rejects", async () => {
  const boom: AdapterExecute = async () => { throw new Error("adapter blew up"); };
  const runner = new PaperclipRunner(boom, { engine: "cli" });
  let errMsg = "";
  const closed = new Promise<number | null>((resolve) => {
    runner.on("error", (e: Error) => { errMsg = e.message; });
    runner.on("close", (code: number | null) => resolve(code));
  });
  await runner.start("p", { model: "opus" });
  const code = await closed;
  assert.match(errMsg, /adapter blew up/);
  assert.equal(code, 1);
});
