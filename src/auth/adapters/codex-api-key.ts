/**
 * codex — "api-key" flow, driven by `codex login --with-api-key`.
 *
 * The CLI reads the key from stdin (never argv, so it stays out of the process
 * table) and persists its own credentials under ~/.codex. Nothing comes back for
 * us to hold, so this flow returns no StoredCredential and holds no child
 * BETWEEN requests — start() only describes what to submit.
 *
 * It does hold one DURING submit(), and that child is what cancel() must reach:
 * `codex login` writes the host credential itself, so a superseded submit left
 * running would overwrite whatever the newer session installed, and then report
 * itself authorized.
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
  signal?: AbortSignal,
) => Promise<CommandResult>;

/**
 * Run a CLI, optionally feeding stdin, capturing both streams.
 *
 * `signal` kills the child: an abandoned `codex login` keeps writing to ~/.codex,
 * so cancelling the session has to reach the process, not just stop awaiting it.
 */
export const runCommand: RunCommandFn = (file, args, stdin, timeoutMs, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AuthProvisioningError("Login was cancelled", "session_cancelled"));
      return;
    }
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    const onAbort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", onAbort, { once: true });
    const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); };

    child.stdout.on("data", (c) => { stdout += c.toString(); });
    child.stderr.on("data", (c) => { stderr += c.toString(); });
    child.on("error", (err) => { done(); reject(err); });
    child.on("close", (code) => {
      done();
      // A killed child's exit code says nothing useful about the credential, and
      // reporting it as a login failure would hide the reason the caller needs.
      if (signal?.aborted) {
        reject(new AuthProvisioningError("Login was cancelled", "session_cancelled"));
        return;
      }
      resolve({ exitCode: code, stdout, stderr });
    });

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
  /** Armed for the whole session so a cancel that lands before submit still wins. */
  private readonly aborter = new AbortController();

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
      result = await run(
        "codex",
        ["login", "--with-api-key"],
        key,
        this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        this.aborter.signal,
      );
    } catch (err) {
      // A cancellation already says exactly what happened; re-labelling it
      // "cli_unavailable" would blame the host for a race the caller lost.
      if (err instanceof AuthProvisioningError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new AuthProvisioningError(
        message.includes("ENOENT") ? "codex CLI not found on this host" : message,
        "cli_unavailable",
      );
    }

    // A runner that ignores the signal (or a race with the child's own exit) can
    // still return a result after cancellation. Refusing it here is what keeps a
    // superseded submit from reporting "authorized".
    if (this.aborter.signal.aborted) {
      throw new AuthProvisioningError("Login was cancelled", "session_cancelled");
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
    // Kills an in-flight `codex login`. Cancelling after it has already exited is
    // a no-op on the process, but still latches so a late result is not accepted.
    this.aborter.abort();
  }
}

/** Never echo more than the CLI's own first error line — its output can quote the key. */
function firstLine(text: string): string {
  return text.trim().split("\n")[0]?.trim() ?? "";
}
