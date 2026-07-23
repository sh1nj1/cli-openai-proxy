/**
 * PaperclipRunner — runs a Paperclip agent adapter's execute(ctx) and re-emits
 * its streamed output using the SAME EventEmitter contract as ClaudeSubprocess,
 * so src/server/routes.ts drives it without changes.
 *
 * Option 1 (stateless): each run is fresh — no session resume.
 */
import { EventEmitter } from "events";
import os from "os";
import fs from "fs/promises";
import path from "path";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import type { SubprocessOptions } from "../subprocess/manager.js";
import type { ClaudeCliResult } from "../types/claude-cli.js";
import { StreamJsonParser, type StreamJsonSink } from "./stream-json-parser.js";
import { getBgWaitCeilingMs } from "../config.js";

export type AdapterExecute = (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>;

// The adapter runs config.promptTemplate through renderTemplate(), which substitutes/strips
// any {{ path }} delimiters. It also falls back to the default Paperclip agent instructions
// when promptTemplate is empty. So we keep promptTemplate non-empty but rendering to nothing
// (an unknown placeholder resolves to "") and send the raw user prompt through the
// non-templated task-context section instead. See src/adapter/paperclip-runner.test.ts.
const EMPTY_RENDERING_PROMPT_TEMPLATE = "{{__collavre_raw_prompt_via_context__}}";

export interface AgentRunner extends EventEmitter {
  start(prompt: string, options: SubprocessOptions): Promise<void>;
  kill(signal?: NodeJS.Signals): void;
}

export class PaperclipRunner extends EventEmitter implements AgentRunner {
  private pid: number | null = null;
  private processGroupId: number | null = null;
  private isKilled = false;
  private cwd: string | null = null;

  constructor(
    private readonly execute: AdapterExecute,
    private readonly baseConfig: Record<string, unknown>,
  ) {
    super();
  }

  async start(prompt: string, options: SubprocessOptions): Promise<void> {
    const parser = new StreamJsonParser(this.buildSink());
    this.cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-"));

    // ms (0 = unbounded) -> seconds (0 = adapter default/unbounded)
    const timeoutSec = options.timeout && options.timeout > 0 ? Math.ceil(options.timeout / 1000) : 0;

    // --no-session-persistence mirrors the direct Claude path (subprocess/manager.ts): without it
    // the CLI writes a transcript per run under the user's Claude config, growing unbounded and
    // contradicting Option 1's stateless contract.
    const extraArgs: string[] = ["--include-partial-messages", "--no-session-persistence"];
    if (options.systemPrompt) extraArgs.push("--append-system-prompt", options.systemPrompt);

    const ctx: AdapterExecutionContext = {
      runId: `run-${Date.now()}-${process.pid}`,
      agent: { id: "claude-max-proxy", companyId: "local", name: "proxy", adapterType: null, adapterConfig: null },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        ...this.baseConfig,
        engine: "cli", // MUST pin CLI lane (adapter defaults to ACP)
        cwd: this.cwd,
        promptTemplate: EMPTY_RENDERING_PROMPT_TEMPLATE, // renders to ""; raw prompt goes via context below
        model: options.model,
        dangerouslySkipPermissions: true,
        timeoutSec,
        extraArgs,
        env: { CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: String(getBgWaitCeilingMs()) },
      },
      // paperclipTaskMarkdown is appended verbatim (not run through renderTemplate), so the
      // user's prompt reaches Claude with any {{ }} delimiters intact.
      context: { paperclipTaskMarkdown: prompt },
      onLog: async (stream: "stdout" | "stderr", chunk: string) => {
        if (stream === "stdout") {
          parser.push(chunk);
        } else if (chunk.trim()) {
          console.error("[PaperclipRunner stderr]:", chunk.trim());
        }
      },
      onSpawn: async (meta: { pid: number; processGroupId: number | null; startedAt: string }) => {
        this.pid = meta.pid;
        this.processGroupId = meta.processGroupId;
      },
    };

    // Resolve immediately (like ClaudeSubprocess.start); drive execute in the background.
    void this.execute(ctx)
      .then((result) => {
        parser.flush();
        this.cleanupCwd();
        this.emit("close", result.exitCode ?? (result.timedOut ? 124 : 0));
      })
      .catch((err: unknown) => {
        parser.flush();
        this.cleanupCwd();
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
        this.emit("close", 1);
      });
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
    if (this.processGroupId != null) {
      try { process.kill(-this.processGroupId, signal); return; } catch { /* fall through */ }
    }
    if (this.pid != null) {
      try { process.kill(this.pid, signal); } catch { /* already gone */ }
    }
  }
}
