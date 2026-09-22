import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import {
  ClaudeToolEventExtractor,
  codexItemToToolEvent,
  formatToolEvent,
  TOOL_EVENT_MAX_CHARS,
} from "./tool-events.js";

const assistantToolUse = (id: string, name: string, input: unknown, parent: string | null = null) => ({
  type: "assistant",
  parent_tool_use_id: parent,
  message: { content: [{ type: "text", text: "on it" }, { type: "tool_use", id, name, input }] },
});
const userToolResult = (id: string, content: unknown, isError = false) => ({
  type: "user",
  parent_tool_use_id: null,
  message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] },
});

test("claude: pairs a tool_result with the name of its tool_use", () => {
  const x = new ClaudeToolEventExtractor();
  assert.deepEqual(x.extract(assistantToolUse("t1", "Bash", { command: "ls" })), [
    { id: "t1", phase: "call", name: "Bash", input: { command: "ls" } },
  ]);
  assert.deepEqual(x.extract(userToolResult("t1", [{ type: "text", text: "a.txt" }])), [
    { id: "t1", phase: "result", name: "Bash", output: "a.txt", ok: true },
  ]);
});

test("claude: marks errored results and sidechain events", () => {
  const x = new ClaudeToolEventExtractor();
  const [call] = x.extract(assistantToolUse("t2", "Read", { file_path: "x" }, "task_1"));
  assert.equal(call.parentId, "task_1");
  const [result] = x.extract(userToolResult("t2", "no such file", true));
  assert.equal(result.ok, false);
});

test("claude: ignores stream deltas, results and text-only messages", () => {
  const x = new ClaudeToolEventExtractor();
  assert.deepEqual(x.extract({ type: "stream_event", event: { type: "content_block_delta" } }), []);
  assert.deepEqual(x.extract({ type: "result", result: "done" }), []);
  assert.deepEqual(x.extract({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }), []);
});

test("masks the home directory and truncates oversized output", () => {
  const x = new ClaudeToolEventExtractor();
  const [call] = x.extract(assistantToolUse("t3", "Read", { file_path: `${homedir()}/secret.txt` }));
  assert.deepEqual(call.input, { file_path: "~/secret.txt" });
  const [result] = x.extract(userToolResult("t3", "x".repeat(TOOL_EVENT_MAX_CHARS + 10)));
  assert.ok(result.output!.startsWith("x".repeat(TOOL_EVENT_MAX_CHARS)));
  assert.match(result.output!, /\[truncated 10 chars\]$/);
});

test("truncates an oversized input into a string", () => {
  const x = new ClaudeToolEventExtractor();
  const [call] = x.extract(assistantToolUse("t4", "Write", { content: "y".repeat(TOOL_EVENT_MAX_CHARS * 2) }));
  assert.equal(typeof call.input, "string");
  assert.match(call.input as string, /\[truncated \d+ chars\]$/);
});

test("codex: command_execution carries command, output and exit code", () => {
  const item = { id: "item_2", type: "command_execution", command: "ls", status: "in_progress" };
  assert.deepEqual(codexItemToToolEvent("call", item), {
    id: "item_2", phase: "call", name: "command_execution", input: { command: "ls" },
  });
  assert.deepEqual(
    codexItemToToolEvent("result", { ...item, status: "failed", aggregated_output: "boom\n", exit_code: 2 }),
    { id: "item_2", phase: "result", name: "command_execution", input: { command: "ls" },
      output: "boom\n", exitCode: 2, ok: false },
  );
});

test("codex: file_change and mcp_tool_call normalize; agent chatter is not a tool", () => {
  assert.deepEqual(
    codexItemToToolEvent("result", { id: "i1", type: "file_change", status: "completed", changes: [{ path: "a.txt", kind: "add" }] }),
    { id: "i1", phase: "result", name: "file_change", input: { changes: [{ path: "a.txt", kind: "add" }] }, ok: true },
  );
  const mcp = codexItemToToolEvent("result", {
    id: "i2", type: "mcp_tool_call", server: "gh", tool: "search", arguments: { q: "x" }, status: "completed",
    result: { content: [{ type: "text", text: "found" }] },
  });
  assert.equal(mcp?.name, "gh.search");
  assert.equal(mcp?.ok, true);
  assert.equal(codexItemToToolEvent("result", { id: "i3", type: "agent_message" }), null);
  assert.equal(codexItemToToolEvent("result", { id: "i4", type: "reasoning" }), null);
});

test("formats calls, results and results whose call never streamed", () => {
  assert.equal(formatToolEvent({ id: "a", phase: "call", name: "Bash", input: { command: "ls" } }), "🔧 Bash(ls)\n");
  assert.equal(
    formatToolEvent({ id: "a", phase: "result", name: "Bash", output: "a\nb\n", ok: true }),
    "  ✓\n  │ a\n  │ b\n",
  );
  assert.equal(
    formatToolEvent({ id: "b", phase: "result", name: "command_execution", input: { command: "false" }, exitCode: 1, ok: false }, true),
    "🔧 command_execution(false)\n  ✗ exit 1\n",
  );
  assert.equal(
    formatToolEvent({ id: "c", phase: "call", name: "file_change", input: { changes: [{ path: "a.txt", kind: "add" }] }, parentId: "p" }),
    "  🔧 file_change(add a.txt)\n",
  );
});
