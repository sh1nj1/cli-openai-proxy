import { test } from "node:test";
import assert from "node:assert/strict";
import { StreamJsonParser, type StreamJsonSink } from "./stream-json-parser.js";

function collectingSink() {
  const events: Array<[string, unknown]> = [];
  const sink: StreamJsonSink = {
    onMessage: (m) => events.push(["message", m]),
    onContentDelta: (ev) => events.push(["content_delta", ev]),
    onAssistant: (m) => events.push(["assistant", m]),
    onResult: (m) => events.push(["result", m]),
    onRaw: (l) => events.push(["raw", l]),
  };
  return { events, sink };
}

const delta = JSON.stringify({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } },
  session_id: "s", uuid: "u",
});
const result = JSON.stringify({
  type: "result", subtype: "success", is_error: false, result: "Hi",
  session_id: "s", total_cost_usd: 0, duration_ms: 1, duration_api_ms: 1,
  num_turns: 1, usage: { input_tokens: 5, output_tokens: 1 }, modelUsage: {},
});

test("parses complete NDJSON lines and classifies them", () => {
  const { events, sink } = collectingSink();
  const p = new StreamJsonParser(sink);
  p.push(delta + "\n" + result + "\n");
  const kinds = events.map((e) => e[0]);
  assert.deepEqual(kinds, ["message", "content_delta", "message", "result"]);
});

test("buffers a line split across chunks", () => {
  const { events, sink } = collectingSink();
  const p = new StreamJsonParser(sink);
  const mid = Math.floor(delta.length / 2);
  p.push(delta.slice(0, mid));
  assert.equal(events.length, 0, "no event until newline arrives");
  p.push(delta.slice(mid) + "\n");
  assert.deepEqual(events.map((e) => e[0]), ["message", "content_delta"]);
});

test("flush() emits a trailing newline-less line; non-JSON goes to onRaw", () => {
  const { events, sink } = collectingSink();
  const p = new StreamJsonParser(sink);
  p.push("not json");
  p.flush();
  assert.deepEqual(events, [["raw", "not json"]]);
});
