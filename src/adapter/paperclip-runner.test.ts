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

test("assigns a unique runId per run even within the same millisecond/process", async () => {
  // Paperclip keys child-process bookkeeping (runningProcesses map, ${runId}.log)
  // on ctx.runId; Date.now()+pid collides for concurrent runs in one process.
  const runIds: string[] = [];
  const capture: AdapterExecute = async (ctx) => {
    runIds.push(ctx.runId);
    return { exitCode: 0, signal: null, timedOut: false, sessionId: "s",
      usage: { inputTokens: 1, outputTokens: 1 } };
  };
  const run = () => {
    const runner = new PaperclipRunner(capture, { engine: "cli" });
    const closed = new Promise<void>((resolve) => runner.on("close", () => resolve()));
    return runner.start("p", { model: "opus" }).then(() => closed);
  };
  await Promise.all([run(), run(), run()]);

  assert.equal(runIds.length, 3);
  assert.equal(new Set(runIds).size, 3, "each run must get a distinct runId");
});

test("prompt-template injection sends the raw prompt via config.promptTemplate and forwards no claude-only flags", async () => {
  // codex-local ignores context.paperclipTaskMarkdown; its prompt comes from
  // renderTemplate(config.promptTemplate). It also rejects claude-only CLI flags
  // (buildCodexExecArgs appends extraArgs verbatim to `codex exec`).
  let captured: import("@paperclipai/adapter-utils").AdapterExecutionContext | undefined;
  const fakeExecute: AdapterExecute = async (ctx) => {
    captured = ctx;
    return { exitCode: 0, signal: null, timedOut: false, sessionId: "s",
      summary: "done", usage: { inputTokens: 1, outputTokens: 1 } };
  };
  const runner = new PaperclipRunner(
    fakeExecute,
    { engine: "cli", command: "codex" },
    { promptInjection: "prompt-template", outputMode: "summary", cliFlags: [] },
  );
  const closed = new Promise<void>((resolve) => runner.on("close", () => resolve()));
  await runner.start("write a haiku", { model: "gpt-5" });
  await closed;

  const ctx = captured!;
  assert.equal(ctx.config.promptTemplate, "write a haiku", "raw prompt goes into promptTemplate for prompt-template adapters");
  assert.equal(
    (ctx.context as Record<string, unknown>).paperclipTaskMarkdown,
    undefined,
    "prompt-template adapters must not receive paperclipTaskMarkdown",
  );
  assert.deepEqual(ctx.config.extraArgs, [], "no claude-only flags reach a non-claude adapter");
});

test("prompt-template injection prepends the system prompt to the prompt", async () => {
  let captured: import("@paperclipai/adapter-utils").AdapterExecutionContext | undefined;
  const fakeExecute: AdapterExecute = async (ctx) => {
    captured = ctx;
    return { exitCode: 0, signal: null, timedOut: false, sessionId: "s",
      summary: "done", usage: { inputTokens: 1, outputTokens: 1 } };
  };
  const runner = new PaperclipRunner(
    fakeExecute,
    { engine: "cli", command: "codex" },
    { promptInjection: "prompt-template", outputMode: "summary", cliFlags: [] },
  );
  const closed = new Promise<void>((resolve) => runner.on("close", () => resolve()));
  await runner.start("body", { model: "gpt-5", systemPrompt: "Be terse." });
  await closed;

  assert.equal(captured!.config.promptTemplate, "Be terse.\n\nbody");
});

test("summary output mode synthesizes content_delta + result from result.summary", async () => {
  // codex emits its own JSONL (not claude stream-json), so the StreamJsonParser
  // yields no content. The authoritative text is result.summary; the runner
  // synthesizes the events routes.ts consumes so both stream + non-stream work.
  const fakeExecute: AdapterExecute = async () => ({
    exitCode: 0, signal: null, timedOut: false, sessionId: "s",
    summary: "PAPERCLIP_CODEX_OK",
    usage: { inputTokens: 7, outputTokens: 3 },
  });
  const runner = new PaperclipRunner(
    fakeExecute,
    { engine: "cli", command: "codex" },
    { promptInjection: "prompt-template", outputMode: "summary", cliFlags: [] },
  );
  const deltas: string[] = [];
  const results: ClaudeCliResult[] = [];
  const closeCode = new Promise<number | null>((resolve) => {
    runner.on("content_delta", (ev: ClaudeCliStreamEvent) => { deltas.push(ev.event.delta?.text || ""); });
    runner.on("result", (r: ClaudeCliResult) => { results.push(r); });
    runner.on("close", (code: number | null) => resolve(code));
  });

  await runner.start("hi", { model: "gpt-5" });
  const code = await closeCode;

  assert.deepEqual(deltas, ["PAPERCLIP_CODEX_OK"], "summary streamed as one content delta");
  assert.equal(results.length, 1, "one synthesized result event");
  assert.equal(results[0].result, "PAPERCLIP_CODEX_OK", "non-streaming text comes from result.result");
  assert.equal(results[0].usage.input_tokens, 7);
  assert.equal(results[0].usage.output_tokens, 3);
  assert.equal(code, 0);
});

test("summary mode surfaces a failed adapter result as error, not a success result", async () => {
  // Summary-mode adapters (e.g. codex) resolve normal CLI failures as an
  // AdapterExecutionResult with errorMessage/nonzero exitCode instead of
  // throwing. Emitting `result` here makes routes.ts report a 200 success, so a
  // failed run (missing creds, bad args, timeout) must emit `error` instead.
  const failedExecute: AdapterExecute = async () => ({
    exitCode: 1, signal: null, timedOut: false, sessionId: "s",
    errorMessage: "codex: missing credentials",
    summary: "",
  });
  const runner = new PaperclipRunner(
    failedExecute,
    { engine: "cli", command: "codex" },
    { promptInjection: "prompt-template", outputMode: "summary", cliFlags: [] },
  );
  const results: ClaudeCliResult[] = [];
  let errMsg = "";
  const closeCode = new Promise<number | null>((resolve) => {
    runner.on("result", (r: ClaudeCliResult) => { results.push(r); });
    runner.on("error", (e: Error) => { errMsg = e.message; });
    runner.on("close", (code: number | null) => resolve(code));
  });

  await runner.start("hi", { model: "gpt-5" });
  const code = await closeCode;

  assert.equal(results.length, 0, "a failed result must NOT be emitted as a success result event");
  assert.match(errMsg, /missing credentials/, "the adapter error message surfaces via the error event");
  assert.notEqual(code, 0, "close code reflects the failure");
});

test("summary mode surfaces a timed-out adapter result as error", async () => {
  const timedOutExecute: AdapterExecute = async () => ({
    exitCode: 0, signal: null, timedOut: true, sessionId: "s", summary: "",
  });
  const runner = new PaperclipRunner(
    timedOutExecute,
    { engine: "cli", command: "codex" },
    { promptInjection: "prompt-template", outputMode: "summary", cliFlags: [] },
  );
  const results: ClaudeCliResult[] = [];
  let errored = false;
  const closed = new Promise<void>((resolve) => {
    runner.on("result", (r: ClaudeCliResult) => { results.push(r); });
    runner.on("error", () => { errored = true; });
    runner.on("close", () => resolve());
  });
  await runner.start("hi", { model: "gpt-5" });
  await closed;

  assert.equal(results.length, 0, "a timed-out result must not be a success result event");
  assert.ok(errored, "timeout surfaces via the error event");
});

test("summary mode surfaces a signal-terminated adapter result as error", async () => {
  // A child killed by a signal (SIGKILL from OOM, operator/system SIGTERM)
  // resolves with exitCode: null + signal set, and codex normalization only
  // sets errorMessage when (exitCode ?? 0) is nonzero — so this result carries
  // NO errorMessage and is not timedOut. It must still surface as an error, not
  // a 200/empty success completion.
  const signaledExecute: AdapterExecute = async () => ({
    exitCode: null, signal: "SIGKILL", timedOut: false, sessionId: "s",
    summary: "",
  });
  const runner = new PaperclipRunner(
    signaledExecute,
    { engine: "cli", command: "codex" },
    { promptInjection: "prompt-template", outputMode: "summary", cliFlags: [] },
  );
  const results: ClaudeCliResult[] = [];
  let errMsg = "";
  const closeCode = new Promise<number | null>((resolve) => {
    runner.on("result", (r: ClaudeCliResult) => { results.push(r); });
    runner.on("error", (e: Error) => { errMsg = e.message; });
    runner.on("close", (code: number | null) => resolve(code));
  });

  await runner.start("hi", { model: "gpt-5" });
  const code = await closeCode;

  assert.equal(results.length, 0, "a signal-terminated result must NOT be emitted as a success result event");
  assert.match(errMsg, /SIGKILL/, "the terminating signal surfaces in the error message");
  assert.notEqual(code, 0, "close code reflects the signal failure");
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
