/**
 * PaperclipRunner — runs a Paperclip agent adapter's execute(ctx) and re-emits
 * its streamed output using the SAME EventEmitter contract as ClaudeSubprocess,
 * so src/server/routes.ts drives it without changes.
 *
 * Option 1 (stateless): each run is fresh — no session resume.
 */
import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import os from "os";
import fs from "fs/promises";
import path from "path";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import type { SubprocessOptions } from "../subprocess/manager.js";
import type { ClaudeCliResult, ClaudeCliStreamEvent } from "../types/claude-cli.js";
import { StreamJsonParser, type StreamJsonSink } from "./stream-json-parser.js";
import { CodexJsonlParser } from "./codex-jsonl-parser.js";
import { getBgWaitCeilingMs } from "../config.js";

export type AdapterExecute = (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>;

// The adapter runs config.promptTemplate through renderTemplate(), which substitutes/strips
// any {{ path }} delimiters. It also falls back to the default Paperclip agent instructions
// when promptTemplate is empty. So we keep promptTemplate non-empty but rendering to nothing
// (an unknown placeholder resolves to "") and send the raw user prompt through the
// non-templated task-context section instead. See src/adapter/paperclip-runner.test.ts.
const EMPTY_RENDERING_PROMPT_TEMPLATE = "{{__collavre_raw_prompt_via_context__}}";

// Context key carrying the raw prompt for prompt-template adapters (e.g. codex).
// promptTemplate references it once as {{context.<key>}}; renderTemplate's single
// pass resolves it without re-scanning, so the user's {{ }} delimiters survive.
const RAW_PROMPT_CONTEXT_KEY = "collavreRawPrompt";

// Claude-code-only CLI flags. Non-claude adapters (e.g. codex) reject these:
// their arg builders append config.extraArgs verbatim to their own CLI.
const CLAUDE_CLI_FLAGS = ["--include-partial-messages", "--no-session-persistence"];

/**
 * How a given adapter receives the raw user prompt, and how it reports output.
 * These diverge per adapter — claude-local reads the prompt from a non-templated
 * task-context section and streams claude stream-json; codex-local reads the
 * prompt from a rendered promptTemplate and emits its own `codex exec --json`
 * NDJSON, which we parse live (message-block granularity) with result.summary as
 * the terminal/fallback text.
 */
export type PromptInjection = "task-context" | "prompt-template";
export type OutputMode = "stream-json" | "codex-jsonl";

export interface PaperclipRunnerOptions {
  /** Default "task-context" (claude-local). */
  promptInjection?: PromptInjection;
  /** Default "stream-json" (claude-local). */
  outputMode?: OutputMode;
  /** Adapter base CLI flags. Default = claude-code flags; pass [] for others. */
  cliFlags?: string[];
}

export interface AgentRunner extends EventEmitter {
  start(prompt: string, options: SubprocessOptions): Promise<void>;
  kill(signal?: NodeJS.Signals): void;
}

export class PaperclipRunner extends EventEmitter implements AgentRunner {
  private pid: number | null = null;
  private processGroupId: number | null = null;
  private isKilled = false;
  private killSignal: NodeJS.Signals = "SIGTERM";
  private cwd: string | null = null;
  private streamErrored = false;
  // codex-jsonl mode: accumulates the text streamed live per agent_message block,
  // so the terminal result carries the full answer (result.result) for the
  // non-streaming path without re-emitting it as a duplicate content delta.
  private codexText = "";
  private codexStreamed = false;

  private readonly promptInjection: PromptInjection;
  private readonly outputMode: OutputMode;
  private readonly cliFlags: string[];

  constructor(
    private readonly execute: AdapterExecute,
    private readonly baseConfig: Record<string, unknown>,
    options: PaperclipRunnerOptions = {},
  ) {
    super();
    this.promptInjection = options.promptInjection ?? "task-context";
    this.outputMode = options.outputMode ?? "stream-json";
    this.cliFlags = options.cliFlags ?? CLAUDE_CLI_FLAGS;
  }

  async start(prompt: string, options: SubprocessOptions): Promise<void> {
    // Each adapter emits a different stdout dialect: claude speaks stream-json
    // (per-token deltas), codex speaks `codex exec --json` NDJSON (per-message
    // blocks). Pick the matching live parser; both expose push()/flush().
    const parser =
      this.outputMode === "stream-json"
        ? new StreamJsonParser(this.buildSink())
        : new CodexJsonlParser(this.buildCodexSink());
    this.cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-"));

    // ms (0 = unbounded) -> seconds (0 = adapter default/unbounded)
    const timeoutSec = options.timeout && options.timeout > 0 ? Math.ceil(options.timeout / 1000) : 0;

    // Adapter base flags (claude-code flags by default; [] for adapters that
    // reject them, e.g. codex). --no-session-persistence mirrors the direct
    // Claude path: without it the CLI writes a transcript per run, growing
    // unbounded and contradicting Option 1's stateless contract.
    const extraArgs: string[] = [...this.cliFlags];

    // Prompt input path is per-adapter:
    //  - task-context (claude-local): promptTemplate renders to "" (an unknown
    //    placeholder), and the raw prompt goes through the non-templated
    //    paperclipTaskMarkdown section so any {{ }} delimiters survive verbatim.
    //    systemPrompt rides the claude-only --append-system-prompt flag.
    //  - prompt-template (codex-local): the adapter ignores paperclipTaskMarkdown
    //    and builds its prompt from renderTemplate(promptTemplate), so the raw
    //    prompt (system prompt prepended) goes straight into promptTemplate.
    let promptTemplate: string;
    let context: Record<string, unknown>;
    if (this.promptInjection === "task-context") {
      promptTemplate = EMPTY_RENDERING_PROMPT_TEMPLATE;
      context = { paperclipTaskMarkdown: prompt };
      if (options.systemPrompt) extraArgs.push("--append-system-prompt", options.systemPrompt);
    } else {
      // renderTemplate is single-pass, so route the raw prompt through a context
      // variable referenced exactly once: the resolved value is NOT re-scanned, so
      // the user's own {{ }} delimiters survive verbatim. Assigning the raw prompt
      // straight to promptTemplate would let renderTemplate substitute/strip them
      // (the same corruption the claude path avoids via paperclipTaskMarkdown).
      const rawPrompt = options.systemPrompt ? `${options.systemPrompt}\n\n${prompt}` : prompt;
      context = { [RAW_PROMPT_CONTEXT_KEY]: rawPrompt };
      promptTemplate = `{{context.${RAW_PROMPT_CONTEXT_KEY}}}`;
    }

    const ctx: AdapterExecutionContext = {
      // randomUUID (not Date.now()+pid): Paperclip keys per-run bookkeeping
      // (runningProcesses map, ${runId}.log) on runId, so concurrent runs in the
      // same process/millisecond must not collide.
      runId: `run-${randomUUID()}`,
      agent: { id: "claude-max-proxy", companyId: "local", name: "proxy", adapterType: null, adapterConfig: null },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        ...this.baseConfig,
        engine: "cli", // MUST pin CLI lane (adapter defaults to ACP)
        cwd: this.cwd,
        promptTemplate,
        // Only forward the (claude-aliased) model on the claude path. For other
        // adapters the OpenAI model id selected the adapter itself, not a model
        // that adapter understands, so we let the adapter use its own default.
        ...(this.promptInjection === "task-context" ? { model: options.model } : {}),
        dangerouslySkipPermissions: true,
        timeoutSec,
        extraArgs,
        env: { CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: String(getBgWaitCeilingMs()) },
      },
      context,
      onLog: async (stream: "stdout" | "stderr", chunk: string) => {
        // Feed the mode-matched live parser: stream-json emits per-token deltas,
        // codex-jsonl emits a content delta per completed agent_message block.
        if (stream === "stdout") {
          parser.push(chunk);
        } else if (chunk.trim()) {
          console.error("[PaperclipRunner stderr]:", chunk.trim());
        }
      },
      onSpawn: async (meta: { pid: number; processGroupId: number | null; startedAt: string }) => {
        this.pid = meta.pid;
        this.processGroupId = meta.processGroupId;
        // A disconnect can call kill() before the adapter reports onSpawn — at that
        // point pid/pgid are null, so kill() only set isKilled and signaled nothing.
        // Now that the child identifiers exist, honor the pending kill immediately;
        // otherwise the orphaned run keeps going with no client until it completes.
        if (this.isKilled) this.signalProcess(this.killSignal);
      },
    };

    // Resolve immediately (like ClaudeSubprocess.start); drive execute in the background.
    void this.execute(ctx)
      .then((result) => {
        // Emit any buffered newline-less trailing line (e.g. a final codex
        // agent_message with no trailing newline) before deciding the terminal state.
        parser.flush();
        if (this.outputMode === "codex-jsonl") {
          // codex resolves normal CLI failures as an AdapterExecutionResult carrying
          // errorMessage/nonzero exitCode instead of throwing. routes.ts treats any
          // `result` event as success (it never inspects is_error), so a failed run
          // must surface as `error` — otherwise missing creds / bad args / timeouts
          // return a 200 with empty output.
          if (this.isErrorResult(result)) {
            this.cleanupCwd();
            const message = result.errorMessage
              || (result.timedOut
                ? "Paperclip adapter run timed out"
                : result.signal != null
                  ? `Paperclip adapter run terminated by signal ${result.signal}`
                  : `Paperclip adapter run failed (exit code ${result.exitCode})`);
            this.emit("error", new Error(message));
            this.emit("close", result.exitCode ?? (result.timedOut ? 124 : 1));
            return;
          }
          this.emitCodexTerminal(result);
        }
        this.cleanupCwd();
        // A stream-json terminal result marked is_error surfaces as `error` (below),
        // but the adapter can still resolve exitCode 0 (claude reports the failure
        // in-band). Force a nonzero close so the failure is reflected in the close code.
        const closeCode = result.exitCode ?? (result.timedOut ? 124 : 0);
        this.emit("close", this.streamErrored && closeCode === 0 ? 1 : closeCode);
      })
      .catch((err: unknown) => {
        parser.flush();
        this.cleanupCwd();
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
        this.emit("close", 1);
      });
  }

  /** Live sink for codex-jsonl mode: each completed agent_message block streams as a
   * content delta and accumulates into codexText for the terminal result. */
  private buildCodexSink() {
    return {
      onAgentMessage: (text: string) => {
        if (!text) return;
        // Separate distinct message blocks so the streamed view matches the
        // accumulated codexText the non-streaming result reports verbatim.
        const chunk = this.codexStreamed ? `\n\n${text}` : text;
        this.codexText += chunk;
        this.codexStreamed = true;
        const delta: ClaudeCliStreamEvent = {
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: chunk } },
          session_id: "",
          uuid: "",
        };
        this.emit("content_delta", delta);
      },
      onRaw: (line: string) => this.emit("raw", line),
    };
  }

  /**
   * Terminal emit for codex-jsonl mode. If agent_message blocks streamed live, the
   * answer text is already on the wire — emit only the terminal `result` (usage/cost
   * + the full accumulated text for the non-streaming path, which reads result.result)
   * and skip re-emitting a content delta (that would duplicate the answer for streaming
   * clients). If nothing streamed (e.g. the adapter's ACP fallback puts the text only in
   * result.summary), synthesize it as one delta, preserving the pre-streaming behavior.
   */
  private emitCodexTerminal(result: AdapterExecutionResult): void {
    if (this.codexStreamed) {
      this.emitSummary(result, { text: this.codexText, skipContentDelta: true });
    } else {
      this.emitSummary(result);
    }
  }

  /** A codex adapter result that represents a failed run (not a throw). */
  private isErrorResult(result: AdapterExecutionResult): boolean {
    // A signal-terminated child (SIGKILL from OOM, operator/system SIGTERM)
    // resolves with exitCode: null + signal set, and codex normalization only
    // sets errorMessage when (exitCode ?? 0) is nonzero — so the exitCode/
    // errorMessage checks alone miss it. Treat any set signal as a failure.
    return (
      Boolean(result.errorMessage)
      || result.timedOut === true
      || result.signal != null
      || (result.exitCode ?? 0) !== 0
    );
  }

  /**
   * Synthesize the events routes.ts consumes from a normalized
   * AdapterExecutionResult. `opts.text` overrides result.summary as the final text
   * (codex-jsonl passes the live-accumulated blocks); `opts.skipContentDelta` omits
   * the synthesized delta when the text already streamed live.
   */
  private emitSummary(
    result: AdapterExecutionResult,
    opts: { text?: string; skipContentDelta?: boolean } = {},
  ): void {
    const text = (opts.text ?? result.summary ?? "").toString();
    const sessionId = result.sessionId ?? "";
    if (text && !opts.skipContentDelta) {
      const delta: ClaudeCliStreamEvent = {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text } },
        session_id: sessionId,
        uuid: "",
      };
      this.emit("content_delta", delta);
    }
    const synthesized: ClaudeCliResult = {
      type: "result",
      subtype: result.timedOut || result.exitCode !== 0 ? "error" : "success",
      is_error: Boolean(result.errorMessage) || result.timedOut || result.exitCode !== 0,
      duration_ms: 0,
      duration_api_ms: 0,
      num_turns: 1,
      result: text,
      session_id: sessionId,
      total_cost_usd: result.costUsd ?? 0,
      usage: {
        input_tokens: result.usage?.inputTokens ?? 0,
        output_tokens: result.usage?.outputTokens ?? 0,
      },
      modelUsage: {},
    };
    this.emit("result", synthesized);
  }

  private buildSink(): StreamJsonSink {
    return {
      onMessage: (message) => this.emit("message", message),
      onContentDelta: (event) => this.emit("content_delta", event),
      onAssistant: (message) => this.emit("assistant", message),
      onResult: (message) => {
        const result = message as ClaudeCliResult;
        const usage = result.usage;
        if (usage) {
          console.error(`[PaperclipRunner] Tokens: in=${usage.input_tokens || 0} out=${usage.output_tokens || 0}`);
        }
        // The claude stream-json path can deliver a well-formed terminal result
        // marked is_error/subtype:"error" (e.g. max-turns reached, execution error)
        // without throwing. routes.ts treats any `result` event as a 200 success, so
        // a failed run must surface as `error` — otherwise the client gets a 200 with
        // the (often empty/partial) error text instead of an adapter error.
        if (result.is_error === true || result.subtype === "error") {
          this.streamErrored = true;
          const text = (result.result ?? "").toString().trim();
          this.emit("error", new Error(text || `Paperclip adapter run failed (subtype: ${result.subtype})`));
          return;
        }
        this.emit("result", message);
      },
      onRaw: (line) => this.emit("raw", line),
    };
  }

  private cleanupCwd(): void {
    if (this.cwd) {
      const dir = this.cwd;
      this.cwd = null;
      void fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    if (this.isKilled) return;
    this.isKilled = true;
    this.killSignal = signal; // remembered so a late onSpawn can honor this kill
    this.signalProcess(signal);
  }

  /** Signal the child's own process group (preferred) or pid. No-op until onSpawn. */
  private signalProcess(signal: NodeJS.Signals): void {
    if (this.processGroupId != null) {
      try { process.kill(-this.processGroupId, signal); return; } catch { /* fall through */ }
    }
    if (this.pid != null) {
      try { process.kill(this.pid, signal); } catch { /* already gone */ }
    }
  }
}
