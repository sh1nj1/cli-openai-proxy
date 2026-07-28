/**
 * codex — "api-key" flow, driven by `codex login --with-api-key`.
 *
 * The CLI reads the key from stdin (never argv, so it stays out of the process
 * table) and persists its own credentials under ~/.codex. Nothing comes back for
 * us to hold, so this flow returns no StoredCredential and needs no live child
 * between requests — start() only describes what to submit.
 */

import { spawn } from "child_process";
import {
  AuthProvisioningError,
  type AuthStartResult,
  type AuthSubmitResult,
  type EngineAuthSession,
} from "../types.js";

const DEFAULT_TIMEOUT_MS = 60_000;

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export type RunCommandFn = (
  file: string,
  args: string[],
  stdin: string | null,
  timeoutMs: number,
) => Promise<CommandResult>;

/** Run a CLI, optionally feeding stdin, capturing both streams. */
export const runCommand: RunCommandFn = (file, args, stdin, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);

    child.stdout.on("data", (c) => { stdout += c.toString(); });
    child.stderr.on("data", (c) => { stderr += c.toString(); });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ exitCode: code, stdout, stderr }); });

    if (stdin != null) child.stdin.end(stdin);
    else child.stdin.end();
  });

/** Mutable holder so tests can substitute the runner (see pty.ts for the rationale). */
export const commandRunner: { run: RunCommandFn } = { run: runCommand };

export interface CodexApiKeyOptions {
  run?: RunCommandFn;
  timeoutMs?: number;
}

export class CodexApiKeySession implements EngineAuthSession {
  constructor(private readonly options: CodexApiKeyOptions = {}) {}

  async start(): Promise<AuthStartResult> {
    return {
      instructions:
        "Submit an OpenAI API key. It is passed to `codex login --with-api-key` over stdin and stored by the codex CLI.",
    };
  }

  async submit(apiKey: string): Promise<AuthSubmitResult> {
    const key = apiKey.trim();
    if (!key) throw new AuthProvisioningError("API key is empty", "empty_api_key");

    const run = this.options.run ?? commandRunner.run;
    let result: CommandResult;
    try {
      result = await run("codex", ["login", "--with-api-key"], key, this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new AuthProvisioningError(
        message.includes("ENOENT") ? "codex CLI not found on this host" : message,
        "cli_unavailable",
      );
    }

    if (result.exitCode !== 0) {
      throw new AuthProvisioningError(
        `codex login failed: ${firstLine(result.stderr) || firstLine(result.stdout) || `exit ${result.exitCode}`}`,
        "login_failed",
      );
    }
    return {};
  }

  cancel(): void {
    // Nothing to cancel: no child is held between requests in this flow.
  }
}

/** Never echo more than the CLI's own first error line — its output can quote the key. */
function firstLine(text: string): string {
  return text.trim().split("\n")[0]?.trim() ?? "";
}
