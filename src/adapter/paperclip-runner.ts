/**
 * PaperclipRunner — runs a Paperclip agent adapter's execute(ctx) and re-emits
 * normalized events for the OpenAI-compatible route layer.
 *
 * Option 1 (stateless): each run is fresh — no session resume.
 */
import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import os from "os";
import fs from "fs/promises";
import path from "path";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";
import type { ClaudeCliResult, ClaudeCliStreamEvent } from "../types/claude-cli.js";
import { isSystemInit } from "../types/claude-cli.js";
import type { AgentRunner, RunnerOptions } from "./agent-runner.js";
import { StreamJsonParser, type StreamJsonSink } from "./stream-json-parser.js";
import { CodexJsonlParser } from "./codex-jsonl-parser.js";
import { adapterRunError, engineUnauthenticatedError } from "./adapter-error.js";
import { prepareCodexCustomHome } from "./codex-custom-home.js";
import { blankedProxySecrets, getBgWaitCeilingMs } from "../config.js";
import { getProvisionedAuthEnv, getProvisionedGateway } from "../auth/token-store.js";
import {
  currentWorkspaceContext,
  ensureWorkspaceRoot,
} from "../provision/workspace-context.js";

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
  /** Passed to the CLI verbatim. Absent means the CLI picks its own default model. */
  model?: string;
  /** Default "task-context" (claude-local). */
  promptInjection?: PromptInjection;
  /** Default "stream-json" (claude-local). */
  outputMode?: OutputMode;
  /** Adapter base CLI flags. Default = claude-code flags; pass [] for others. */
  cliFlags?: string[];
  /** Engine id for /v1/auth (e.g. "claude", "codex"); rides an auth failure so a
   *  caller knows which login flow to open. */
  engine?: string;
}

export class PaperclipRunner extends EventEmitter implements AgentRunner {
  private pid: number | null = null;
  private processGroupId: number | null = null;
  private isKilled = false;
  private killSignal: NodeJS.Signals = "SIGTERM";
  private cwd: string | null = null;
  private streamErrored = false;
  // In-band failure text from a claude stream-json is_error terminal result, held
  // (not emitted) until resolve so the classified AdapterExecutionResult can carry it.
  private streamErrorText = "";
  // codex-jsonl mode: true once at least one agent_message block streamed live, so
  // the terminal emit skips a duplicate content delta (the answer is already on the
  // wire) yet still falls back to a synthesized delta when nothing streamed.
  private codexStreamed = false;
  // The model the run announced at init. Nothing later says which chain a
  // modelUsage entry belongs to, so this is the only handle on the main chain.
  private mainChainModel: string | null = null;

  private readonly model?: string;
  private readonly promptInjection: PromptInjection;
  private readonly outputMode: OutputMode;
  private readonly cliFlags: string[];
  private readonly engine?: string;

  constructor(
    private readonly execute: AdapterExecute,
    private readonly baseConfig: Record<string, unknown>,
    options: PaperclipRunnerOptions = {},
  ) {
    super();
    this.model = options.model;
    this.promptInjection = options.promptInjection ?? "task-context";
    this.outputMode = options.outputMode ?? "stream-json";
    this.cliFlags = options.cliFlags ?? CLAUDE_CLI_FLAGS;
    this.engine = options.engine;
  }

  async start(prompt: string, options: RunnerOptions): Promise<void> {
    const workspace = currentWorkspaceContext();
    if (workspace?.scoped) ensureWorkspaceRoot(workspace);
    const sharedPaperclipHome = workspace?.scoped
      ? path.join(workspace.userHome, ".paperclip")
      : undefined;
    const sharedPaperclipInstanceRoot = sharedPaperclipHome
      ? resolvePaperclipInstanceRootForAdapter({ homeDir: sharedPaperclipHome })
      : undefined;
    const sharedCodexHome = sharedPaperclipInstanceRoot
      ? path.join(sharedPaperclipInstanceRoot, "companies", "local", "codex-home")
      : undefined;

    // codex_custom reaches its models through a gateway that exists only once
    // provisioned, and the CLI takes that routing from a config file rather than
    // any flag — so resolve it up front. Refusing here (as a classified 401 that
    // names the engine, the same shape a CLI auth failure produces) beats
    // launching a CLI that would authenticate against nothing and fail opaquely.
    let codexCustomHome: string | undefined;
    if (this.engine === "codex_custom") {
      const gateway = getProvisionedGateway(this.engine);
      if (!gateway) {
        this.emit(
          "error",
          engineUnauthenticatedError(
            this.engine,
            "No gateway is provisioned for paperclip/codex_custom. Submit an API key and " +
              "`base_url` to POST /v1/auth/codex_custom/sessions first.",
          ),
        );
        this.emit("close", 1);
        return;
      }
      codexCustomHome = await prepareCodexCustomHome(gateway.baseUrl, sharedPaperclipHome);
    }
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
      agent: { id: "cli-openai-proxy", companyId: "local", name: "proxy", adapterType: null, adapterConfig: null },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        ...this.baseConfig,
        engine: "cli", // MUST pin CLI lane (adapter defaults to ACP)
        cwd: this.cwd,
        promptTemplate,
        // Models are pass-through: this proxy keeps no catalog, so the CLI is the
        // only authority on what is valid. Omit the key entirely when unset so each
        // CLI falls back to its own default model.
        ...(this.model ? { model: this.model } : {}),
        dangerouslySkipPermissions: true,
        timeoutSec,
        extraArgs,
        env: {
          CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: String(getBgWaitCeilingMs()),
	  ...(workspace?.scoped ? {
	    HOME: workspace.root!,
	    CLAUDE_CONFIG_DIR: path.join(workspace.root!, ".claude"),
	    PAPERCLIP_HOME: sharedPaperclipHome!,
	    ...(this.engine === "codex" ? {
	      // Keep Codex on the user-scoped managed home even though HOME points at
	      // the agent workspace. The adapter seeds it from the login CLI's ~/.codex.
	      CODEX_HOME: sharedCodexHome!,
	    } : {}),
	  } : {}),
          // Deliberately outside the Paperclip-managed company tree: this home
          // carries no auth.json, and a managed one without it is refused before
          // launch. See src/adapter/codex-custom-home.ts.
          ...(codexCustomHome ? { CODEX_HOME: codexCustomHome } : {}),
          // The adapter merges this over process.env, so shadowing is the only way
          // to keep the keys that authenticate callers TO the proxy out of a child
          // that runs with permissions skipped.
          ...blankedProxySecrets(),
          // Credentials provisioned through /v1/auth live in memory only, so env
          // is the sole channel that reaches the adapter's CLI child. Scoped to
          // THIS adapter's engine: every adapter spawns a different vendor's CLI,
          // so an unscoped merge would hand one vendor's token to another's process.
          ...getProvisionedAuthEnv(this.engine),
        },
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

    // Resolve immediately so the route can begin streaming while execute runs.
    void this.execute(ctx)
      .then((result) => {
        // Emit any buffered newline-less trailing line (e.g. a final codex
        // agent_message with no trailing newline) before deciding the terminal state.
        parser.flush();

        // Both adapters resolve normal CLI failures as an AdapterExecutionResult
        // (errorMessage/nonzero exit/timeout/signal) rather than throwing, and the
        // claude stream-json path can additionally report a failure in-band via an
        // is_error terminal result (recorded in streamErrored/streamErrorText). routes.ts
        // treats any `result` event as a 200 success (it never inspects is_error), so
        // every failure must surface as an `error` carrying the verbatim CLI message +
        // OpenAI classification — otherwise usage limits, auth prompts, and timeouts
        // return a 200 with empty/partial output instead of the 429/401/500 the OpenAI
        // contract expects.
        const failed = this.streamErrored || this.isErrorResult(result);
        if (this.outputMode === "codex-jsonl" && !failed) {
          // codex's final answer lives in result.summary; synthesize it only for a
          // successful run (a failure falls through to the shared handling below).
          this.emitCodexTerminal(result);
        }
        this.cleanupCwd();
        if (failed) {
          this.emit("error", adapterRunError(this.failureMessage(result), result, this.engine));
          this.emit("close", this.failureCloseCode(result));
          return;
        }
        this.emit("close", result.exitCode ?? (result.timedOut ? 124 : 0));
      })
      .catch((err: unknown) => {
        parser.flush();
        this.cleanupCwd();
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
        this.emit("close", 1);
      });
  }

  /** Live sink for codex-jsonl mode: each completed agent_message block streams as a
   * content delta so agentic turns render block-by-block. The terminal result is
   * sourced from result.summary (codex's final answer), not these live blocks. */
  private buildCodexSink() {
    return {
      onAgentMessage: (text: string) => {
        if (!text) return;
        // Separate distinct message blocks so multi-block agentic turns render
        // readably on the live wire.
        const chunk = this.codexStreamed ? `\n\n${text}` : text;
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
   * answer is already on the wire — emit only the terminal `result` (usage/cost) and
   * skip re-emitting a content delta (that would duplicate the answer for streaming
   * clients). Either way result.result carries result.summary, codex's final
   * agent_message: the non-streaming path (and streaming JSON mode) run result.result
   * through extractJsonFromText, which returns the FIRST JSON object — so concatenating
   * intermediate blocks would let a status object win over the real answer.
   * If nothing streamed (the adapter's ACP fallback puts the text only in
   * result.summary), synthesize it as one delta, preserving the pre-streaming behavior.
   */
  private emitCodexTerminal(result: AdapterExecutionResult): void {
    this.emitSummary(result, { skipContentDelta: this.codexStreamed });
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
   * The verbatim failure message to surface. Prefer the adapter's classified
   * errorMessage (usage limit / auth prompt / CLI stderr), then any in-band
   * stream-json error text, then a shape-derived fallback.
   */
  private failureMessage(result: AdapterExecutionResult): string {
    return (result.errorMessage?.trim())
      || this.streamErrorText
      || (result.timedOut
        ? "Paperclip adapter run timed out"
        : result.signal != null
          ? `Paperclip adapter run terminated by signal ${result.signal}`
          : `Paperclip adapter run failed (exit code ${result.exitCode})`);
  }

  /**
   * A failed run must close nonzero even when the adapter resolves exitCode 0
   * (claude can report a usage limit / in-band error while exiting cleanly).
   */
  private failureCloseCode(result: AdapterExecutionResult): number {
    if (result.exitCode != null && result.exitCode !== 0) return result.exitCode;
    return result.timedOut ? 124 : 1;
  }

  /**
   * Synthesize the events routes.ts consumes from a normalized
   * AdapterExecutionResult. result.summary is the final answer; `opts.skipContentDelta`
   * omits the synthesized delta when that text already streamed live (codex-jsonl).
   */
  private emitSummary(
    result: AdapterExecutionResult,
    opts: { skipContentDelta?: boolean } = {},
  ): void {
    const text = (result.summary ?? "").toString();
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
      usage: this.synthesizeUsage(result.usage),
      modelUsage: {},
    };
    this.emit("result", this.stampMainChain(synthesized));
  }

  /**
   * Name the main chain on the result. The CLI reports per-model totals but
   * never says which model ran the main chain, while the top-level `usage` is
   * that chain's alone — so billing has to carry the name forward from init.
   */
  private stampMainChain(result: ClaudeCliResult): ClaudeCliResult {
    if (this.mainChainModel) result.mainChainModel = this.mainChainModel;
    return result;
  }

  /**
   * Adapter UsageSummary -> the CLI result's token buckets.
   *
   * The two count the prompt differently: codex reports cached_input_tokens as a
   * subset of input_tokens, while every consumer of ClaudeCliResult (usage
   * tracker, OpenAI usage) treats input and cache-read as disjoint and sums them.
   * So the cached share moves OUT of input rather than being added on top —
   * keeping the prompt total identical while the cache split stops reading zero.
   */
  private synthesizeUsage(usage: AdapterExecutionResult["usage"]): ClaudeCliResult["usage"] {
    const cached = usage?.cachedInputTokens ?? 0;
    return {
      input_tokens: Math.max(0, (usage?.inputTokens ?? 0) - cached),
      output_tokens: usage?.outputTokens ?? 0,
      cache_read_input_tokens: cached,
    };
  }

  private buildSink(): StreamJsonSink {
    return {
      onMessage: (message) => {
        if (isSystemInit(message)) this.mainChainModel = message.model;
        this.emit("message", message);
      },
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
        // this must NOT surface as a success result. Record the failure (with its
        // in-band text) and let the shared error handling on resolve emit it — the
        // resolved AdapterExecutionResult carries the errorCode/errorFamily needed to
        // classify it (429/401/…) that this event alone lacks.
        if (result.is_error === true || result.subtype === "error") {
          this.streamErrored = true;
          this.streamErrorText = (result.result ?? "").toString().trim()
            || `Paperclip adapter run failed (subtype: ${result.subtype})`;
          return;
        }
        this.emit("result", this.stampMainChain(result));
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
