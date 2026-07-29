/**
 * Line-buffered parser for Claude Code CLI `--output-format stream-json` NDJSON.
 * PaperclipRunner feeds adapter stdout through it to normalize live events.
 */
import type { ClaudeCliMessage, ClaudeCliStreamEvent } from "../types/claude-cli.js";
import { isContentDelta, isAssistantMessage, isResultMessage } from "../types/claude-cli.js";

export interface StreamJsonSink {
  onMessage?(msg: ClaudeCliMessage): void;
  onContentDelta(event: ClaudeCliStreamEvent): void;
  onAssistant(msg: ClaudeCliMessage): void;
  onResult(msg: ClaudeCliMessage): void;
  onRaw?(line: string): void;
}

export class StreamJsonParser {
  private buffer = "";

  constructor(private readonly sink: StreamJsonSink) {}

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
    let message: ClaudeCliMessage;
    try {
      message = JSON.parse(trimmed) as ClaudeCliMessage;
    } catch {
      this.sink.onRaw?.(trimmed);
      return;
    }
    this.sink.onMessage?.(message);
    if (isContentDelta(message)) {
      this.sink.onContentDelta(message);
    } else if (isAssistantMessage(message)) {
      this.sink.onAssistant(message);
    } else if (isResultMessage(message)) {
      this.sink.onResult(message);
    }
  }
}
