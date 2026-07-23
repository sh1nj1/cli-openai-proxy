import { test } from "node:test";
import assert from "node:assert/strict";
import { CodexJsonlParser, type CodexJsonlSink } from "./codex-jsonl-parser.js";

function collectingSink() {
  const messages: string[] = [];
  const raw: string[] = [];
  const sink: CodexJsonlSink = {
    onAgentMessage: (t) => messages.push(t),
    onRaw: (l) => raw.push(l),
  };
  return { messages, raw, sink };
}

const threadStarted = JSON.stringify({ type: "thread.started", thread_id: "t1" });
const turnStarted = JSON.stringify({ type: "turn.started" });
const agentMessage = (text: string) =>
  JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "agent_message", text } });
const turnCompleted = JSON.stringify({
  type: "turn.completed",
  usage: { input_tokens: 17, cached_input_tokens: 0, output_tokens: 7 },
});

test("emits one agent_message per completed agent_message item, ignoring other events", () => {
  const { messages, sink } = collectingSink();
  const p = new CodexJsonlParser(sink);
  p.push([threadStarted, turnStarted, agentMessage("hello world."), turnCompleted].join("\n") + "\n");
  assert.deepEqual(messages, ["hello world."]);
});

test("emits multiple agent_message blocks in order", () => {
  const { messages, sink } = collectingSink();
  const p = new CodexJsonlParser(sink);
  p.push([agentMessage("first"), agentMessage("second")].join("\n") + "\n");
  assert.deepEqual(messages, ["first", "second"]);
});

test("buffers an agent_message line split across chunks", () => {
  const { messages, sink } = collectingSink();
  const p = new CodexJsonlParser(sink);
  const line = agentMessage("split me");
  const mid = Math.floor(line.length / 2);
  p.push(line.slice(0, mid));
  assert.equal(messages.length, 0, "no event until newline arrives");
  p.push(line.slice(mid) + "\n");
  assert.deepEqual(messages, ["split me"]);
});

test("flush() emits a trailing newline-less agent_message line", () => {
  const { messages, sink } = collectingSink();
  const p = new CodexJsonlParser(sink);
  p.push(agentMessage("no trailing newline"));
  assert.equal(messages.length, 0, "buffered until flush");
  p.flush();
  assert.deepEqual(messages, ["no trailing newline"]);
});

test("non-JSON lines go to onRaw and never surface as agent messages", () => {
  const { messages, raw, sink } = collectingSink();
  const p = new CodexJsonlParser(sink);
  p.push("Reading additional input from stdin...\n");
  p.push(agentMessage("real") + "\n");
  assert.deepEqual(messages, ["real"]);
  assert.deepEqual(raw, ["Reading additional input from stdin..."]);
});

test("ignores non-agent_message items (reasoning, command_execution)", () => {
  const { messages, sink } = collectingSink();
  const p = new CodexJsonlParser(sink);
  p.push(JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "thinking" } }) + "\n");
  p.push(JSON.stringify({ type: "item.completed", item: { type: "command_execution", text: "ls" } }) + "\n");
  assert.deepEqual(messages, [], "only agent_message blocks stream as content");
});
