import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { EventEmitter } from "events";

// Import the module under test AND the registry we will stub.
import { handleChatCompletions } from "./routes.js";
import { runnerFactory } from "../adapter/paperclip-registry.js";
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
  res.end = () => { res.ended = true; res.writableEnded = true; emitter.emit("close"); };
  res.status = () => res;
  res.json = (obj: unknown) => { res.body += JSON.stringify(obj); res.ended = true; return res; };
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
