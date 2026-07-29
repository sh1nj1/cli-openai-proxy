import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { EventEmitter } from "events";

// Import the module under test AND the registry we will stub.
import { handleChatCompletions } from "./routes.js";
import { runnerFactory } from "../adapter/paperclip-registry.js";
import { usageTracker } from "../usage/tracker.js";
import { PaperclipRunner, type AdapterExecute } from "../adapter/paperclip-runner.js";

// NOTE on seam: the task-4 brief's plan reassigns the namespace-import binding
// `registry.createRunner` directly. In real ESM (this repo builds to ESM
// output), module namespace object properties are read-only/non-configurable,
// so `tsc` rejects that assignment outright:
//   error TS2540: Cannot assign to 'createRunner' because it is a read-only property.
// Instead, `paperclip-registry.ts` exports a mutable holder object
// (`runnerFactory = { create: createRunner }`) and `routes.ts` calls through
// `runnerFactory.create(...)`. Reassigning a plain object's property is legal
// ESM/TS, so the test below swaps `runnerFactory.create` and restores it in
// `finally`. This proves the exact same thing the brief's test intended:
// a `paperclip/*` request streams SSE deltas from a FAKE execute(), driven
// through the REAL handleChatCompletions, with no `claude` subprocess spawned.

const deltaLine = JSON.stringify({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text: "Yo" } },
  session_id: "s", uuid: "u",
}) + "\n";
const resultLine = JSON.stringify({
  type: "result", subtype: "success", is_error: false, result: "Yo",
  session_id: "s", total_cost_usd: 0, duration_ms: 1, duration_api_ms: 1,
  num_turns: 1, usage: { input_tokens: 3, output_tokens: 1 }, modelUsage: {},
}) + "\n";

function fakeRes(): Response & { body: string; ended: boolean; headers: Record<string, string> } {
  const emitter = new EventEmitter();
  const res: any = emitter;
  res.body = "";
  res.ended = false;
  res.headers = {} as Record<string, string>;
  res.writableEnded = false;
  res.writable = true;
  res.headersSent = false;
  res.setHeader = (k: string, v: string) => { res.headers[k] = v; };
  res.flushHeaders = () => { res.headersSent = true; };
  res.write = (chunk: string) => { res.body += chunk; return true; };
  // Mirror Express: sending a response commits headers and ends the writable side,
  // so the route's post-send guards (!res.headersSent / res.writable) see it as done.
  res.end = () => {
    res.ended = true; res.writableEnded = true; res.writable = false; res.headersSent = true;
    emitter.emit("close");
  };
  res.status = () => res;
  res.json = (obj: unknown) => {
    res.body += JSON.stringify(obj);
    res.ended = true; res.writableEnded = true; res.writable = false; res.headersSent = true;
    return res;
  };
  return res;
}

test("paperclip/* model streams SSE deltas through the real route handler", async () => {
  const fakeExecute: AdapterExecute = async (ctx) => {
    await ctx.onLog("stdout", deltaLine);
    await ctx.onLog("stdout", resultLine);
    return { exitCode: 0, signal: null, timedOut: false, sessionId: "s",
      usage: { inputTokens: 3, outputTokens: 1 } };
  };
  const orig = runnerFactory.create;
  runnerFactory.create = (model: string) =>
    model.startsWith("paperclip/")
      ? new PaperclipRunner(fakeExecute, { engine: "cli" })
      : orig(model);

  try {
    const req = { body: { model: "paperclip/claude_local", stream: true,
      messages: [{ role: "user", content: "hi" }] } } as unknown as Request;
    const res = fakeRes();
    await handleChatCompletions(req, res);
    assert.match(res.body, /"content":"Yo"/, "streamed delta present in SSE body");
    assert.match(res.body, /data: \[DONE\]/, "terminated with [DONE]");
  } finally {
    runnerFactory.create = orig;
  }
});

const codexAgentMessage = (text: string) =>
  JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }) + "\n";

test("streaming JSON mode extracts the final codex answer, not an intermediate JSON block", async () => {
  // codex-jsonl streams one delta per agent_message block, so the client-side
  // jsonBuffer concatenates every block. When an intermediate block is itself
  // valid JSON, extractJsonFromText (first-match) must NOT return it: the final
  // answer (result.result = result.summary) is authoritative.
  const fakeExecute: AdapterExecute = async (ctx) => {
    await ctx.onLog("stdout", codexAgentMessage('{"status":"working"}'));
    await ctx.onLog("stdout", codexAgentMessage('{"answer":42}'));
    return { exitCode: 0, signal: null, timedOut: false, sessionId: "s",
      summary: '{"answer":42}', usage: { inputTokens: 3, outputTokens: 2 } };
  };
  const orig = runnerFactory.create;
  runnerFactory.create = (model: string) =>
    model.startsWith("paperclip/")
      ? new PaperclipRunner(fakeExecute, { engine: "cli", command: "codex" },
        { promptInjection: "prompt-template", outputMode: "codex-jsonl", cliFlags: [] })
      : orig(model);

  try {
    const req = { body: { model: "paperclip/codex_local", stream: true,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: "hi" }] } } as unknown as Request;
    const res = fakeRes();
    await handleChatCompletions(req, res);
    assert.match(res.body, /"content":"\{\\"answer\\":42\}"/, "final answer JSON is emitted");
    assert.doesNotMatch(res.body, /"content":"\{\\"status\\":\\"working\\"\}"/,
      "the intermediate JSON status block is NOT what the client receives");
    assert.match(res.body, /data: \[DONE\]/, "terminated with [DONE]");
  } finally {
    runnerFactory.create = orig;
  }
});

test("usage-limit failure returns 429 insufficient_quota with the verbatim message (non-streaming)", async () => {
  // A Claude Max usage limit must reach the client as a 429 carrying the CLI's own
  // message, matching how the OpenAI endpoint reports quota exhaustion.
  const limitMsg = "Claude AI usage limit reached. Resets at 3pm.";
  const quotaExecute: AdapterExecute = async () => ({
    exitCode: 1, signal: null, timedOut: false,
    errorMessage: limitMsg, errorCode: "provider_quota", errorFamily: "provider_quota",
  });
  const orig = runnerFactory.create;
  runnerFactory.create = (model: string) =>
    model.startsWith("paperclip/")
      ? new PaperclipRunner(quotaExecute, { engine: "cli" })
      : orig(model);

  try {
    const req = { body: { model: "paperclip/claude_local", stream: false,
      messages: [{ role: "user", content: "hi" }] } } as unknown as Request;
    const res = fakeRes();
    let statusCode = 0;
    res.status = (code: number) => { statusCode = code; return res; };

    await handleChatCompletions(req, res);

    assert.equal(statusCode, 429, "usage limit -> HTTP 429");
    assert.match(res.body, /"type":"insufficient_quota"/, "OpenAI insufficient_quota type");
    assert.match(res.body, /Claude AI usage limit reached\. Resets at 3pm\./, "verbatim CLI message");
  } finally {
    runnerFactory.create = orig;
  }
});

test("usage-limit failure streams the verbatim error in-band (streaming)", async () => {
  const limitMsg = "Claude AI usage limit reached. Resets at 3pm.";
  const quotaExecute: AdapterExecute = async () => ({
    exitCode: 1, signal: null, timedOut: false,
    errorMessage: limitMsg, errorCode: "provider_quota", errorFamily: "provider_quota",
  });
  const orig = runnerFactory.create;
  runnerFactory.create = (model: string) =>
    model.startsWith("paperclip/")
      ? new PaperclipRunner(quotaExecute, { engine: "cli" })
      : orig(model);

  try {
    const req = { body: { model: "paperclip/claude_local", stream: true,
      messages: [{ role: "user", content: "hi" }] } } as unknown as Request;
    const res = fakeRes();
    await handleChatCompletions(req, res);

    assert.match(res.body, /"type":"insufficient_quota"/, "in-band OpenAI error type");
    assert.match(res.body, /Claude AI usage limit reached\. Resets at 3pm\./, "verbatim message in the stream");
    assert.doesNotMatch(res.body, /"content":"/, "no empty success delta precedes the error");
  } finally {
    runnerFactory.create = orig;
  }
});

test("unregistered paperclip/* model returns 404 model_not_found (never runs Claude)", async () => {
  // Uses the REAL runnerFactory.create: an unregistered paperclip/* id must produce a
  // clean client error, not a spawned Claude subprocess and not a generic 500.
  const req = { body: { model: "paperclip/definitely_not_registered", stream: false,
    messages: [{ role: "user", content: "hi" }] } } as unknown as Request;
  const res = fakeRes();
  let statusCode = 0;
  res.status = (code: number) => { statusCode = code; return res; };

  await handleChatCompletions(req, res);

  assert.equal(statusCode, 404, "unknown paperclip adapter -> 404");
  assert.match(res.body, /"code":"model_not_found"/, "OpenAI-style model_not_found code");
  assert.match(res.body, /paperclip\/definitely_not_registered/, "error names the requested model");
});

test("an unauthenticated CLI returns 401 engine_unauthenticated naming the engine", async () => {
  // Collavre drives the matching /v1/auth flow off this payload, so the code must
  // be machine-distinguishable from a bad proxy key and must name the engine.
  const authMsg = "Invalid API key. Please run /login to authenticate.";
  const authExecute: AdapterExecute = async () => ({
    exitCode: 1, signal: null, timedOut: false,
    errorMessage: authMsg, errorCode: "claude_auth_required",
  });
  const orig = runnerFactory.create;
  runnerFactory.create = (model: string) =>
    model.startsWith("paperclip/")
      ? new PaperclipRunner(authExecute, { engine: "cli" }, { engine: "codex" })
      : orig(model);

  try {
    const req = { body: { model: "paperclip/codex_local", stream: false,
      messages: [{ role: "user", content: "hi" }] } } as unknown as Request;
    const res = fakeRes();
    let statusCode = 0;
    res.status = (code: number) => { statusCode = code; return res; };

    await handleChatCompletions(req, res);

    assert.equal(statusCode, 401, "unauthenticated CLI -> HTTP 401");
    const payload = JSON.parse(res.body) as { error: { code: string; engine: string; message: string } };
    assert.equal(payload.error.code, "engine_unauthenticated");
    assert.equal(payload.error.engine, "codex", "names which login flow to open");
    assert.equal(payload.error.message, authMsg, "verbatim CLI message");
  } finally {
    runnerFactory.create = orig;
  }
});

test("a model id outside the paperclip namespace is a 404 model_not_found", async () => {
  // Uses the real runnerFactory.create: if a legacy claude-max/* alias ever comes
  // back, this catches it.
  const req = {
    body: { model: "claude-max/claude-opus-4-6", messages: [{ role: "user", content: "hi" }] },
  } as unknown as Request;
  let status = 0;
  let payload: any;
  const res = {
    headersSent: false,
    status(code: number) { status = code; return this; },
    json(obj: unknown) { payload = obj; return this; },
  } as unknown as Response;

  await handleChatCompletions(req, res);

  assert.equal(status, 404);
  assert.equal(payload.error.code, "model_not_found");
});

// `paperclip/claude_local` names an adapter, not a model — the CLI picks the model.
// Both response paths must bill what actually ran, or /v1/usage prices an Opus run
// at Sonnet rates (the tracker classifies any id without "opus"/"haiku" as Sonnet).
const opusResultLine = JSON.stringify({
  type: "result", subtype: "success", is_error: false, result: "Yo",
  session_id: "s", total_cost_usd: 0, duration_ms: 1, duration_api_ms: 1,
  num_turns: 1, usage: { input_tokens: 3, output_tokens: 1 },
  modelUsage: { "claude-opus-5[1m]": { inputTokens: 3, outputTokens: 1, costUSD: 0 } },
}) + "\n";

for (const stream of [true, false]) {
  test(`${stream ? "streaming" : "non-streaming"} usage is billed by the model the CLI ran`, async () => {
    const fakeExecute: AdapterExecute = async (ctx) => {
      await ctx.onLog("stdout", deltaLine);
      await ctx.onLog("stdout", opusResultLine);
      return { exitCode: 0, signal: null, timedOut: false, sessionId: "s",
        usage: { inputTokens: 3, outputTokens: 1 } };
    };
    const orig = runnerFactory.create;
    runnerFactory.create = (model: string) =>
      model.startsWith("paperclip/")
        ? new PaperclipRunner(fakeExecute, { engine: "cli" })
        : orig(model);

    try {
      const req = { body: { model: "paperclip/claude_local", stream,
        messages: [{ role: "user", content: "hi" }] } } as unknown as Request;
      await handleChatCompletions(req, fakeRes());
      const [recorded] = usageTracker.getRecent(1);
      assert.equal(recorded.model, "opus");
    } finally {
      runnerFactory.create = orig;
    }
  });
}

/** Every `data:` payload of an SSE body except the terminal [DONE] sentinel. */
function sseChunks(body: string): Array<Record<string, any>> {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice("data: ".length)));
}

/** Drives one streaming request through the real route against a fake adapter. */
async function streamThroughFakeAdapter(
  body: Record<string, unknown>,
  execute: AdapterExecute,
): Promise<string> {
  const orig = runnerFactory.create;
  runnerFactory.create = (model: string) =>
    model.startsWith("paperclip/")
      ? new PaperclipRunner(execute, { engine: "cli" })
      : orig(model);
  try {
    const req = { body: { stream: true, messages: [{ role: "user", content: "hi" }], ...body } } as unknown as Request;
    const res = fakeRes();
    await handleChatCompletions(req, res);
    return res.body;
  } finally {
    runnerFactory.create = orig;
  }
}

const cachedResultLine = JSON.stringify({
  type: "result", subtype: "success", is_error: false, result: "Yo",
  session_id: "s", total_cost_usd: 0, duration_ms: 1, duration_api_ms: 1,
  num_turns: 1, modelUsage: {},
  usage: {
    input_tokens: 2, output_tokens: 7,
    cache_read_input_tokens: 30_000, cache_creation_input_tokens: 500,
  },
}) + "\n";

const streamUsageExecute: AdapterExecute = async (ctx) => {
  await ctx.onLog("stdout", deltaLine);
  await ctx.onLog("stdout", cachedResultLine);
  return { exitCode: 0, signal: null, timedOut: false, sessionId: "s",
    usage: { inputTokens: 2, outputTokens: 7, cachedInputTokens: 30_000 } };
};

// A run whose subagent spent far more than the main chain: `usage` sees only the
// main chain, `modelUsage` sees both.
const sidechainResultLine = JSON.stringify({
  type: "result", subtype: "success", is_error: false, result: "Yo",
  session_id: "s", total_cost_usd: 0, duration_ms: 1, duration_api_ms: 1,
  num_turns: 1,
  usage: { input_tokens: 2, output_tokens: 7, cache_read_input_tokens: 1_000 },
  modelUsage: {
    "claude-opus-5": {
      inputTokens: 2, outputTokens: 7, cacheReadInputTokens: 1_000, costUSD: 0,
    },
    "claude-haiku-4-5": {
      inputTokens: 40, outputTokens: 900, cacheReadInputTokens: 5_000, costUSD: 0,
    },
  },
}) + "\n";

const sidechainExecute: AdapterExecute = async (ctx) => {
  await ctx.onLog("stdout", deltaLine);
  await ctx.onLog("stdout", sidechainResultLine);
  return { exitCode: 0, signal: null, timedOut: false, sessionId: "s",
    usage: { inputTokens: 2, outputTokens: 7 } };
};

test("stream_options.include_usage emits a terminal usage chunk before [DONE]", async () => {
  const body = await streamThroughFakeAdapter(
    { model: "paperclip/claude_local", stream_options: { include_usage: true } },
    streamUsageExecute,
  );

  const usageChunks = sseChunks(body).filter((c) => c.usage);
  assert.equal(usageChunks.length, 1, "exactly one usage chunk");
  assert.deepEqual(usageChunks[0].choices, [], "usage rides a chunk with no choices");
  assert.equal(usageChunks[0].usage.prompt_tokens, 30_502);
  assert.equal(usageChunks[0].usage.completion_tokens, 7);
  assert.equal(usageChunks[0].usage.total_tokens, 30_509);
  assert.equal(usageChunks[0].usage.prompt_tokens_details.cached_tokens, 30_000);
  assert.ok(
    body.indexOf('"usage"') < body.indexOf("data: [DONE]"),
    "usage chunk precedes the [DONE] sentinel",
  );
});

test("stream_options.include_usage marks every other chunk usage:null", async () => {
  // The OpenAI contract: when usage is requested, non-terminal chunks still carry
  // the key so a client can read chunk.usage unconditionally.
  const body = await streamThroughFakeAdapter(
    { model: "paperclip/claude_local", stream_options: { include_usage: true } },
    streamUsageExecute,
  );

  const contentChunks = sseChunks(body).filter((c) => c.choices.length > 0);
  assert.ok(contentChunks.length >= 2, "content deltas plus the finish chunk");
  for (const chunk of contentChunks) {
    assert.ok("usage" in chunk, "non-terminal chunk carries the usage key");
    assert.equal(chunk.usage, null);
  }
});

test("streaming without stream_options emits no usage chunk", async () => {
  // Spec default. A usage chunk has an empty choices array, which crashes SDKs
  // that read chunk.choices[0] — so it must only appear when asked for.
  const body = await streamThroughFakeAdapter(
    { model: "paperclip/claude_local" },
    streamUsageExecute,
  );

  assert.doesNotMatch(body, /"usage"/, "no usage field anywhere in the stream");
  assert.match(body, /data: \[DONE\]/);
});

test("streaming JSON mode still emits the usage chunk when requested", async () => {
  // jsonMode buffers deltas and flushes one chunk from the terminal result, a
  // separate write path from the plain-delta one.
  const body = await streamThroughFakeAdapter(
    {
      model: "paperclip/claude_local",
      response_format: { type: "json_object" },
      stream_options: { include_usage: true },
    },
    async (ctx) => {
      await ctx.onLog("stdout", JSON.stringify({
        type: "result", subtype: "success", is_error: false, result: '{"answer":42}',
        session_id: "s", total_cost_usd: 0, duration_ms: 1, duration_api_ms: 1,
        num_turns: 1, modelUsage: {}, usage: { input_tokens: 2, output_tokens: 7 },
      }) + "\n");
      return { exitCode: 0, signal: null, timedOut: false, sessionId: "s",
        usage: { inputTokens: 2, outputTokens: 7 } };
    },
  );

  const usageChunks = sseChunks(body).filter((c) => c.usage);
  assert.equal(usageChunks.length, 1);
  assert.equal(usageChunks[0].usage.total_tokens, 9);
});

test("non-streaming usage reports cache tokens in prompt_tokens", async () => {
  const orig = runnerFactory.create;
  runnerFactory.create = (model: string) =>
    model.startsWith("paperclip/")
      ? new PaperclipRunner(streamUsageExecute, { engine: "cli" })
      : orig(model);
  try {
    const req = { body: { model: "paperclip/claude_local", stream: false,
      messages: [{ role: "user", content: "hi" }] } } as unknown as Request;
    const res = fakeRes();
    await handleChatCompletions(req, res);
    const payload = JSON.parse(res.body);
    assert.equal(payload.usage.prompt_tokens, 30_502);
    assert.equal(payload.usage.prompt_tokens_details.cached_tokens, 30_000);
  } finally {
    runnerFactory.create = orig;
  }
});

test("terminal usage chunk covers subagent runs, not just the main chain", async () => {
  const body = await streamThroughFakeAdapter(
    { model: "paperclip/claude_local", stream_options: { include_usage: true } },
    sidechainExecute,
  );

  const usageChunks = sseChunks(body).filter((c) => c.usage);
  assert.equal(usageChunks.length, 1);
  assert.equal(usageChunks[0].usage.prompt_tokens, 6_042);
  assert.equal(usageChunks[0].usage.completion_tokens, 907);
  assert.equal(usageChunks[0].usage.prompt_tokens_details.cached_tokens, 6_000);
});

test("non-streaming usage covers subagent runs", async () => {
  // Streaming and non-streaming must agree on the same run — a client switching
  // stream on/off would otherwise see two different bills for one request.
  const orig = runnerFactory.create;
  runnerFactory.create = (model: string) =>
    model.startsWith("paperclip/")
      ? new PaperclipRunner(sidechainExecute, { engine: "cli" })
      : orig(model);
  try {
    const req = { body: { model: "paperclip/claude_local", stream: false,
      messages: [{ role: "user", content: "hi" }] } } as unknown as Request;
    const res = fakeRes();
    await handleChatCompletions(req, res);
    const payload = JSON.parse(res.body);
    assert.equal(payload.usage.prompt_tokens, 6_042);
    assert.equal(payload.usage.completion_tokens, 907);
  } finally {
    runnerFactory.create = orig;
  }
});
