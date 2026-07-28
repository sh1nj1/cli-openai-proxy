/**
 * claude — "paste-code" flow, driven by `claude setup-token`.
 *
 * The CLI prints an OAuth URL, then blocks on stdin for the code the user gets
 * back from it. Because the URL and the code arrive in two separate HTTP
 * requests, the pty child is held alive between them; abandoning a session must
 * therefore kill that child (the session manager's reaper does).
 *
 * `setup-token` does NOT persist anything: it prints the token and tells the
 * user to export CLAUDE_CODE_OAUTH_TOKEN. So the token is returned as a
 * StoredCredential for the proxy to hold and inject into runs.
 *
 * The redirect target is Anthropic's hosted callback, not localhost — which is
 * what makes this flow work remotely: the user can complete it on any device.
 */

import { ptySpawner, type PtyProcess } from "../pty.js";
import { findVerificationUrl, stripAnsi } from "../terminal-scrape.js";
import {
  AuthProvisioningError,
  type AuthStartResult,
  type AuthSubmitResult,
  type EngineAuthSession,
} from "../types.js";

export const CLAUDE_OAUTH_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";

const OAUTH_TOKEN = /sk-ant-oat\d+-[A-Za-z0-9_-]+/;
const DEFAULT_URL_TIMEOUT_MS = 60_000;
const DEFAULT_SUBMIT_TIMEOUT_MS = 120_000;

/** Only an OAuth authorize URL is a verification URL; other links the CLI prints are not. */
const isAuthorizeUrl = (url: string): boolean => url.includes("/oauth/authorize");

export interface ClaudeSetupTokenOptions {
  spawn?: typeof ptySpawner.spawn;
  urlTimeoutMs?: number;
  submitTimeoutMs?: number;
}

export class ClaudeSetupTokenSession implements EngineAuthSession {
  private pty: PtyProcess | null = null;
  private buffer = "";
  private exited = false;
  private waiters: Array<() => void> = [];

  constructor(private readonly options: ClaudeSetupTokenOptions = {}) {}

  async start(): Promise<AuthStartResult> {
    if (this.pty) throw new AuthProvisioningError("Session already started", "session_already_started");

    const spawn = this.options.spawn ?? ptySpawner.spawn;
    // BROWSER=none: this flow authenticates a REMOTE user, so a browser opening on
    // the proxy host is never what was asked for — on a host with a logged-in
    // session it can even approve the request before the real user ever sees the
    // URL. Best-effort (the CLI may ignore it); the printed URL is the contract.
    this.pty = await spawn("claude", ["setup-token"], { env: { BROWSER: "none" } });
    this.pty.onData((data) => {
      this.buffer += data;
      this.wake();
    });
    this.pty.onExit(() => {
      this.exited = true;
      this.wake();
    });

    const url = await this.waitFor(
      () => findVerificationUrl(this.buffer, isAuthorizeUrl),
      this.options.urlTimeoutMs ?? DEFAULT_URL_TIMEOUT_MS,
      "Timed out waiting for the Claude authorization URL",
      "verification_url_timeout",
    );

    return {
      verificationUrl: url,
      instructions:
        "Open the URL, approve access, then submit the code shown on the callback page.",
    };
  }

  async submit(code: string): Promise<AuthSubmitResult> {
    if (!this.pty) throw new AuthProvisioningError("Session not started", "session_not_started");
    const trimmed = code.trim();
    if (!trimmed) throw new AuthProvisioningError("Authorization code is empty", "empty_code");
    if (this.exited) {
      throw new AuthProvisioningError(
        `Claude login exited before the code was submitted: ${this.tail()}`,
        "session_closed",
      );
    }

    // \r, not \n: the CLI reads from a terminal, where Enter is carriage return.
    this.pty.write(`${trimmed}\r`);

    const token = await this.waitFor(
      () => OAUTH_TOKEN.exec(stripAnsi(this.buffer))?.[0] ?? null,
      this.options.submitTimeoutMs ?? DEFAULT_SUBMIT_TIMEOUT_MS,
      "Timed out waiting for Claude to return a token",
      "token_timeout",
      // A rejected code makes the CLI exit without printing a token; surface that
      // immediately instead of stalling the caller until the timeout.
      () => this.exited,
      "Claude rejected the authorization code",
      "code_rejected",
    );

    this.cancel();
    return { credential: { envVar: CLAUDE_OAUTH_TOKEN_ENV, value: token } };
  }

  cancel(): void {
    const pty = this.pty;
    this.pty = null;
    // Drop captured output: it contains the OAuth token verbatim, and a cancelled
    // session has no further use for it.
    this.buffer = "";
    this.wake();
    pty?.kill();
  }

  /**
   * Resolve once `probe` yields a value, reject on timeout or (optionally) once
   * `abort` trips. Wakes on pty data/exit rather than polling.
   */
  private async waitFor<T>(
    probe: () => T | null,
    timeoutMs: number,
    timeoutMessage: string,
    timeoutCode: string,
    abort?: () => boolean,
    abortMessage?: string,
    abortCode?: string,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = probe();
      if (found != null) return found;
      // Checked after probe(): the CLI can print its result and exit in the same
      // tick, and that is a success, not an abort.
      if (abort?.()) {
        const detail = this.tail(); // captured before cancel() drops the buffer
        this.cancel();
        throw new AuthProvisioningError(`${abortMessage}: ${detail}`, abortCode ?? "aborted");
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        this.cancel();
        throw new AuthProvisioningError(timeoutMessage, timeoutCode);
      }
      await this.nextEvent(remaining);
    }
  }

  private nextEvent(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(finish, timeoutMs);
      const waiter = () => finish();
      this.waiters.push(waiter);
      function finish() {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  /** Last visible output, for error messages. Never includes a token: on the
   *  failure paths that call this, none was printed. */
  private tail(): string {
    return stripAnsi(this.buffer).trim().split("\n").slice(-3).join(" ").slice(-300);
  }
}
