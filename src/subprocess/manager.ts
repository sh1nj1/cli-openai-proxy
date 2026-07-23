/**
 * Claude Code CLI Subprocess Manager
 *
 * Handles spawning, managing, and parsing output from Claude CLI subprocesses.
 * Uses spawn() instead of exec() to prevent shell injection vulnerabilities.
 */

import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import type {
  ClaudeCliMessage,
  ClaudeCliAssistant,
  ClaudeCliResult,
} from "../types/claude-cli.js";
import type { ClaudeModel } from "../adapter/openai-to-cli.js";
import { StreamJsonParser, type StreamJsonSink } from "../adapter/stream-json-parser.js";
import { DEFAULT_TIMEOUT_MS, getBgWaitCeilingMs } from "../config.js";

export interface SubprocessOptions {
  // ClaudeModel literals keep autocomplete for the direct Claude path; the
  // `string & {}` arm admits arbitrary model ids (e.g. codex) that flow through
  // PaperclipRunner to a non-Claude adapter.
  model: ClaudeModel | (string & {});
  sessionId?: string;
  systemPrompt?: string;
  cwd?: string;
  timeout?: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidSessionId(sessionId: string): boolean {
  return UUID_RE.test(sessionId);
}

function redactSessionId(sessionId: string): string {
  if (sessionId.length <= 8) return "***";
  return `${sessionId.slice(0, 4)}…${sessionId.slice(-4)}`;
}

export interface SubprocessEvents {
  message: (msg: ClaudeCliMessage) => void;
  assistant: (msg: ClaudeCliAssistant) => void;
  result: (result: ClaudeCliResult) => void;
  error: (error: Error) => void;
  close: (code: number | null) => void;
  raw: (line: string) => void;
}

export class ClaudeSubprocess extends EventEmitter {
  private process: ChildProcess | null = null;
  private timeoutId: NodeJS.Timeout | null = null;
  private isKilled: boolean = false;
  private parser: StreamJsonParser | null = null;

  /**
   * Start the Claude CLI subprocess with the given prompt
   */
  async start(prompt: string, options: SubprocessOptions): Promise<void> {
    const args = this.buildArgs(options);
    // ?? (not ||) so a caller-supplied 0 means "no timeout" rather than falling back.
    const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
      try {
        // Use spawn() for security - no shell interpretation
        this.process = spawn("claude", args, {
          cwd: options.cwd || process.cwd(),
          env: {
            ...process.env,
            // Keep `claude -p` alive until background subagents finish instead of
            // exiting at the CLI's 10-minute default cap (see config.ts).
            CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: String(getBgWaitCeilingMs()),
          },
          stdio: ["pipe", "pipe", "pipe"],
        });

        // Set timeout only when bounded; 0 = run until the subprocess exits itself.
        if (timeout > 0) {
          this.timeoutId = setTimeout(() => {
            if (!this.isKilled) {
              this.isKilled = true;
              this.process?.kill("SIGTERM");
              this.emit("error", new Error(`Request timed out after ${timeout}ms`));
            }
          }, timeout);
        }

        // Handle spawn errors (e.g., claude not found)
        this.process.on("error", (err) => {
          this.clearTimeout();
          if (err.message.includes("ENOENT")) {
            reject(
              new Error(
                "Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code"
              )
            );
          } else {
            reject(err);
          }
        });

        // Pass prompt via stdin to avoid E2BIG on large prompts (fixes #12)
        this.process.stdin?.write(prompt);
        this.process.stdin?.end();

        console.error(`[Subprocess] Process spawned with PID: ${this.process.pid}`);

        // Parse JSON stream from stdout
        this.process.stdout?.on("data", (chunk: Buffer) => {
          this.processChunk(chunk.toString());
        });

        // Capture stderr for debugging
        this.process.stderr?.on("data", (chunk: Buffer) => {
          const errorText = chunk.toString().trim();
          if (errorText) {
            console.error("[Subprocess stderr]:", errorText);
          }
        });

        // Handle process close
        this.process.on("close", (code) => {
          if (code !== 0) {
            console.error(`[Subprocess] Process exited with error code: ${code}`);
          } else {
            console.error(`[Subprocess] Process closed with code: ${code}`);
          }
          this.clearTimeout();
          // Flush any buffered partial line. Intentional behavior change: a
          // final stream-json line with no trailing newline (possible on
          // subprocess kill/timeout/disconnect) is now parsed and emitted,
          // whereas the pre-refactor split/pop buffering silently dropped it.
          this.parser?.flush();
          this.emit("close", code);
        });

        // Resolve immediately since we're streaming
        resolve();
      } catch (err) {
        this.clearTimeout();
        reject(err);
      }
    });
  }

  /**
   * Build CLI arguments array.
   * Prompt is passed via stdin (not as argument) to avoid E2BIG on large prompts.
   */
  private buildArgs(options: SubprocessOptions): string[] {
    const args = [
      "--print", // Non-interactive mode
      "--output-format",
      "stream-json", // JSON streaming output
      "--verbose", // Required for stream-json
      "--include-partial-messages", // Enable streaming chunks
      "--model",
      options.model, // Model alias (opus/sonnet/haiku)
      "--no-session-persistence",
      "--dangerously-skip-permissions", // Don't save sessions
    ];

    if (options.systemPrompt) {
      args.push("--append-system-prompt", options.systemPrompt);
    }

    if (options.sessionId) {
      if (isValidSessionId(options.sessionId)) {
        args.push("--session-id", options.sessionId);
      } else {
        console.error(
          `[Subprocess] Ignoring invalid sessionId (expected UUID): ${redactSessionId(options.sessionId)}`
        );
      }
    }

    return args;
  }

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

  /**
   * Clear the timeout timer
   */
  private clearTimeout(): void {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  /**
   * Kill the subprocess
   */
  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    if (!this.isKilled && this.process) {
      this.isKilled = true;
      this.clearTimeout();
      this.process.kill(signal);
    }
  }

  /**
   * Check if the process is still running
   */
  isRunning(): boolean {
    return this.process !== null && !this.isKilled && this.process.exitCode === null;
  }
}

/**
 * Verify that Claude CLI is installed and accessible
 */
export async function verifyClaude(): Promise<{ ok: boolean; error?: string; version?: string }> {
  return new Promise((resolve) => {
    const proc = spawn("claude", ["--version"], { stdio: "pipe" });
    let output = "";

    proc.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    proc.on("error", () => {
      resolve({
        ok: false,
        error:
          "Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code",
      });
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true, version: output.trim() });
      } else {
        resolve({
          ok: false,
          error: "Claude CLI returned non-zero exit code",
        });
      }
    });
  });
}

/**
 * Check if Claude CLI is authenticated
 *
 * Claude Code stores credentials in the OS keychain, not a file.
 * We verify authentication by checking if we can call the CLI successfully.
 * If the CLI is installed, it typically has valid credentials from `claude auth login`.
 */
export async function verifyAuth(): Promise<{ ok: boolean; error?: string }> {
  // If Claude CLI is installed and the user has run `claude auth login`,
  // credentials are stored in the OS keychain and will be used automatically.
  // We can't easily check the keychain, so we'll just return true if the CLI exists.
  // Authentication errors will surface when making actual API calls.
  return { ok: true };
}
