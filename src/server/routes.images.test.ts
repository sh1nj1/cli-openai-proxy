import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import type { Request, Response } from "express";
import { EventEmitter } from "events";

import { handleChatCompletions } from "./routes.js";
import { runnerFactory } from "../adapter/paperclip-registry.js";
import type { AgentRunner } from "../adapter/paperclip-runner.js";
import type { ClaudeCliResult } from "../types/claude-cli.js";

const HELLO_B64 = Buffer.from("hello").toString("base64");
const pngDataUrl = `data:image/png;base64,${HELLO_B64}`;

function fakeRes(): Response & { body: string } {
  const emitter = new EventEmitter();
  const res: any = emitter;
  res.body = "";
  res.writable = true;
  res.headersSent = false;
  res.setHeader = () => {};
  res.flushHeaders = () => { res.headersSent = true; };
  res.write = (chunk: string) => { res.body += chunk; return true; };
  res.end = () => { res.writableEnded = true; emitter.emit("close"); };
  res.status = () => res;
  res.json = (obj: unknown) => { res.body += JSON.stringify(obj); return res; };
  return res;
}

const okResult: ClaudeCliResult = {
  type: "result", subtype: "success", is_error: false, result: "seen",
  session_id: "s", total_cost_usd: 0, duration_ms: 1, duration_api_ms: 1,
  num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {},
} as unknown as ClaudeCliResult;

// A runner that records the prompt it receives and whether image files existed at start time.
class CapturingRunner extends EventEmitter implements AgentRunner {
  prompt = "";
  fileExistedAtStart: boolean | null = null;
  async start(prompt: string): Promise<void> {
    this.prompt = prompt;
    const m = /\((\/[^\s)]+\.png)\)/.exec(prompt);
    this.fileExistedAtStart = m ? existsSync(m[1]) : null;
    this.emit("result", okResult);
    this.emit("close", 0);
  }
  kill(): void {}
}

test("data-URL image reaches the runner prompt as a markdown link to a real temp file", async () => {
  const runner = new CapturingRunner();
  const orig = runnerFactory.create;
  runnerFactory.create = () => runner;
  let materializedPath: string | undefined;
  try {
    const req = { body: { model: "opus", stream: false, messages: [
      { role: "user", content: [
        { type: "text", text: "before" },
        { type: "image_url", image_url: { url: pngDataUrl } },
        { type: "text", text: "after" },
      ] },
    ] } } as unknown as Request;
    const res = fakeRes();
    await handleChatCompletions(req, res);

    assert.match(runner.prompt, /before/);
    assert.match(runner.prompt, /after/);
    const m = /!\[image\]\((\/[^\s)]+\.png)\)/.exec(runner.prompt);
    assert.ok(m, `prompt should carry a markdown image link, got: ${runner.prompt}`);
    materializedPath = m![1];
    assert.equal(runner.fileExistedAtStart, true, "temp file must exist while the runner runs");
  } finally {
    runnerFactory.create = orig;
  }
  // cleanup ran after the response completed
  assert.ok(materializedPath && !existsSync(materializedPath), "temp file must be cleaned up after response");
});

test("unsupported image MIME returns 400 and never starts a runner", async () => {
  const orig = runnerFactory.create;
  let started = false;
  runnerFactory.create = () => { started = true; throw new Error("should not create runner"); };
  let statusCode = 0;
  try {
    const req = { body: { model: "opus", stream: false, messages: [
      { role: "user", content: [{ type: "image_url", image_url: { url: `data:image/tiff;base64,${HELLO_B64}` } }] },
    ] } } as unknown as Request;
    const res = fakeRes();
    res.status = (code: number) => { statusCode = code; return res; };
    await handleChatCompletions(req, res);
    assert.equal(statusCode, 400, "unsupported image type -> 400");
    assert.match(res.body, /invalid_request_error/);
    assert.equal(started, false, "runner must not start when image validation fails");
  } finally {
    runnerFactory.create = orig;
  }
});
