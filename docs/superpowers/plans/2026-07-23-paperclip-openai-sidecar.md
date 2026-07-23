# Paperclip OpenAI Sidecar (Option 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `claude-max-api-proxy` so its OpenAI `/v1/chat/completions` endpoint can, for models named `paperclip/<adapterType>`, run the request through a Paperclip agent adapter's `execute(ctx)` — reusing Paperclip's published per-agent npm packages as-is — while keeping the proven SSE/keepalive/orphan-kill route layer unchanged. Collavre consumes it with **zero code changes** (agent `vendor=openai`, `gateway_url` → this proxy).

**Architecture:** `src/server/routes.ts` is already agent-agnostic: it drives an `EventEmitter` that emits `content_delta` / `assistant` / `result` / `error` / `close` and maps those to OpenAI SSE. Today the only emitter is `ClaudeSubprocess` (spawns `claude` directly). We add a second emitter, `PaperclipRunner`, that satisfies the identical contract but calls a Paperclip `ServerAdapterModule.execute(ctx)` and tees `ctx.onLog` stdout through the same Claude `stream-json` line parser. A one-line factory in `routes.ts` picks the runner by model id. Paperclip's adapters spawn the same `claude` binary with `--output-format stream-json`, so the existing parser and OpenAI mapping work as-is.

**Tech Stack:** Node ≥20 (this repo) — Paperclip adapters need a `claude` binary ≥2.1.x on PATH; TypeScript 5.7 (tsc → `dist/`); Express 4; `node --test`; npm deps `@paperclipai/adapter-utils`, `@paperclipai/adapter-claude-local` (published `2026.722.0`).

## Global Constraints

- **Runtime:** Node `>=20` (`package.json` engines). Do not raise the floor.
- **Module system:** ESM (`"type": "module"`). All relative imports use the `.js` extension in `.ts` source (e.g. `import { X } from "../types/claude-cli.js"`). Match existing files.
- **Build/test:** `npm run build` (tsc) then `npm test` (`find dist -name '*.test.js' -print0 | xargs -0 node --test`). Tests are authored as `src/**/*.test.ts` and run from compiled `dist/**/*.test.js`.
- **No new HTTP framework, no new route logic.** Reuse `src/server/routes.ts` unchanged except the runner-selection line.
- **Paperclip adapter contract is fixed** (verified against source + a live spike): `execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult>`; `ctx.onLog(stream, chunk)` streams raw, un-line-buffered stdout text; `claude-local` defaults to the **ACP** engine, so `config.engine: "cli"` MUST be set to reach the stdin/stream-json lane; a raw prompt is injected via `config.promptTemplate` with empty `context` and no session.
- **Option 1 is stateless.** No cross-request session resume (that is Option 2 / the Channel seam). Each request is a fresh Paperclip run.
- **License/attribution:** this repo is MIT (author Atal Ashutosh). Do not remove existing headers.

---

### Task 1: Extract the shared Claude `stream-json` line parser

Pull the NDJSON line-parsing logic out of `ClaudeSubprocess.processBuffer` into a reusable, sink-based parser so both `ClaudeSubprocess` and the new `PaperclipRunner` parse identically (DRY). Behavior-preserving for `ClaudeSubprocess`.

**Files:**
- Create: `src/adapter/stream-json-parser.ts`
- Create: `src/adapter/stream-json-parser.test.ts`
- Modify: `src/subprocess/manager.ts` (replace the body of `processBuffer`, lines 183-220, with a delegating call)

**Interfaces:**
- Produces: `class StreamJsonParser` with `constructor(sink: StreamJsonSink)`, `push(chunk: string): void`, `flush(): void`; and `interface StreamJsonSink { onMessage?(m): void; onContentDelta(ev): void; onAssistant(m): void; onResult(m): void; onRaw?(line: string): void }`.
- Consumes: type guards `isContentDelta`, `isAssistantMessage`, `isResultMessage` and types `ClaudeCliMessage`, `ClaudeCliStreamEvent` from `../types/claude-cli.js`.

- [ ] **Step 1: Write the failing test**

Create `src/adapter/stream-json-parser.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build 2>/dev/null; node --test dist/adapter/stream-json-parser.test.js`
Expected: FAIL — `Cannot find module '.../stream-json-parser.js'` (build error / module missing).

- [ ] **Step 3: Write the parser**

Create `src/adapter/stream-json-parser.ts`:

```ts
/**
 * Shared line-buffered parser for Claude Code CLI `--output-format stream-json`
 * NDJSON. Consumed by ClaudeSubprocess (direct spawn) and PaperclipRunner
 * (adapter onLog), so both classify stdout identically.
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
```

- [ ] **Step 4: Refactor `ClaudeSubprocess` to delegate to the parser (behavior-preserving)**

In `src/subprocess/manager.ts`:

Add the import near the top (after line 18):

```ts
import { StreamJsonParser, type StreamJsonSink } from "../adapter/stream-json-parser.js";
```

Add a parser field alongside the other private fields (after `private isKilled: boolean = false;`, line 52):

```ts
  private parser: StreamJsonParser | null = null;
```

Replace the entire `processBuffer()` method (lines 183-220) with a sink that preserves the exact side effects (delta echo to stderr, result token log, raw log) the original had:

```ts
  /**
   * Feed a stdout chunk through the shared stream-json parser and emit events.
   */
  private processChunk(chunk: string): void {
    if (!this.parser) {
      const sink: StreamJsonSink = {
        onMessage: (message) => this.emit("message", message),
        onContentDelta: (event) => {
          const text = event.event.delta?.text;
          if (text) process.stderr.write(text);
          this.emit("content_delta", event);
        },
        onAssistant: (message) => this.emit("assistant", message),
        onResult: (message) => {
          const result = message as ClaudeCliResult;
          if (result.is_error || result.subtype === "error") {
            console.error(`\n[Subprocess] Error: ${result.result}`);
          }
          const usage = result.usage;
          if (usage) {
            console.error(`[Subprocess] Tokens: in=${usage.input_tokens || 0} out=${usage.output_tokens || 0} cache_read=${usage.cache_read_input_tokens || 0} cache_write=${usage.cache_creation_input_tokens || 0}`);
          }
          this.emit("result", message);
        },
        onRaw: (line) => {
          console.error("[Subprocess raw]:", line);
          this.emit("raw", line);
        },
      };
      this.parser = new StreamJsonParser(sink);
    }
    this.parser.push(chunk);
  }
```

Update the stdout handler (was lines 108-112) to call `processChunk` directly instead of buffering:

```ts
        // Parse JSON stream from stdout
        this.process.stdout?.on("data", (chunk: Buffer) => {
          this.processChunk(chunk.toString());
        });
```

Update the close handler's flush (was lines 130-133 `if (this.buffer.trim()) { this.processBuffer(); }`) to:

```ts
          this.clearTimeout();
          // Flush any buffered partial line
          this.parser?.flush();
          this.emit("close", code);
```

Delete the now-unused `private buffer: string = "";` field (line 50).

- [ ] **Step 5: Run parser tests + existing subprocess tests to verify green**

Run: `npm run build && node --test dist/adapter/stream-json-parser.test.js dist/subprocess/manager.test.js`
Expected: PASS for the new parser tests AND the pre-existing `manager.test.js` (no behavior regression).

- [ ] **Step 6: Commit**

```bash
git add src/adapter/stream-json-parser.ts src/adapter/stream-json-parser.test.ts src/subprocess/manager.ts
git commit -m "refactor: extract shared StreamJsonParser from ClaudeSubprocess"
```

---

### Task 2: `PaperclipRunner` — adapter-backed emitter matching the runner contract

A drop-in `EventEmitter` that runs a Paperclip `ServerAdapterModule.execute(ctx)`, tees `ctx.onLog` stdout through `StreamJsonParser`, emits `content_delta`/`assistant`/`result`/`close`/`error`, and supports `kill()` via the pid captured from `ctx.onSpawn`. The `execute` function is injected so it can be unit-tested with a fake adapter (no real `claude`).

**Files:**
- Create: `src/adapter/paperclip-runner.ts`
- Create: `src/adapter/paperclip-runner.test.ts`

**Interfaces:**
- Consumes: `StreamJsonParser` (Task 1); `SubprocessOptions` from `../subprocess/manager.js`; adapter types `AdapterExecutionContext`, `AdapterExecutionResult` from `@paperclipai/adapter-utils`; `getBgWaitCeilingMs` from `../config.js`.
- Produces: `class PaperclipRunner extends EventEmitter` with `constructor(execute: AdapterExecute, baseConfig: Record<string, unknown>)`, `start(prompt: string, options: SubprocessOptions): Promise<void>`, `kill(signal?: NodeJS.Signals): void`; and `type AdapterExecute = (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>`. Emits the SAME events as `ClaudeSubprocess`. Also exports `interface AgentRunner extends EventEmitter { start(prompt: string, options: SubprocessOptions): Promise<void>; kill(signal?: NodeJS.Signals): void }`.

- [ ] **Step 1: Write the failing test**

Create `src/adapter/paperclip-runner.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { PaperclipRunner, type AdapterExecute } from "./paperclip-runner.js";
import type { ClaudeCliStreamEvent, ClaudeCliResult } from "../types/claude-cli.js";

const deltaLine = JSON.stringify({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } },
  session_id: "s", uuid: "u",
}) + "\n";
const resultLine = JSON.stringify({
  type: "result", subtype: "success", is_error: false, result: "Hi",
  session_id: "s", total_cost_usd: 0, duration_ms: 1, duration_api_ms: 1,
  num_turns: 1, usage: { input_tokens: 5, output_tokens: 1 }, modelUsage: {},
}) + "\n";

test("streams onLog stdout through the parser and emits events, then close(0)", async () => {
  const fakeExecute: AdapterExecute = async (ctx) => {
    assert.equal(ctx.config.engine, "cli", "must pin CLI lane");
    assert.equal(ctx.config.promptTemplate, "hello prompt", "raw prompt goes to promptTemplate");
    await ctx.onLog("stdout", deltaLine);
    await ctx.onLog("stdout", resultLine);
    return { exitCode: 0, signal: null, timedOut: false, sessionId: "s",
      usage: { inputTokens: 5, outputTokens: 1 } };
  };

  const runner = new PaperclipRunner(fakeExecute, { engine: "cli", command: "claude" });
  const deltas: string[] = [];
  let result: ClaudeCliResult | null = null;
  const closeCode = new Promise<number | null>((resolve) => {
    runner.on("content_delta", (ev: ClaudeCliStreamEvent) => { deltas.push(ev.event.delta?.text || ""); });
    runner.on("result", (r: ClaudeCliResult) => { result = r; });
    runner.on("close", (code: number | null) => resolve(code));
  });

  await runner.start("hello prompt", { model: "opus" });
  const code = await closeCode;

  assert.deepEqual(deltas, ["Hi"]);
  assert.ok(result, "result event fired");
  assert.equal(result!.usage.output_tokens, 1);
  assert.equal(code, 0);
});

test("emits error and close(1) when execute rejects", async () => {
  const boom: AdapterExecute = async () => { throw new Error("adapter blew up"); };
  const runner = new PaperclipRunner(boom, { engine: "cli" });
  let errMsg = "";
  const closed = new Promise<number | null>((resolve) => {
    runner.on("error", (e: Error) => { errMsg = e.message; });
    runner.on("close", (code: number | null) => resolve(code));
  });
  await runner.start("p", { model: "opus" });
  const code = await closed;
  assert.match(errMsg, /adapter blew up/);
  assert.equal(code, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build 2>/dev/null; node --test dist/adapter/paperclip-runner.test.js`
Expected: FAIL — module `./paperclip-runner.js` not found.

- [ ] **Step 3: Write `PaperclipRunner`**

Create `src/adapter/paperclip-runner.ts`:

```ts
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

    const extraArgs: string[] = ["--include-partial-messages"];
    if (options.systemPrompt) extraArgs.push("--append-system-prompt", options.systemPrompt);

    const ctx: AdapterExecutionContext = {
      runId: `run-${Date.now()}-${process.pid}`,
      agent: { id: "claude-max-proxy", companyId: "local", name: "proxy", adapterType: null, adapterConfig: null },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        ...this.baseConfig,
        engine: "cli", // MUST pin CLI lane (adapter defaults to ACP)
        cwd: this.cwd,
        promptTemplate: prompt, // raw prompt becomes the entire stdin
        model: options.model,
        dangerouslySkipPermissions: true,
        timeoutSec,
        extraArgs,
        env: { CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: String(getBgWaitCeilingMs()) },
      },
      context: {},
      onLog: async (stream: "stdout" | "stderr", chunk: string) => {
        if (stream === "stdout") {
          parser.push(chunk);
        } else if (chunk.trim()) {
          console.error("[PaperclipRunner stderr]:", chunk.trim());
        }
      },
      onSpawn: async (meta: { pid: number; processGroupId: number | null }) => {
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
```

- [ ] **Step 4: Add the dependencies**

Run:
```bash
npm install @paperclipai/adapter-utils@2026.722.0 @paperclipai/adapter-claude-local@2026.722.0
```
Expected: both added to `dependencies` in `package.json`; `@agentclientprotocol/*` pulled transitively.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run build && node --test dist/adapter/paperclip-runner.test.js`
Expected: PASS both tests (uses the injected fake `execute`; no real `claude` invoked).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/adapter/paperclip-runner.ts src/adapter/paperclip-runner.test.ts
git commit -m "feat: add PaperclipRunner adapter-backed emitter + paperclip deps"
```

---

### Task 3: Paperclip model registry + runner factory

Map `paperclip/<adapterType>` model ids to a real adapter's `execute` + base config, and provide the factory `routes.ts` uses to pick a runner.

**Files:**
- Create: `src/adapter/paperclip-registry.ts`
- Create: `src/adapter/paperclip-registry.test.ts`

**Interfaces:**
- Consumes: `execute` from `@paperclipai/adapter-claude-local/server`; `PaperclipRunner`, `AgentRunner`, `AdapterExecute` (Task 2); `ClaudeSubprocess` from `../subprocess/manager.js`.
- Produces: `resolvePaperclipModel(model: string): PaperclipModelSpec | null`, `createRunner(model: string): AgentRunner`, and `interface PaperclipModelSpec { adapterType: string; execute: AdapterExecute; baseConfig: Record<string, unknown> }`. Also `PAPERCLIP_MODEL_IDS: string[]` for `/v1/models`.

- [ ] **Step 1: Write the failing test**

Create `src/adapter/paperclip-registry.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePaperclipModel, createRunner, PAPERCLIP_MODEL_IDS } from "./paperclip-registry.js";
import { PaperclipRunner } from "./paperclip-runner.js";
import { ClaudeSubprocess } from "../subprocess/manager.js";

test("resolves a known paperclip model to a spec with an execute fn", () => {
  const spec = resolvePaperclipModel("paperclip/claude_local");
  assert.ok(spec);
  assert.equal(spec!.adapterType, "claude_local");
  assert.equal(typeof spec!.execute, "function");
  assert.equal(spec!.baseConfig.engine, "cli");
});

test("returns null for non-paperclip models", () => {
  assert.equal(resolvePaperclipModel("claude-opus-4"), null);
  assert.equal(resolvePaperclipModel("paperclip/does-not-exist"), null);
});

test("createRunner returns PaperclipRunner for paperclip models, ClaudeSubprocess otherwise", () => {
  assert.ok(createRunner("paperclip/claude_local") instanceof PaperclipRunner);
  assert.ok(createRunner("claude-opus-4") instanceof ClaudeSubprocess);
});

test("PAPERCLIP_MODEL_IDS advertises the registered ids", () => {
  assert.ok(PAPERCLIP_MODEL_IDS.includes("paperclip/claude_local"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build 2>/dev/null; node --test dist/adapter/paperclip-registry.test.js`
Expected: FAIL — module `./paperclip-registry.js` not found.

- [ ] **Step 3: Write the registry + factory**

Create `src/adapter/paperclip-registry.ts`:

```ts
/**
 * Registry mapping OpenAI model ids of the form `paperclip/<adapterType>` to a
 * Paperclip adapter's execute() + base config, plus the runner factory that
 * routes.ts uses to pick between PaperclipRunner and the direct ClaudeSubprocess.
 */
import { execute as claudeLocalExecute } from "@paperclipai/adapter-claude-local/server";
import { PaperclipRunner, type AgentRunner, type AdapterExecute } from "./paperclip-runner.js";
import { ClaudeSubprocess } from "../subprocess/manager.js";

export interface PaperclipModelSpec {
  adapterType: string;
  execute: AdapterExecute;
  baseConfig: Record<string, unknown>;
}

const REGISTRY: Record<string, PaperclipModelSpec> = {
  "paperclip/claude_local": {
    adapterType: "claude_local",
    execute: claudeLocalExecute as AdapterExecute,
    baseConfig: { engine: "cli", command: "claude" },
  },
};

export const PAPERCLIP_MODEL_IDS: string[] = Object.keys(REGISTRY);

export function resolvePaperclipModel(model: string): PaperclipModelSpec | null {
  return REGISTRY[model] ?? null;
}

/** Pick the runner for a request's model. Both satisfy AgentRunner. */
export function createRunner(model: string): AgentRunner {
  const spec = resolvePaperclipModel(model);
  if (spec) {
    return new PaperclipRunner(spec.execute, spec.baseConfig);
  }
  return new ClaudeSubprocess();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test dist/adapter/paperclip-registry.test.js`
Expected: PASS all four tests.

- [ ] **Step 5: Commit**

```bash
git add src/adapter/paperclip-registry.ts src/adapter/paperclip-registry.test.ts
git commit -m "feat: add paperclip model registry and runner factory"
```

---

### Task 4: Wire the factory into `routes.ts` (single-line runner selection)

Replace direct `ClaudeSubprocess` construction with `createRunner(requestedModel)`. Because both runners share the event + `start`/`kill` contract, no other route logic changes.

**Files:**
- Modify: `src/server/routes.ts` (lines 9, 52, and the two handler parameter types)
- Create: `src/server/routes.paperclip.test.ts`

**Interfaces:**
- Consumes: `createRunner`, `resolvePaperclipModel` (Task 3); `AgentRunner` (Task 2).

- [ ] **Step 1: Write the failing test (end-to-end via a stubbed adapter through the real HTTP handler)**

Create `src/server/routes.paperclip.test.ts`. This drives the real `handleChatCompletions` with a fake `express` req/res and a `paperclip/*` model, asserting the SSE body carries the streamed delta. It monkeypatches the registry entry's `execute` to avoid invoking `claude`.

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { EventEmitter } from "events";

// Import the module under test AND the registry we will stub.
import { handleChatCompletions } from "./routes.js";
import * as registry from "../adapter/paperclip-registry.js";
import { PaperclipRunner, type AdapterExecute } from "../adapter/paperclip-runner.js";

const deltaLine = JSON.stringify({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text: "Yo" } },
  session_id: "s", uuid: "u",
}) + "\n";
const resultLine = JSON.stringify({
  type: "result", subtype: "success", is_error: false, result: "Yo",
  session_id: "s", total_cost_usd: 0, duration_ms: 1, duration_api_ms: 1,
  num_turns: 1, usage: { input_tokens: 3, output_tokens: 1 }, modelUsage: {},
}) + "\n";

function fakeRes(): Response & { body: string; ended: boolean; headers: Record<string, string> } {
  const emitter = new EventEmitter();
  const res: any = Object.assign(emitter, {
    body: "", ended: false, headers: {} as Record<string, string>,
    writableEnded: false, writable: true, headersSent: false,
    setHeader(k: string, v: string) { this.headers[k] = v; },
    flushHeaders() { this.headersSent = true; },
    write(chunk: string) { this.body += chunk; return true; },
    end() { this.ended = true; this.writableEnded = true; this.emit("close"); },
    status() { return this; },
    json(obj: unknown) { this.body += JSON.stringify(obj); this.ended = true; return this; },
  });
  return res;
}

test("paperclip/* model streams SSE deltas through the real route handler", async () => {
  const fakeExecute: AdapterExecute = async (ctx) => {
    await ctx.onLog("stdout", deltaLine);
    await ctx.onLog("stdout", resultLine);
    return { exitCode: 0, signal: null, timedOut: false, sessionId: "s",
      usage: { inputTokens: 3, outputTokens: 1 } };
  };
  const orig = registry.createRunner;
  // @ts-expect-error override for test
  registry.createRunner = (model: string) =>
    model.startsWith("paperclip/")
      ? new PaperclipRunner(fakeExecute, { engine: "cli" })
      : orig(model);

  try {
    const req = { body: { model: "paperclip/claude_local", stream: true,
      messages: [{ role: "user", content: "hi" }] } } as unknown as Request;
    const res = fakeRes();
    await handleChatCompletions(req, res);
    assert.match(res.body, /"content":"Yo"/, "streamed delta present in SSE body");
    assert.match(res.body, /data: \[DONE\]/, "terminated with [DONE]");
  } finally {
    // @ts-expect-error restore
    registry.createRunner = orig;
  }
});
```

> NOTE for the implementer: for the monkeypatch to take effect, `routes.ts` must call `createRunner` **via the namespace import** (`import * as paperclipRegistry from "../adapter/paperclip-registry.js"` then `paperclipRegistry.createRunner(...)`), because reassigning a named binding on the imported module object is what the test overrides. Use the namespace form in Step 3.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build 2>/dev/null; node --test dist/server/routes.paperclip.test.js`
Expected: FAIL — currently `routes.ts` constructs `new ClaudeSubprocess()`, which would try to spawn `claude`; the assertion on `"content":"Yo"` fails (or build fails on the not-yet-added import).

- [ ] **Step 3: Wire the factory**

In `src/server/routes.ts`:

Replace the `ClaudeSubprocess` import (line 9):

```ts
import * as paperclipRegistry from "../adapter/paperclip-registry.js";
import type { AgentRunner } from "../adapter/paperclip-runner.js";
```

Replace the construction site (line 52) inside `handleChatCompletions`:

```ts
    // Convert to CLI input format
    const cliInput = openaiToCli(body);
    const subprocess = paperclipRegistry.createRunner(requestedModel);
```

Change the two handler signatures to accept the shared interface instead of the concrete class. In `handleStreamingResponse` (line 94) and `handleNonStreamingResponse` (line 278), change the parameter type:

```ts
  subprocess: AgentRunner,
```

(Everything else — every `subprocess.on(...)`, `subprocess.start(...)`, `subprocess.kill()` — is unchanged; both runners implement `AgentRunner`.)

- [ ] **Step 4: Run the new route test + the full suite**

Run: `npm run build && npm test`
Expected: the new `routes.paperclip.test.js` PASSES, and all pre-existing tests remain green.

- [ ] **Step 5: Commit**

```bash
git add src/server/routes.ts src/server/routes.paperclip.test.ts
git commit -m "feat: route paperclip/* models through PaperclipRunner"
```

---

### Task 5: Advertise `paperclip/*` in `/v1/models`

So OpenAI clients (and Collavre's model dropdown) can discover the Paperclip-backed models.

**Files:**
- Modify: `src/server/routes.ts` (`MODELS_DATA`, lines 393-415)
- Create: `src/server/models.paperclip.test.ts`

**Interfaces:**
- Consumes: `PAPERCLIP_MODEL_IDS` (Task 3).

- [ ] **Step 1: Write the failing test**

Create `src/server/models.paperclip.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { handleModels } from "./routes.js";

test("/v1/models includes paperclip/claude_local", () => {
  let payload: any;
  const res = { json: (obj: unknown) => { payload = obj; } } as unknown as Response;
  handleModels({} as Request, res);
  const ids: string[] = payload.data.map((m: { id: string }) => m.id);
  assert.ok(ids.includes("paperclip/claude_local"), "paperclip model advertised");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build 2>/dev/null; node --test dist/server/models.paperclip.test.js`
Expected: FAIL — `paperclip/claude_local` not in the advertised list.

- [ ] **Step 3: Add the paperclip ids to `MODELS_DATA`**

In `src/server/routes.ts`, add the import (with the Task 4 imports at the top):

```ts
import { PAPERCLIP_MODEL_IDS } from "../adapter/paperclip-registry.js";
```

Modify the `MODELS_DATA` IIFE (lines 393-415) so the `data` array also includes the paperclip ids. Replace the `return Object.freeze({...})` block with:

```ts
  return Object.freeze({
    object: "list" as const,
    data: [
      ...prefixes.flatMap((prefix) =>
        baseModels.map((id) => ({
          id: `${prefix}${id}`,
          object: "model" as const,
          owned_by: "anthropic",
          created: now,
        }))
      ),
      ...PAPERCLIP_MODEL_IDS.map((id) => ({
        id,
        object: "model" as const,
        owned_by: "paperclip",
        created: now,
      })),
    ],
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test dist/server/models.paperclip.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/routes.ts src/server/models.paperclip.test.ts
git commit -m "feat: advertise paperclip/* models in /v1/models"
```

---

### Task 6: Live end-to-end verification (manual) + docs

Prove the whole path against the real `claude` CLI, then document the Collavre wiring. This task has no unit test — it is a scripted manual verification with expected output, plus a docs edit.

**Files:**
- Modify: `README.md` (add a "Paperclip adapters" section)
- Create: `docs/paperclip-adapters.md`

- [ ] **Step 1: Build and start the proxy**

```bash
npm run build
PORT=3456 node dist/server/standalone.js &
sleep 1
curl -s http://localhost:3456/v1/models | grep -o 'paperclip/claude_local'
```
Expected: prints `paperclip/claude_local`.

- [ ] **Step 2: Non-streaming smoke against the real adapter**

```bash
curl -s http://localhost:3456/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"paperclip/claude_local","stream":false,
       "messages":[{"role":"user","content":"Respond with exactly: PAPERCLIP_OK"}]}' \
  | grep -o 'PAPERCLIP_OK'
```
Expected: prints `PAPERCLIP_OK` (round-trip through `claude-local` execute()). If it hangs >60s or errors, check `claude --version` on PATH and that `claude` is logged in (`claude` auth).

- [ ] **Step 3: Streaming smoke**

```bash
curl -sN http://localhost:3456/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"paperclip/claude_local","stream":true,
       "messages":[{"role":"user","content":"Count to 3."}]}' \
  | head -20
```
Expected: SSE lines beginning `data: {"id":"chatcmpl-...","object":"chat.completion.chunk"...}` with incremental `delta.content`, ending in `data: [DONE]`.

- [ ] **Step 4: Stop the proxy**

```bash
kill %1 2>/dev/null || pkill -f 'dist/server/standalone.js'
```

- [ ] **Step 5: Document the Collavre wiring (zero-code)**

Create `docs/paperclip-adapters.md`:

```markdown
# Paperclip adapters behind the OpenAI endpoint

Models named `paperclip/<adapterType>` route each request through a Paperclip
agent adapter's `execute()` (reusing the published `@paperclipai/adapter-*`
packages) instead of the built-in direct Claude spawn. Registered adapters:

| Model id                 | Paperclip package                   | Notes                    |
|--------------------------|-------------------------------------|--------------------------|
| `paperclip/claude_local` | `@paperclipai/adapter-claude-local` | Claude Code CLI, `engine: "cli"` |

Requirements: `claude` CLI on PATH and authenticated. Option 1 is **stateless**
(no session resume).

## Collavre integration (no Collavre code changes)

Configure an AI-agent User in Collavre:

- **Vendor:** `OpenAI`
- **Model:** `paperclip/claude_local`
- **Gateway/Base URL:** `http://<proxy-host>:3456/v1`
- **API key:** leave blank (a `local-gateway` placeholder is injected)

Collavre's `AiClient` sets `config.openai_api_base = gateway_url` and calls
`<gateway_url>/chat/completions` with `assume_model_exists: true`, so the
`paperclip/*` model id is accepted verbatim and streamed back into the
conversation via the existing `ResponseStreamer`.
```

Add to `README.md`, after the "How It Works" section, a short pointer:

```markdown
## Paperclip adapters

Beyond the built-in direct Claude path, this proxy can run requests through
[Paperclip](https://github.com/paperclipai/paperclip) agent adapters when the
model is named `paperclip/<adapterType>` (e.g. `paperclip/claude_local`). See
[docs/paperclip-adapters.md](docs/paperclip-adapters.md).
```

- [ ] **Step 6: Commit**

```bash
git add README.md docs/paperclip-adapters.md
git commit -m "docs: document paperclip/* adapter routing and Collavre wiring"
```

---

## Self-Review

**1. Spec coverage:**
- "Use Paperclip's individual npm packages as-is" → Task 2/3 import `@paperclipai/adapter-claude-local/server` (published) and call its `execute()` unmodified. ✅
- "OpenAI completion endpoint on the Node side with all CLI adapters under it" (Option 1) → Tasks 3-5: `paperclip/<adapterType>` model routing; the registry is the extension point for codex/gemini/etc. ✅
- "Reuse the existing proxy scaffolding" → Task 4: `routes.ts` SSE/keepalive/orphan-kill untouched except one factory line + parameter types. ✅
- "Zero Collavre code" → Task 6 docs the vendor=openai + gateway_url config (verified against `ai_client.rb:217-247`, `edit_ai.html.erb:51`). ✅
- Streaming granularity → Task 2 adds `--include-partial-messages` via `config.extraArgs` so `content_block_delta` events flow (claude-local omits it by default). ✅
- ACP-vs-CLI gotcha → `config.engine: "cli"` pinned in `PaperclipRunner` and asserted in its test. ✅
- Orphan-kill on disconnect → `PaperclipRunner.kill()` uses the pid/pgid captured from `ctx.onSpawn`. ✅

**2. Placeholder scan:** No TBD/TODO/"handle errors appropriately"; every code step contains complete code. ✅

**3. Type consistency:** `AgentRunner` (Task 2) is implemented by `PaperclipRunner` (Task 2) and `ClaudeSubprocess` (existing) and consumed by `createRunner` (Task 3) and `routes.ts` (Task 4). `AdapterExecute` defined in Task 2, used in Tasks 2/3. `PaperclipModelSpec.execute: AdapterExecute` matches. Event names (`content_delta`/`assistant`/`result`/`error`/`close`/`message`/`raw`) match what `routes.ts` and `subprocess/manager.ts` already use. `SubprocessOptions` reused verbatim from `manager.ts`. ✅

## Known risks / follow-ups (not blocking Option 1)

- **Published-vs-local drift:** the plan was grounded against the local Paperclip checkout (`claude-local@0.3.1`) but installs the published `2026.722.0`. Task 6 Step 2 is the real-adapter smoke that catches any contract drift; if `execute()`'s config keys differ, adjust `PaperclipRunner`'s `ctx.config`.
- **Non-Claude adapters** (codex/gemini) emit their own stdout formats; `StreamJsonParser` is Claude-`stream-json`-specific. Adding them means a per-adapter parser or mapping the adapter's `AdapterExecutionResult` — deferred until a second adapter is actually needed.
- **Session continuity** is intentionally absent (Option 1 = stateless). It is the entry point for Option 2 (Channel seam), the next plan.
