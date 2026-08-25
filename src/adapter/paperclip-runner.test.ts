import { test } from "node:test";
import assert from "node:assert/strict";
import { PaperclipRunner, type AdapterExecute } from "./paperclip-runner.js";
import { AdapterRunError } from "./adapter-error.js";
import type { ClaudeCliStreamEvent, ClaudeCliResult } from "../types/claude-cli.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { runInWorkspace } from "../provision/workspace-context.js";
import { clearAllCredentials, setCredential } from "../auth/token-store.js";
import { TRUST_COMPLETION_CALLERS_VAR } from "../config.js";

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

  await runner.start("hello prompt", {});
  const code = await closeCode;

  assert.deepEqual(deltas, ["Hi"]);
  assert.ok(results.length > 0, "result event fired");
  assert.equal(results[0].usage.output_tokens, 1);
  assert.equal(code, 0);
});

test("stamps the result with the main chain model the init message named", async () => {
  // `modelUsage` keys by model rather than by chain, so nothing in the result
  // says which model ran the main chain — but the run opens by announcing it,
  // and the top-level `usage` totals that pricing has to attribute are that
  // chain's alone.
  const initLine = JSON.stringify({
    type: "system", subtype: "init", model: "claude-opus-5", session_id: "s",
  }) + "\n";
  const fakeExecute: AdapterExecute = async (ctx) => {
    await ctx.onLog("stdout", initLine);
    await ctx.onLog("stdout", resultLine);
    return { exitCode: 0, signal: null, timedOut: false, sessionId: "s",
      usage: { inputTokens: 5, outputTokens: 1 } };
  };

  const runner = new PaperclipRunner(fakeExecute, { engine: "cli", command: "claude" });
  const results: ClaudeCliResult[] = [];
  const closed = new Promise<void>((resolve) => {
    runner.on("result", (r: ClaudeCliResult) => { results.push(r); });
    runner.on("close", () => resolve());
  });

  await runner.start("hello prompt", {});
  await closed;

  assert.equal(results[0].mainChainModel, "claude-opus-5");
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
  await runner.start(rawPrompt, {});
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
    return runner.start("p", {}).then(() => closed);
  };
  await Promise.all([run(), run(), run()]);

  assert.equal(runIds.length, 3);
  assert.equal(new Set(runIds).size, 3, "each run must get a distinct runId");
});

test("a named workspace changes agent HOME while sharing the user's Codex credentials", async () => {
  const workspaceBase = await mkdtemp(path.join(tmpdir(), "paperclip-workspaces-"));
  const previous = process.env.PROVISION_WORKSPACE_ROOT;
  const previousInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
  process.env.PROVISION_WORKSPACE_ROOT = workspaceBase;
  delete process.env.PAPERCLIP_INSTANCE_ID;
  let captured: import("@paperclipai/adapter-utils").AdapterExecutionContext | undefined;
  try {
    await runInWorkspace("agent-12", async () => {
      const runner = new PaperclipRunner(async (ctx) => {
	captured = ctx;
	return { exitCode: 0, signal: null, timedOut: false, sessionId: "s" };
      }, { engine: "cli" }, { engine: "codex" });
      const closed = new Promise<void>((resolve) => runner.on("close", () => resolve()));
      await runner.start("workspace prompt", {});
      await closed;
    });
    assert.ok(captured);
    const env = captured!.config.env as Record<string, string>;
    const workspace = path.join(workspaceBase, "agent-12");
    assert.equal(env.HOME, workspace);
    assert.equal(env.CLAUDE_CONFIG_DIR, path.join(workspace, ".claude"));
    assert.equal(env.PAPERCLIP_HOME, path.join(homedir(), ".paperclip"));
    assert.equal(
      env.CODEX_HOME,
      path.join(homedir(), ".paperclip", "instances", "default", "companies", "local", "codex-home"),
    );
    assert.notEqual(env.CODEX_HOME, path.join(workspace, ".codex"));
    assert.match(String(captured!.config.cwd), /paperclip-run-/, "cwd remains ephemeral per run");
  } finally {
    if (previous === undefined) delete process.env.PROVISION_WORKSPACE_ROOT;
    else process.env.PROVISION_WORKSPACE_ROOT = previous;
    if (previousInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = previousInstanceId;
    await rm(workspaceBase, { recursive: true, force: true });
  }
});

test("completion workspace creation obeys the persistent per-user limit", async () => {
  const workspaceBase = await mkdtemp(path.join(tmpdir(), "paperclip-workspace-limit-"));
  const previousRoot = process.env.PROVISION_WORKSPACE_ROOT;
  const previousMax = process.env.PROVISION_MAX_WORKSPACES_PER_USER;
  process.env.PROVISION_WORKSPACE_ROOT = workspaceBase;
  process.env.PROVISION_MAX_WORKSPACES_PER_USER = "1";
  const execute: AdapterExecute = async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    sessionId: "s",
  });
  try {
    await runInWorkspace("agent-11", async () => {
      const runner = new PaperclipRunner(execute, { engine: "cli" });
      const closed = new Promise<void>((resolve) => runner.on("close", () => resolve()));
      await runner.start("first", {});
      await closed;
    });
    await assert.rejects(
      runInWorkspace("agent-12", () => new PaperclipRunner(execute, { engine: "cli" }).start("second", {})),
      /Workspace limit \(1\) reached/,
    );
  } finally {
    if (previousRoot === undefined) delete process.env.PROVISION_WORKSPACE_ROOT;
    else process.env.PROVISION_WORKSPACE_ROOT = previousRoot;
    if (previousMax === undefined) delete process.env.PROVISION_MAX_WORKSPACES_PER_USER;
    else process.env.PROVISION_MAX_WORKSPACES_PER_USER = previousMax;
    await rm(workspaceBase, { recursive: true, force: true });
  }
});

// Mirror of the adapter's single-pass renderTemplate + resolvePathValue (string case)
// so a test can prove what codex actually feeds to stdin from ctx.config.promptTemplate.
function renderLikeCodex(template: string, ctx: { context: unknown }): string {
  return template.replace(/{{\s*([a-zA-Z0-9_.-]+)\s*}}/g, (_m, dotted: string) => {
    let cursor: unknown = ctx;
    for (const part of dotted.split(".")) {
      if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) return "";
      cursor = (cursor as Record<string, unknown>)[part];
    }
    return typeof cursor === "string" ? cursor : "";
  });
}

test("prompt-template injection routes the raw prompt through a context variable (verbatim {{ }}) and forwards no claude-only flags", async () => {
  // codex-local ignores context.paperclipTaskMarkdown; its prompt comes from
  // renderTemplate(config.promptTemplate), which is single-pass. Assigning the raw
  // prompt straight to promptTemplate lets renderTemplate substitute/strip the
  // user's own {{ }} placeholders, so the raw prompt must ride a context variable
  // referenced once. codex also rejects claude-only CLI flags (buildCodexExecArgs
  // appends extraArgs verbatim to `codex exec`).
  const rawPrompt = "Explain {{agent.name}} inside a Handlebars {{template}}.";
  let captured: import("@paperclipai/adapter-utils").AdapterExecutionContext | undefined;
  const fakeExecute: AdapterExecute = async (ctx) => {
    captured = ctx;
    return { exitCode: 0, signal: null, timedOut: false, sessionId: "s",
      summary: "done", usage: { inputTokens: 1, outputTokens: 1 } };
  };
  const runner = new PaperclipRunner(
    fakeExecute,
    { engine: "cli", command: "codex" },
    { promptInjection: "prompt-template", outputMode: "codex-jsonl", cliFlags: [] },
  );
  const closed = new Promise<void>((resolve) => runner.on("close", () => resolve()));
  await runner.start(rawPrompt, {});
  await closed;

  const ctx = captured!;
  // The raw prompt must NOT sit directly in promptTemplate (renderTemplate would corrupt {{ }}).
  assert.notEqual(ctx.config.promptTemplate, rawPrompt, "raw prompt must not be assigned directly to promptTemplate");
  // What codex actually renders to stdin must equal the user's prompt verbatim.
  assert.equal(
    renderLikeCodex(ctx.config.promptTemplate as string, { context: ctx.context }),
    rawPrompt,
    "single-pass render must return the user's {{ }} delimiters verbatim",
  );
  assert.equal(
    (ctx.context as Record<string, unknown>).paperclipTaskMarkdown,
    undefined,
    "prompt-template adapters must not receive paperclipTaskMarkdown",
  );
  assert.deepEqual(ctx.config.extraArgs, [], "no claude-only flags reach a non-claude adapter");
});

test("prompt-template injection prepends the system prompt to the prompt (rendered verbatim)", async () => {
  let captured: import("@paperclipai/adapter-utils").AdapterExecutionContext | undefined;
  const fakeExecute: AdapterExecute = async (ctx) => {
    captured = ctx;
    return { exitCode: 0, signal: null, timedOut: false, sessionId: "s",
      summary: "done", usage: { inputTokens: 1, outputTokens: 1 } };
  };
  const runner = new PaperclipRunner(
    fakeExecute,
    { engine: "cli", command: "codex" },
    { promptInjection: "prompt-template", outputMode: "codex-jsonl", cliFlags: [] },
  );
  const closed = new Promise<void>((resolve) => runner.on("close", () => resolve()));
  await runner.start("body", { systemPrompt: "Be terse." });
  await closed;

  const ctx = captured!;
  assert.equal(
    renderLikeCodex(ctx.config.promptTemplate as string, { context: ctx.context }),
    "Be terse.\n\nbody",
  );
});

test("codex-jsonl mode with no live agent_message falls back to result.summary", async () => {
  // When no agent_message block streams on stdout (e.g. the adapter's ACP fallback
  // puts the text only in result.summary), the runner synthesizes the events
  // routes.ts consumes from result.summary so both stream + non-stream still work.
  const fakeExecute: AdapterExecute = async () => ({
    exitCode: 0, signal: null, timedOut: false, sessionId: "s",
    summary: "PAPERCLIP_CODEX_OK",
    usage: { inputTokens: 7, outputTokens: 3 },
  });
  const runner = new PaperclipRunner(
    fakeExecute,
    { engine: "cli", command: "codex" },
    { promptInjection: "prompt-template", outputMode: "codex-jsonl", cliFlags: [] },
  );
  const deltas: string[] = [];
  const results: ClaudeCliResult[] = [];
  const closeCode = new Promise<number | null>((resolve) => {
    runner.on("content_delta", (ev: ClaudeCliStreamEvent) => { deltas.push(ev.event.delta?.text || ""); });
    runner.on("result", (r: ClaudeCliResult) => { results.push(r); });
    runner.on("close", (code: number | null) => resolve(code));
  });

  await runner.start("hi", {});
  const code = await closeCode;

  assert.deepEqual(deltas, ["PAPERCLIP_CODEX_OK"], "summary streamed as one content delta");
  assert.equal(results.length, 1, "one synthesized result event");
  assert.equal(results[0].result, "PAPERCLIP_CODEX_OK", "non-streaming text comes from result.result");
  assert.equal(results[0].usage.input_tokens, 7);
  assert.equal(results[0].usage.output_tokens, 3);
  assert.equal(code, 0);
});

test("codex-jsonl mode reports cached tokens separately from fresh input tokens", async () => {
  // codex counts cached_input_tokens INSIDE input_tokens, while every consumer of
  // ClaudeCliResult (usage tracker, OpenAI usage) treats the two as disjoint —
  // so the cached share has to move out of input_tokens, not be added on top.
  const fakeExecute: AdapterExecute = async () => ({
    exitCode: 0, signal: null, timedOut: false, sessionId: "s",
    summary: "ok",
    usage: { inputTokens: 17_664, outputTokens: 5, cachedInputTokens: 17_000 },
  });
  const runner = new PaperclipRunner(
    fakeExecute,
    { engine: "cli", command: "codex" },
    { promptInjection: "prompt-template", outputMode: "codex-jsonl", cliFlags: [] },
  );
  const results: ClaudeCliResult[] = [];
  const closed = new Promise<void>((resolve) => {
    runner.on("result", (r: ClaudeCliResult) => { results.push(r); });
    runner.on("close", () => resolve());
  });

  await runner.start("hi", {});
  await closed;

  assert.equal(results[0].usage.cache_read_input_tokens, 17_000);
  assert.equal(results[0].usage.input_tokens, 664, "cached share removed from fresh input");
});

test("codex-jsonl mode reports zero cached tokens when the adapter reports none", async () => {
  const fakeExecute: AdapterExecute = async () => ({
    exitCode: 0, signal: null, timedOut: false, sessionId: "s",
    summary: "ok", usage: { inputTokens: 7, outputTokens: 3 },
  });
  const runner = new PaperclipRunner(
    fakeExecute,
    { engine: "cli", command: "codex" },
    { promptInjection: "prompt-template", outputMode: "codex-jsonl", cliFlags: [] },
  );
  const results: ClaudeCliResult[] = [];
  const closed = new Promise<void>((resolve) => {
    runner.on("result", (r: ClaudeCliResult) => { results.push(r); });
    runner.on("close", () => resolve());
  });

  await runner.start("hi", {});
  await closed;

  assert.equal(results[0].usage.input_tokens, 7);
  assert.equal(results[0].usage.cache_read_input_tokens, 0);
});

// Emulates the `codex exec --json` NDJSON stream (see src/adapter/codex-jsonl-parser.ts).
const codexLine = (obj: unknown) => JSON.stringify(obj) + "\n";
const codexAgentMessage = (text: string) =>
  codexLine({ type: "item.completed", item: { id: "item_0", type: "agent_message", text } });

test("codex-jsonl mode streams a content delta per live agent_message block", async () => {
  // Path 1: codex prints each completed agent_message as one JSONL line; the runner
  // parses stdout live and emits a content delta per block instead of waiting for the
  // process to exit and synthesizing a single delta from result.summary.
  const fakeExecute: AdapterExecute = async (ctx) => {
    await ctx.onLog("stdout", codexLine({ type: "thread.started", thread_id: "t1" }));
    await ctx.onLog("stdout", codexLine({ type: "turn.started" }));
    await ctx.onLog("stdout", codexAgentMessage("Hello from codex."));
    await ctx.onLog("stdout", codexLine({ type: "turn.completed", usage: { input_tokens: 9, output_tokens: 4 } }));
    return { exitCode: 0, signal: null, timedOut: false, sessionId: "s",
      summary: "Hello from codex.", usage: { inputTokens: 9, outputTokens: 4 } };
  };
  const runner = new PaperclipRunner(
    fakeExecute,
    { engine: "cli", command: "codex" },
    { promptInjection: "prompt-template", outputMode: "codex-jsonl", cliFlags: [] },
  );
  const deltas: string[] = [];
  const results: ClaudeCliResult[] = [];
  const closeCode = new Promise<number | null>((resolve) => {
    runner.on("content_delta", (ev: ClaudeCliStreamEvent) => { deltas.push(ev.event.delta?.text || ""); });
    runner.on("result", (r: ClaudeCliResult) => { results.push(r); });
    runner.on("close", (code: number | null) => resolve(code));
  });

  await runner.start("hi", {});
  const code = await closeCode;

  // The live block is the only content delta — result.summary must NOT be re-emitted
  // (that would duplicate the answer for streaming clients).
  assert.deepEqual(deltas, ["Hello from codex."], "one delta from the live block, not a duplicate summary delta");
  assert.equal(results.length, 1, "one terminal result event");
  assert.equal(results[0].result, "Hello from codex.", "non-streaming text mirrors the streamed text");
  assert.equal(results[0].usage.output_tokens, 4);
  assert.equal(code, 0);
});

test("codex-jsonl mode streams every agent_message block but reports the final answer as the result", async () => {
  const fakeExecute: AdapterExecute = async (ctx) => {
    // An intermediate block that is itself valid JSON (e.g. a status object)
    // followed by the real answer. extractJsonFromText returns the FIRST JSON,
    // so the non-streaming result must be the final answer, not the concatenation.
    await ctx.onLog("stdout", codexAgentMessage('{"status":"working"}'));
    await ctx.onLog("stdout", codexAgentMessage('{"answer":42}'));
    return { exitCode: 0, signal: null, timedOut: false, sessionId: "s",
      summary: '{"answer":42}', usage: { inputTokens: 3, outputTokens: 5 } };
  };
  const runner = new PaperclipRunner(
    fakeExecute,
    { engine: "cli", command: "codex" },
    { promptInjection: "prompt-template", outputMode: "codex-jsonl", cliFlags: [] },
  );
  const deltas: string[] = [];
  const results: ClaudeCliResult[] = [];
  const closed = new Promise<void>((resolve) => {
    runner.on("content_delta", (ev: ClaudeCliStreamEvent) => { deltas.push(ev.event.delta?.text || ""); });
    runner.on("result", (r: ClaudeCliResult) => { results.push(r); });
    runner.on("close", () => resolve());
  });

  await runner.start("hi", {});
  await closed;

  // The live stream still shows every block (the feature), separated for readability.
  assert.deepEqual(
    deltas,
    ['{"status":"working"}', '\n\n{"answer":42}'],
    "each block streams live; later blocks are separated",
  );
  // The canonical result is codex's final agent_message (result.summary), NOT the
  // concatenation: in JSON mode extractJsonFromText would otherwise return the
  // intermediate {"status":"working"} instead of the real answer.
  assert.equal(
    results[0].result,
    '{"answer":42}',
    "non-streaming result is the final answer block, not every block concatenated",
  );
});

test("codex-jsonl mode surfaces a failed adapter result as error, not a success result", async () => {
  // codex-jsonl adapters (e.g. codex) resolve normal CLI failures as an
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
    { promptInjection: "prompt-template", outputMode: "codex-jsonl", cliFlags: [] },
  );
  const results: ClaudeCliResult[] = [];
  let errMsg = "";
  const closeCode = new Promise<number | null>((resolve) => {
    runner.on("result", (r: ClaudeCliResult) => { results.push(r); });
    runner.on("error", (e: Error) => { errMsg = e.message; });
    runner.on("close", (code: number | null) => resolve(code));
  });

  await runner.start("hi", {});
  const code = await closeCode;

  assert.equal(results.length, 0, "a failed result must NOT be emitted as a success result event");
  assert.match(errMsg, /missing credentials/, "the adapter error message surfaces via the error event");
  assert.notEqual(code, 0, "close code reflects the failure");
});

test("codex-jsonl mode surfaces a timed-out adapter result as error", async () => {
  const timedOutExecute: AdapterExecute = async () => ({
    exitCode: 0, signal: null, timedOut: true, sessionId: "s", summary: "",
  });
  const runner = new PaperclipRunner(
    timedOutExecute,
    { engine: "cli", command: "codex" },
    { promptInjection: "prompt-template", outputMode: "codex-jsonl", cliFlags: [] },
  );
  const results: ClaudeCliResult[] = [];
  let errored = false;
  const closed = new Promise<void>((resolve) => {
    runner.on("result", (r: ClaudeCliResult) => { results.push(r); });
    runner.on("error", () => { errored = true; });
    runner.on("close", () => resolve());
  });
  await runner.start("hi", {});
  await closed;

  assert.equal(results.length, 0, "a timed-out result must not be a success result event");
  assert.ok(errored, "timeout surfaces via the error event");
});

test("codex-jsonl mode surfaces a signal-terminated adapter result as error", async () => {
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
    { promptInjection: "prompt-template", outputMode: "codex-jsonl", cliFlags: [] },
  );
  const results: ClaudeCliResult[] = [];
  let errMsg = "";
  const closeCode = new Promise<number | null>((resolve) => {
    runner.on("result", (r: ClaudeCliResult) => { results.push(r); });
    runner.on("error", (e: Error) => { errMsg = e.message; });
    runner.on("close", (code: number | null) => resolve(code));
  });

  await runner.start("hi", {});
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
  await runner.start("p", {});
  const code = await closed;
  assert.match(errMsg, /adapter blew up/);
  assert.equal(code, 1);
});

test("stream-json mode surfaces an is_error terminal result as error, not a success result", async () => {
  // The claude stream-json path can deliver a well-formed terminal ClaudeCliResult
  // marked is_error/subtype:"error" (e.g. max-turns reached, execution error) without
  // throwing. routes.ts treats any `result` event as a 200 success, so a failed
  // claude_local run must surface as `error` — otherwise the client gets a 200 with
  // the (often empty/partial) error text instead of an adapter error.
  const errorResultLine = JSON.stringify({
    type: "result", subtype: "error", is_error: true, result: "",
    session_id: "s", total_cost_usd: 0, duration_ms: 1, duration_api_ms: 1,
    num_turns: 1, usage: { input_tokens: 5, output_tokens: 0 }, modelUsage: {},
  }) + "\n";
  const failingExecute: AdapterExecute = async (ctx) => {
    await ctx.onLog("stdout", errorResultLine);
    return { exitCode: 0, signal: null, timedOut: false, sessionId: "s",
      usage: { inputTokens: 5, outputTokens: 0 } };
  };
  const runner = new PaperclipRunner(failingExecute, { engine: "cli", command: "claude" });
  const results: ClaudeCliResult[] = [];
  let errored = false;
  const closeCode = new Promise<number | null>((resolve) => {
    runner.on("result", (r: ClaudeCliResult) => { results.push(r); });
    runner.on("error", () => { errored = true; });
    runner.on("close", (code: number | null) => resolve(code));
  });

  await runner.start("hi", {});
  const code = await closeCode;

  assert.equal(results.length, 0, "an is_error terminal result must NOT be emitted as a success result event");
  assert.ok(errored, "the failed run surfaces via the error event");
  assert.notEqual(code, 0, "close code reflects the failure");
});

test("stream-json mode surfaces a usage-limit failure (no terminal result) verbatim as a 429 error", async () => {
  // A Claude Max usage limit commonly exits the CLI with the message on stderr and
  // NO parseable stream-json result, so the adapter resolves with errorMessage +
  // errorCode "provider_quota" and produces no `result` event. The runner must
  // surface that verbatim message as an `error` (not a silent close), classified
  // 429 insufficient_quota, so routes.ts can answer like the OpenAI endpoint.
  const limitMsg = "Claude AI usage limit reached. Resets at 3pm.";
  const quotaExecute: AdapterExecute = async () => ({
    exitCode: 1, signal: null, timedOut: false,
    errorMessage: limitMsg, errorCode: "provider_quota", errorFamily: "provider_quota",
  });
  const runner = new PaperclipRunner(quotaExecute, { engine: "cli", command: "claude" });
  const results: ClaudeCliResult[] = [];
  let err: Error | undefined;
  const closeCode = new Promise<number | null>((resolve) => {
    runner.on("result", (r: ClaudeCliResult) => { results.push(r); });
    runner.on("error", (e: Error) => { err = e; });
    runner.on("close", (code: number | null) => resolve(code));
  });

  await runner.start("hi", {});
  const code = await closeCode;

  assert.equal(results.length, 0, "a failed run must not emit a success result event");
  assert.ok(err, "the usage-limit failure surfaces via the error event");
  assert.equal(err!.message, limitMsg, "the CLI usage-limit message passes through verbatim");
  assert.ok(err instanceof AdapterRunError, "the error carries OpenAI classification");
  assert.equal((err as AdapterRunError).openai.status, 429, "usage limit maps to HTTP 429");
  assert.equal((err as AdapterRunError).openai.type, "insufficient_quota");
  assert.notEqual(code, 0, "close code reflects the failure");
});

test("stream-json mode surfaces an auth-required failure verbatim as a 401 error", async () => {
  const authMsg = "Invalid API key. Please run /login to authenticate.";
  const authExecute: AdapterExecute = async () => ({
    exitCode: 1, signal: null, timedOut: false,
    errorMessage: authMsg, errorCode: "claude_auth_required",
  });
  const runner = new PaperclipRunner(authExecute, { engine: "cli", command: "claude" });
  let err: Error | undefined;
  const closed = new Promise<void>((resolve) => {
    runner.on("error", (e: Error) => { err = e; });
    runner.on("close", () => resolve());
  });
  await runner.start("hi", {});
  await closed;

  assert.ok(err instanceof AdapterRunError, "auth failure surfaces as a classified error");
  assert.equal(err!.message, authMsg, "the auth message passes through verbatim");
  assert.equal((err as AdapterRunError).openai.status, 401, "auth failure maps to HTTP 401");
});

test("signals a child spawned after a pre-spawn kill() (disconnect before onSpawn)", async () => {
  // routes.ts wires kill() to client disconnect, and start() resolves immediately
  // while execute runs in the background. If the client disconnects before the
  // adapter reports onSpawn, kill() runs while pid/pgid are still null (a no-op) —
  // onSpawn must notice the pending kill and immediately signal the spawned child,
  // otherwise the orphaned run keeps going with no client until completion/timeout.
  type SpawnMeta = { pid: number; processGroupId: number | null; startedAt: string };
  let capturedOnSpawn: ((meta: SpawnMeta) => Promise<void>) | undefined;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const fakeExecute: AdapterExecute = async (ctx) => {
    capturedOnSpawn = ctx.onSpawn as (meta: SpawnMeta) => Promise<void>;
    await gate; // hold execute open so the runner stays mid-flight
    return { exitCode: 0, signal: null, timedOut: false, sessionId: "s",
      usage: { inputTokens: 1, outputTokens: 1 } };
  };

  const killed: Array<{ target: number; signal: NodeJS.Signals | number }> = [];
  const realKill = process.kill;
  (process as unknown as { kill: typeof process.kill }).kill =
    ((target: number, signal?: NodeJS.Signals | number) => {
      killed.push({ target, signal: signal ?? 0 });
      return true;
    }) as typeof process.kill;

  try {
    const runner = new PaperclipRunner(fakeExecute, { engine: "cli", command: "claude" });
    await runner.start("p", {});
    assert.ok(capturedOnSpawn, "execute started and exposed onSpawn");

    // Disconnect before onSpawn: pid/pgid are still null, so kill() cannot signal yet.
    runner.kill("SIGTERM");
    assert.equal(killed.length, 0, "no process to signal before onSpawn");

    // The adapter now reports the spawned child; the pending kill must fire.
    await capturedOnSpawn!({ pid: 4321, processGroupId: 4321, startedAt: "now" });
    assert.equal(killed.length, 1, "onSpawn signals the pending kill");
    assert.equal(killed[0].target, -4321, "targets the child's own process group");
    assert.equal(killed[0].signal, "SIGTERM", "reuses the signal kill() requested");
  } finally {
    (process as unknown as { kill: typeof process.kill }).kill = realKill;
    release();
  }
});

/**
 * The adapter builds its child env as {...process.env, ...config.env} inside a
 * dependency, so shadowing through config.env is the only reach this code has.
 * Without it, a caller can ask the model to print AUTH_ADMIN_KEYS — the key that
 * gates the credential-mutating /v1/auth routes.
 */
test("proxy-only keys and fixed manifest credentials are shadowed in the adapter's child environment", async () => {
  const { PROXY_ONLY_SECRET_VARS } = await import("../config.js");
  const saved = process.env.AUTH_ADMIN_KEYS;
  const savedManifestUrl = process.env.PROVISION_MANIFEST_URL;
  process.env.AUTH_ADMIN_KEYS = "admin-key-should-not-leak";
  process.env.PROVISION_MANIFEST_URL = "https://user:password@registry.test/provision.json?token=secret";
  try {
    let captured: Record<string, string> = {};
    const fakeExecute: AdapterExecute = async (ctx) => {
      captured = (ctx.config.env ?? {}) as Record<string, string>;
      return { exitCode: 0, signal: null, timedOut: false, sessionId: "s",
        usage: { inputTokens: 1, outputTokens: 1 } };
    };
    await new PaperclipRunner(fakeExecute, { engine: "cli" }, { engine: "codex" }).start("p", {});

    for (const key of PROXY_ONLY_SECRET_VARS) {
      assert.equal(captured[key], "", `${key} must be shadowed, not inherited`);
    }
    const childEnv = { ...process.env, ...captured };
    assert.equal(childEnv.PROVISION_MANIFEST_URL, "", "fixed manifest credentials must not reach the CLI child");
  } finally {
    if (saved === undefined) delete process.env.AUTH_ADMIN_KEYS;
    else process.env.AUTH_ADMIN_KEYS = saved;
    if (savedManifestUrl === undefined) delete process.env.PROVISION_MANIFEST_URL;
    else process.env.PROVISION_MANIFEST_URL = savedManifestUrl;
  }
});

// A provisioned credential is one vendor's secret. Every adapter spawns a
// different vendor's CLI, so it must only reach the engine it was issued for.
test("a provisioned credential reaches its own engine's adapter and no other", async () => {
  const { setCredential, clearAllCredentials } = await import("../auth/token-store.js");
  const envOf = async (engine: string | undefined): Promise<Record<string, string>> => {
    let captured: Record<string, string> = {};
    const fakeExecute: AdapterExecute = async (ctx) => {
      captured = (ctx.config.env ?? {}) as Record<string, string>;
      return { exitCode: 0, signal: null, timedOut: false, sessionId: "s",
        usage: { inputTokens: 1, outputTokens: 1 } };
    };
    const runner = new PaperclipRunner(fakeExecute, { engine: "cli" }, { engine });
    await runner.start("p", {});
    return captured;
  };

  setCredential("claude", { envVar: "CLAUDE_CODE_OAUTH_TOKEN", value: "sk-ant-oat01-secret" });
  const { TRUST_COMPLETION_CALLERS_VAR } = await import("../config.js");
  process.env[TRUST_COMPLETION_CALLERS_VAR] = "1";
  try {
    assert.equal((await envOf("claude")).CLAUDE_CODE_OAUTH_TOKEN, "sk-ant-oat01-secret");
    // Undeclared trust withholds it from the adapter env entirely.
    delete process.env[TRUST_COMPLETION_CALLERS_VAR];
    assert.equal((await envOf("claude")).CLAUDE_CODE_OAUTH_TOKEN, undefined);
    process.env[TRUST_COMPLETION_CALLERS_VAR] = "1";
    assert.equal(
      (await envOf("codex")).CLAUDE_CODE_OAUTH_TOKEN,
      undefined,
      "the codex CLI must not be launched holding a Claude credential",
    );
    assert.equal((await envOf(undefined)).CLAUDE_CODE_OAUTH_TOKEN, undefined);
  } finally {
    clearAllCredentials();
    delete process.env[TRUST_COMPLETION_CALLERS_VAR];
  }
});

test("forwards the configured model to a prompt-template adapter (codex) verbatim", async () => {
  let captured: Record<string, unknown> | undefined;
  const fakeExecute: AdapterExecute = async (ctx) => {
    captured = ctx.config as Record<string, unknown>;
    return { exitCode: 0, signal: null, timedOut: false, sessionId: "s",
      usage: { inputTokens: 1, outputTokens: 1 } };
  };
  const runner = new PaperclipRunner(fakeExecute, { engine: "cli", command: "codex" }, {
    model: "gpt-5.4-mini",
    promptInjection: "prompt-template",
    outputMode: "codex-jsonl",
    cliFlags: [],
  });
  const closed = new Promise<void>((resolve) => runner.on("close", () => resolve()));
  await runner.start("hi", {});
  await closed;

  assert.equal(captured!.model, "gpt-5.4-mini");
});

test("omits config.model entirely when no model is configured, so the CLI picks its default", async () => {
  let captured: Record<string, unknown> | undefined;
  const fakeExecute: AdapterExecute = async (ctx) => {
    captured = ctx.config as Record<string, unknown>;
    return { exitCode: 0, signal: null, timedOut: false, sessionId: "s",
      usage: { inputTokens: 1, outputTokens: 1 } };
  };
  const runner = new PaperclipRunner(fakeExecute, { engine: "cli", command: "claude" });
  const closed = new Promise<void>((resolve) => runner.on("close", () => resolve()));
  await runner.start("hi", {});
  await closed;

  // Adapters omit --model on an empty value, but only when the key is absent:
  // an explicit undefined still exists on config, so never write one.
  assert.ok(!("model" in captured!), "config must not carry a model key at all");
});

test("forwards the configured model to a task-context adapter (claude)", async () => {
  let captured: Record<string, unknown> | undefined;
  const fakeExecute: AdapterExecute = async (ctx) => {
    captured = ctx.config as Record<string, unknown>;
    return { exitCode: 0, signal: null, timedOut: false, sessionId: "s",
      usage: { inputTokens: 1, outputTokens: 1 } };
  };
  const runner = new PaperclipRunner(fakeExecute, { engine: "cli", command: "claude" }, {
    model: "claude-opus-4-8",
  });
  const closed = new Promise<void>((resolve) => runner.on("close", () => resolve()));
  await runner.start("hi", {});
  await closed;

  assert.equal(captured!.model, "claude-opus-4-8");
});

test("codex_custom refuses the run when no gateway is provisioned", async () => {
  // Refused before the CLI is spawned: a codex with no provider table would
  // authenticate against nothing and fail with a stream error that names neither
  // the cause nor the fix.
  clearAllCredentials();
  let spawned = false;
  const runner = new PaperclipRunner(
    async () => { spawned = true; return { exitCode: 0, signal: null, timedOut: false }; },
    { engine: "cli", command: "codex" },
    { engine: "codex_custom" },
  );

  const failure = new Promise<Error>((resolve) => runner.on("error", resolve));
  const closeCode = new Promise<number | null>((resolve) => runner.on("close", resolve));
  await runner.start("hi", {});
  const err = await failure;

  assert.equal(spawned, false, "no CLI may be launched");
  assert.ok(err instanceof AdapterRunError);
  // The same 401 shape a CLI-reported auth failure produces, so a caller reacts
  // identically: open the /v1/auth flow this names.
  assert.equal((err as AdapterRunError).openai.status, 401);
  assert.equal((err as AdapterRunError).openai.code, "engine_unauthenticated");
  assert.equal((err as AdapterRunError).openai.engine, "codex_custom");
  assert.match(err.message, /\/v1\/auth\/codex_custom\/sessions/);
  assert.equal(await closeCode, 1);
});

test("codex_custom points the CLI at its own home and hands it the gateway key", async () => {
  const paperclipHome = await mkdtemp(path.join(tmpdir(), "codex-custom-run-"));
  const savedPaperclipHome = process.env.PAPERCLIP_HOME;
  process.env.PAPERCLIP_HOME = paperclipHome;
  process.env[TRUST_COMPLETION_CALLERS_VAR] = "1";
  clearAllCredentials();
  setCredential("codex_custom", {
    envVar: "CODEX_CUSTOM_API_KEY",
    value: "sk-or-run",
    gateway: { baseUrl: "https://openrouter.ai/api/v1" },
  });

  try {
    let seenEnv: Record<string, string> = {};
    let configToml = "";
    const runner = new PaperclipRunner(
      async (ctx) => {
        seenEnv = (ctx.config as { env: Record<string, string> }).env;
	configToml = await readFile(path.join(seenEnv.CODEX_HOME, "config.toml"), "utf8");
        return { exitCode: 0, signal: null, timedOut: false, summary: "ok" };
      },
      { engine: "cli", command: "codex" },
      { engine: "codex_custom", outputMode: "codex-jsonl", cliFlags: [] },
    );
    const closeCode = new Promise<number | null>((resolve) => runner.on("close", resolve));
    await runner.start("hi", {});
    await closeCode;

    const home = seenEnv.CODEX_HOME;
    assert.ok(home, "CODEX_HOME must be set");
    // Not the managed company tree: that home is codex_local's, gated on an
    // auth.json this adapter has no reason to write.
    assert.ok(!home.includes(`${path.sep}companies${path.sep}`), home);
    assert.equal(seenEnv.CODEX_CUSTOM_API_KEY, "sk-or-run");

    assert.match(configToml, /base_url = "https:\/\/openrouter\.ai\/api\/v1"/);
    assert.match(configToml, /env_key = "CODEX_CUSTOM_API_KEY"/);
    // No gateway model is in codex's metadata table, so without this its
    // fallback sends `reasoning` with no effort — which reasoning-mandatory
    // endpoints reject with a 400 before the run produces anything.
    assert.match(configToml, /^model_reasoning_effort = "medium"$/m);
    // The key reaches the CLI through the environment, never through the file.
    assert.ok(!configToml.includes("sk-or-run"), "the key must not be written to disk");
    await assert.rejects(readFile(path.join(home, "config.toml"), "utf8"), /ENOENT/,
      "the per-run home is removed once the child exits");
  } finally {
    clearAllCredentials();
    delete process.env[TRUST_COMPLETION_CALLERS_VAR];
    if (savedPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = savedPaperclipHome;
    await rm(paperclipHome, { recursive: true, force: true });
  }
});

test("codex_custom writes the requested reasoning effort, ignoring one codex would refuse", async () => {
  const paperclipHome = await mkdtemp(path.join(tmpdir(), "codex-custom-effort-"));
  const savedPaperclipHome = process.env.PAPERCLIP_HOME;
  process.env.PAPERCLIP_HOME = paperclipHome;
  process.env[TRUST_COMPLETION_CALLERS_VAR] = "1";
  clearAllCredentials();
  setCredential("codex_custom", {
    envVar: "CODEX_CUSTOM_API_KEY",
    value: "sk-or-run",
    gateway: { baseUrl: "https://openrouter.ai/api/v1" },
  });

  const configFor = async (reasoningEffort?: string): Promise<string> => {
    let configToml = "";
    const runner = new PaperclipRunner(
      async (ctx) => {
        const env = (ctx.config as { env: Record<string, string> }).env;
        configToml = await readFile(path.join(env.CODEX_HOME, "config.toml"), "utf8");
        return { exitCode: 0, signal: null, timedOut: false, summary: "ok" };
      },
      { engine: "cli", command: "codex" },
      { engine: "codex_custom", outputMode: "codex-jsonl", cliFlags: [] },
    );
    const closeCode = new Promise<number | null>((resolve) => runner.on("close", resolve));
    await runner.start("hi", { reasoningEffort });
    await closeCode;
    return configToml;
  };

  try {
    assert.match(await configFor("high"), /^model_reasoning_effort = "high"$/m);
    // codex refuses to load a config naming an effort it does not know, which
    // would turn a caller's typo into a launch failure instead of a run.
    assert.match(await configFor("ludicrous"), /^model_reasoning_effort = "medium"$/m);
  } finally {
    clearAllCredentials();
    delete process.env[TRUST_COMPLETION_CALLERS_VAR];
    if (savedPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = savedPaperclipHome;
    await rm(paperclipHome, { recursive: true, force: true });
  }
});

test("concurrent codex_custom runs retain the gateway paired with their credential snapshot", async () => {
  const paperclipHome = await mkdtemp(path.join(tmpdir(), "codex-custom-snapshot-"));
  const savedPaperclipHome = process.env.PAPERCLIP_HOME;
  process.env.PAPERCLIP_HOME = paperclipHome;
  process.env[TRUST_COMPLETION_CALLERS_VAR] = "1";
  clearAllCredentials();

  let releaseFirst!: () => void;
  const firstMayFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let firstStarted!: () => void;
  const firstDidStart = new Promise<void>((resolve) => { firstStarted = resolve; });
  let secondStarted!: () => void;
  const secondDidStart = new Promise<void>((resolve) => { secondStarted = resolve; });
  const captured: Array<{ home: string; key: string; config: string }> = [];
  const execute: AdapterExecute = async (ctx) => {
    const env = (ctx.config as { env: Record<string, string> }).env;
    captured.push({
      home: env.CODEX_HOME,
      key: env.CODEX_CUSTOM_API_KEY,
      config: await readFile(path.join(env.CODEX_HOME, "config.toml"), "utf8"),
    });
    if (captured.length === 1) {
      firstStarted();
      await firstMayFinish;
    } else {
      secondStarted();
    }
    return { exitCode: 0, signal: null, timedOut: false, summary: "ok" };
  };

  try {
    setCredential("codex_custom", {
      envVar: "CODEX_CUSTOM_API_KEY", value: "key-a", gateway: { baseUrl: "https://gateway-a.example/v1" },
    });
    const first = new PaperclipRunner(execute, { engine: "cli", command: "codex" },
      { engine: "codex_custom", outputMode: "codex-jsonl", cliFlags: [] });
    const firstClosed = new Promise<void>((resolve) => first.on("close", resolve));
    await first.start("first", {});
    await firstDidStart;

    setCredential("codex_custom", {
      envVar: "CODEX_CUSTOM_API_KEY", value: "key-b", gateway: { baseUrl: "https://gateway-b.example/v1" },
    });
    const second = new PaperclipRunner(execute, { engine: "cli", command: "codex" },
      { engine: "codex_custom", outputMode: "codex-jsonl", cliFlags: [] });
    const secondClosed = new Promise<void>((resolve) => second.on("close", resolve));
    await second.start("second", {});
    await secondDidStart;

    assert.equal(captured.length, 2);
    assert.notEqual(captured[0].home, captured[1].home, "concurrent runs must not share CODEX_HOME");
    assert.equal(captured[0].key, "key-a");
    assert.match(captured[0].config, /gateway-a\.example/);
    assert.equal(captured[1].key, "key-b");
    assert.match(captured[1].config, /gateway-b\.example/);

    releaseFirst();
    await Promise.all([firstClosed, secondClosed]);
  } finally {
    releaseFirst();
    clearAllCredentials();
    delete process.env[TRUST_COMPLETION_CALLERS_VAR];
    if (savedPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = savedPaperclipHome;
    await rm(paperclipHome, { recursive: true, force: true });
  }
});
