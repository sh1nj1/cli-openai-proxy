/**
 * Normalizes the tool activity each CLI already prints (claude stream-json
 * tool_use/tool_result, codex item.started/item.completed) into one ToolEvent
 * shape, so the route layer can surface it without knowing which lane ran.
 */
import { homedir } from "node:os";

/** Tool output and input are file contents and command lines — cap what one event can carry (UTF-8 bytes). */
export const TOOL_EVENT_MAX_BYTES = 4096;

export interface ToolEvent {
  /** Pairs a call with its result (claude tool_use id / codex item id). */
  id: string;
  phase: "call" | "result";
  /** Tool name (claude) or codex item type (command_execution, file_change, …). */
  name: string;
  input?: unknown;
  output?: string;
  exitCode?: number;
  ok?: boolean;
  /** Set when the event came from a subagent's sidechain (claude Task). */
  parentId?: string;
}

const HOME = homedir();

/** @internal exported for tests — `home` lets a POSIX test run exercise a Windows home. */
export function maskHome(text: string, home = HOME): string {
  // The absolute home path names the OS user running the proxy; callers only need the relative shape.
  if (!home || home === "/") return text;
  // Inputs and non-string results are masked after JSON.stringify, which doubles Windows backslashes.
  const escaped = JSON.stringify(home).slice(1, -1);
  const masked = escaped === home ? text : text.split(escaped).join("~");
  return masked.split(home).join("~");
}

const mask = (text: string): string => maskHome(text);

function clip(text: string): string {
  const masked = mask(text);
  const bytes = Buffer.from(masked, "utf8");
  if (bytes.length <= TOOL_EVENT_MAX_BYTES) return masked;
  // Back off to a character boundary so the cut never emits a replacement char.
  let end = TOOL_EVENT_MAX_BYTES;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return `${bytes.subarray(0, end).toString("utf8")}… [truncated ${bytes.length - end} bytes]`;
}

function clipInput(input: unknown): unknown {
  if (input === undefined) return undefined;
  const json = JSON.stringify(input) ?? "";
  const masked = mask(json);
  if (Buffer.byteLength(masked, "utf8") <= TOOL_EVENT_MAX_BYTES) {
    try { return JSON.parse(masked); } catch { return masked; }
  }
  return clip(json);
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : ""))
      .filter(Boolean)
      .join("\n");
  }
  return content == null ? "" : JSON.stringify(content);
}

function compact<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

interface ClaudeBlock {
  type?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

/**
 * Stateful per run: a claude tool_result carries only the tool_use_id, so the
 * name has to be remembered from the matching assistant tool_use.
 */
export class ClaudeToolEventExtractor {
  private readonly names = new Map<string, string>();

  /** Takes any stream-json line; returns [] for everything but complete assistant/user messages. */
  extract(message: unknown): ToolEvent[] {
    const msg = message as { type?: string; message?: { content?: unknown }; parent_tool_use_id?: string | null };
    if (msg?.type !== "assistant" && msg?.type !== "user") return [];
    const content = msg.message?.content;
    if (!Array.isArray(content)) return [];
    const parentId = msg.parent_tool_use_id ?? undefined;
    const events: ToolEvent[] = [];
    for (const block of content as ClaudeBlock[]) {
      if (msg.type === "assistant" && block?.type === "tool_use" && block.id) {
        const name = block.name ?? "tool";
        this.names.set(block.id, name);
        events.push(compact({ id: block.id, phase: "call", name, input: clipInput(block.input), parentId }));
      } else if (msg.type === "user" && block?.type === "tool_result" && block.tool_use_id) {
        events.push(compact({
          id: block.tool_use_id,
          phase: "result",
          name: this.names.get(block.tool_use_id) ?? "tool",
          output: clip(textOf(block.content)),
          ok: block.is_error !== true,
          parentId,
        }));
      }
    }
    return events;
  }
}

export interface CodexItem {
  id?: string;
  type?: string;
  status?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  changes?: Array<{ path?: string; kind?: string }>;
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  error?: unknown;
  query?: string;
}

/** Item types that are the agent talking, not acting — they already reach the caller as content or are internal. */
const CODEX_NON_TOOL_ITEMS = new Set(["agent_message", "reasoning", "todo_list", "error"]);

export function codexItemToToolEvent(phase: "call" | "result", item: CodexItem): ToolEvent | null {
  if (!item?.type || !item.id || CODEX_NON_TOOL_ITEMS.has(item.type)) return null;
  const base = { id: item.id, phase, name: item.type };
  switch (item.type) {
    case "command_execution":
      return compact({
        ...base,
        input: clipInput({ command: item.command }),
        ...(phase === "result" ? {
          output: clip(item.aggregated_output ?? ""),
          exitCode: item.exit_code ?? undefined,
          ok: item.status !== "failed" && (item.exit_code ?? 0) === 0,
        } : {}),
      });
    case "file_change":
      return compact({
        ...base,
        input: clipInput({ changes: item.changes ?? [] }),
        ...(phase === "result" ? { ok: item.status !== "failed" } : {}),
      });
    case "mcp_tool_call":
      return compact({
        ...base,
        name: [item.server, item.tool].filter(Boolean).join(".") || item.type,
        input: clipInput(item.arguments),
        ...(phase === "result" ? {
          output: clip(textOf(item.error ?? item.result)),
          ok: item.status !== "failed" && item.error == null,
        } : {}),
      });
    case "web_search":
      return compact({ ...base, input: clipInput({ query: item.query }), ...(phase === "result" ? { ok: item.status !== "failed" } : {}) });
    default:
      return compact({ ...base, ...(phase === "result" ? { ok: item.status !== "failed" } : {}) });
  }
}

function summarizeInput(input: unknown): string {
  if (input === undefined) return "";
  if (typeof input === "string") return input;
  const obj = input as Record<string, unknown>;
  // Most tools have one argument that identifies the action; show it bare rather than as JSON.
  for (const key of ["command", "file_path", "path", "pattern", "query", "url", "description"]) {
    if (typeof obj?.[key] === "string") return obj[key] as string;
  }
  if (Array.isArray(obj?.changes)) {
    return (obj.changes as Array<{ path?: string; kind?: string }>).map((c) => `${c.kind ?? "edit"} ${c.path ?? ""}`).join(", ");
  }
  return JSON.stringify(input);
}

export interface FormatOptions {
  /** Short per-run tag (e.g. "#2") so a result can be paired with its call when others interleave. */
  label?: string;
  /**
   * What to print above a result: "call" when its call never streamed (codex file_change has no
   * item.started), "ref" when other events came between call and result, "none" when adjacent.
   */
  head?: "none" | "call" | "ref";
}

/** Human-readable line(s) for `reasoning_content`; the structured event rides alongside for machines. */
export function formatToolEvent(event: ToolEvent, { label, head = "none" }: FormatOptions = {}): string {
  const indent = event.parentId ? "  " : "";
  const tag = label ? `${label} ` : "";
  const callLine = `${indent}🔧 ${tag}${event.name}(${summarizeInput(event.input)})\n`;
  if (event.phase === "call") return callLine;
  const headLine = head === "call" ? callLine : head === "ref" ? `${indent}↳ ${tag}${event.name}\n` : "";
  const status = event.ok === false
    ? `✗${event.exitCode != null ? ` exit ${event.exitCode}` : ""}`
    : "✓";
  const output = event.output?.trim();
  if (!output) return `${headLine}${indent}  ${status}\n`;
  const body = output.split("\n").map((line) => `${indent}  │ ${line}`).join("\n");
  return `${headLine}${indent}  ${status}\n${body}\n`;
}
