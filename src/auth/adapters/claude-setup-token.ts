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
// A failed code exchange leaves the CLI alive at a "Press Enter to retry" prompt,
// so the error line in the output is the only rejection signal there is.
const OAUTH_ERROR = /OAuth error/i;
const DEFAULT_URL_TIMEOUT_MS = 60_000;
const DEFAULT_SUBMIT_TIMEOUT_MS = 120_000;
// The CLI treats a multi-character chunk as a paste: a \r inside the chunk is
// swallowed as pasted text, not dispatched as Enter (verified against v2.1.220,
// which sat at the prompt indefinitely on `write(code + "\r")`). Enter must
// arrive as its own input event, after the paste has settled.
const DEFAULT_ENTER_DELAY_MS = 500;

/** Only an OAuth authorize URL is a verification URL; other links the CLI prints are not. */
const isAuthorizeUrl = (url: string): boolean => url.includes("/oauth/authorize");

/** Why a wait was given up on, carried into the AuthProvisioningError. */
interface AbortReason {
  message: string;
  code: string;
}

export interface ClaudeSetupTokenOptions {
  spawn?: typeof ptySpawner.spawn;
  urlTimeoutMs?: number;
  submitTimeoutMs?: number;
  enterDelayMs?: number;
}

export class ClaudeSetupTokenSession implements EngineAuthSession {
  private pty: PtyProcess | null = null;
  private buffer = "";
  private exited = false;
  private cancelled = false;
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
      // Without an abort the waiter would sit out the full URL timeout after its
      // child is gone: cancel() only wakes it, and a woken waiter with an empty
      // buffer just waits again. A superseded start must fail now, not in a minute.
      () =>
        this.abortReason("Claude login exited before printing an authorization URL", "session_closed"),
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

    this.pty.write(trimmed);
    await new Promise((resolve) =>
      setTimeout(resolve, this.options.enterDelayMs ?? DEFAULT_ENTER_DELAY_MS),
    );
    // \r, not \n: the CLI reads from a terminal, where Enter is carriage return.
    // Skipped if the session was cancelled (pty nulled) or the CLI died meanwhile;
    // the waitFor below reports what actually happened.
    if (this.pty && !this.exited) this.pty.write("\r");

    const token = await this.waitFor(
      () => OAUTH_TOKEN.exec(stripAnsi(this.buffer))?.[0] ?? null,
      this.options.submitTimeoutMs ?? DEFAULT_SUBMIT_TIMEOUT_MS,
      "Timed out waiting for Claude to return a token",
      "token_timeout",
      () => {
        // A rejected exchange does not exit the CLI — it re-prompts ("Press Enter
        // to retry"), so the printed error is the only signal to fail fast on.
        if (OAUTH_ERROR.test(stripAnsi(this.buffer))) {
          return { message: "Claude rejected the authorization code", code: "code_rejected" };
        }
        return this.abortReason("Claude rejected the authorization code", "code_rejected");
      },
    );

    this.cancel();
    return { credential: { envVar: CLAUDE_OAUTH_TOKEN_ENV, value: token } };
  }

  cancel(): void {
    const pty = this.pty;
    this.pty = null;
    this.cancelled = true;
    // Drop captured output: it contains the OAuth token verbatim, and a cancelled
    // session has no further use for it.
    this.buffer = "";
    this.wake();
    pty?.kill();
  }

  /**
   * Why the current wait can no longer succeed, or null to keep waiting.
   * Cancellation is checked first: killing the child also makes it exit, and
   * "cancelled" is the more truthful reason of the two.
   */
  private abortReason(exitMessage: string, exitCode: string): AbortReason | null {
    if (this.cancelled) {
      return { message: "Claude login was cancelled", code: "session_cancelled" };
    }
    if (this.exited) return { message: exitMessage, code: exitCode };
    return null;
  }

  /**
   * Resolve once `probe` yields a value, reject on timeout or (optionally) once
   * `abort` names a reason. Wakes on pty data/exit rather than polling.
   */
  private async waitFor<T>(
    probe: () => T | null,
    timeoutMs: number,
    timeoutMessage: string,
    timeoutCode: string,
    abort?: () => AbortReason | null,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = probe();
      if (found != null) return found;
      // Checked after probe(): the CLI can print its result and exit in the same
      // tick, and that is a success, not an abort.
      const reason = abort?.();
      if (reason) {
        const detail = this.tail(); // captured before cancel() drops the buffer
        this.cancel();
        throw new AuthProvisioningError(
          detail ? `${reason.message}: ${detail}` : reason.message,
          reason.code,
        );
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
