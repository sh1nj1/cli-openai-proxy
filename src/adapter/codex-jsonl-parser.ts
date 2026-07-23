/**
 * Line-buffered parser for `codex exec --json` NDJSON. Codex emits its own event
 * shapes (thread.started / turn.started / item.completed / turn.completed / error /
 * turn.failed) — NOT claude stream-json — so StreamJsonParser (claude-only) cannot
 * classify it; this dedicated parser mirrors its shape but reads codex events.
 *
 * Path 1 streaming is message-block granularity: codex prints an agent_message as a
 * single `item.completed` line once that message is fully generated (there are no
 * token deltas), so each completed agent_message block is the natural streaming unit.
 * Terminal usage/errors come from the adapter's normalized result, so this parser
 * only surfaces the incremental answer text.
 */
export interface CodexJsonlSink {
  /** One completed agent_message block's text (one call per `item.completed`). */
  onAgentMessage(text: string): void;
  /** A stdout line that is not codex JSONL (e.g. the "Reading … stdin" notice). */
  onRaw?(line: string): void;
}

interface CodexEvent {
  type?: string;
  item?: { type?: string; text?: unknown };
}

export class CodexJsonlParser {
  private buffer = "";

  constructor(private readonly sink: CodexJsonlSink) {}

  /** Feed a raw stdout chunk (may contain 0..n newlines / partial lines). */
  push(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || ""; // keep incomplete trailing line
    for (const line of lines) this.handleLine(line);
  }

  /** Flush any buffered newline-less remainder (call on stream end). */
  flush(): void {
    if (this.buffer.trim()) {
      this.handleLine(this.buffer);
    }
    this.buffer = "";
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event: CodexEvent;
    try {
      event = JSON.parse(trimmed) as CodexEvent;
    } catch {
      this.sink.onRaw?.(trimmed);
      return;
    }
    if (
      event.type === "item.completed"
      && event.item?.type === "agent_message"
      && typeof event.item.text === "string"
    ) {
      this.sink.onAgentMessage(event.item.text);
    }
  }
}
