/**
 * codex — "device-code" flow, driven by `codex login --device-auth`.
 *
 * The CLI prints a verification URL and a one-time code, then polls OpenAI
 * until the user enters the code at that URL. The direction is the reverse of
 * paste-code: the user carries the code FROM the CLI TO the browser, so nothing
 * is ever submitted back through this API — the session completes on its own,
 * which is what wait() exposes to the session manager.
 *
 * This is the flow that provisions a ChatGPT *subscription* login remotely.
 * Plain `codex login` cannot: its OAuth redirect targets localhost on the proxy
 * host, unreachable from the user's browser. Device auth has no redirect.
 *
 * Like the api-key flow, the CLI persists the credential under ~/.codex itself,
 * so nothing comes back for the proxy to hold. Unlike `claude setup-token`, the
 * CLI renders this flow fine on plain pipes — no pty needed.
 */

import { spawn } from "child_process";
import { findVerificationUrl, stripAnsi } from "../terminal-scrape.js";
import {
  AuthProvisioningError,
  type AuthStartResult,
  type AuthSubmitResult,
  type EngineAuthSession,
} from "../types.js";

const DEFAULT_URL_TIMEOUT_MS = 60_000;
/** SIGTERM only asks; escalate so an uncooperative CLI cannot outlive its session. */
const KILL_GRACE_MS = 2_000;

/**
 * The one-time code as codex prints it (e.g. "YQVF-8EBLA"). Bounded segments so
 * an unrelated ALL-CAPS token in some future banner cannot be mistaken for it.
 */
const USER_CODE = /\b[A-Z0-9]{4,10}-[A-Z0-9]{4,10}\b/;

/** Only OpenAI's device-authorization page is the URL to hand the user. */
const isDeviceUrl = (url: string): boolean => url.includes("auth.openai.com");

/** Minimal child surface, shaped like PtyProcess so tests fake it the same way. */
export interface PipedProcess {
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number | null }) => void): void;
  kill(): void;
}

export type PipedSpawnFn = (file: string, args: string[]) => PipedProcess;

/**
 * Spawn on plain pipes in its own POSIX process group, so killing the session
 * reaches any descendant holding the pipes open (same reasoning as the api-key
 * runner). stdout and stderr are merged: the scraper only cares what was
 * printed, not where, and codex has moved output between the two across versions.
 */
const spawnPiped: PipedSpawnFn = (file, args) => {
  const useProcessGroup = process.platform !== "win32";
  const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"], detached: useProcessGroup });

  const signalChild = (name: NodeJS.Signals) => {
    if (useProcessGroup && child.pid != null) {
      try {
        process.kill(-child.pid, name);
        return;
      } catch {
        // The child may have exited before its process group was established.
      }
    }
    child.kill(name);
  };

  let hardKill: NodeJS.Timeout | undefined;
  child.on("close", () => {
    if (hardKill) clearTimeout(hardKill);
  });

  return {
    onData: (listener) => {
      child.stdout.on("data", (c) => listener(c.toString()));
      child.stderr.on("data", (c) => listener(c.toString()));
    },
    onExit: (listener) => {
      child.on("close", (code) => listener({ exitCode: code }));
      // A spawn failure (ENOENT) emits `error`, possibly without `close`.
      child.on("error", () => listener({ exitCode: null }));
    },
    kill: () => {
      signalChild("SIGTERM");
      hardKill ??= setTimeout(() => signalChild("SIGKILL"), KILL_GRACE_MS);
      hardKill.unref?.();
    },
  };
};

export interface CodexDeviceAuthOptions {
  spawn?: PipedSpawnFn;
  urlTimeoutMs?: number;
}

export class CodexDeviceAuthSession implements EngineAuthSession {
  private proc: PipedProcess | null = null;
  /** Separate from `proc`, which cancel() nulls: a cancelled session was still started. */
  private started = false;
  private buffer = "";
  private exited = false;
  private exitCode: number | null = null;
  private cancelled = false;
  private waiters: Array<() => void> = [];

  constructor(private readonly options: CodexDeviceAuthOptions = {}) {}

  async start(): Promise<AuthStartResult> {
    if (this.started) throw new AuthProvisioningError("Session already started", "session_already_started");
    this.started = true;

    const spawnFn = this.options.spawn ?? spawnPiped;
    this.proc = spawnFn("codex", ["login", "--device-auth"]);
    this.proc.onData((data) => {
      this.buffer += data;
      this.wake();
    });
    this.proc.onExit(({ exitCode }) => {
      // A terminal device-code session remains queryable until its TTL. Drop the
      // handle now so later disposal cannot signal a reused POSIX process-group ID.
      this.proc = null;
      this.exited = true;
      this.exitCode = exitCode;
      this.wake();
    });

    const found = await this.waitFor(
      () => this.scrape(),
      this.options.urlTimeoutMs ?? DEFAULT_URL_TIMEOUT_MS,
    );

    return {
      verificationUrl: found.url,
      userCode: found.code,
      instructions:
        `Open the URL, sign in to ChatGPT, and enter the one-time code ${found.code}. ` +
        "The login completes on its own — poll this session for the result.",
    };
  }

  /** Both must be present: returning the URL alone would show a page asking for a code we have not scraped yet. */
  private scrape(): { url: string; code: string } | null {
    const url = findVerificationUrl(this.buffer, isDeviceUrl);
    const code = USER_CODE.exec(stripAnsi(this.buffer))?.[0];
    return url && code ? { url, code } : null;
  }

  async submit(): Promise<AuthSubmitResult> {
    throw new AuthProvisioningError(
      "The device-code flow takes no submission: enter the code at the verification URL, then poll the session.",
      "submission_not_supported",
    );
  }

  /** Resolves/rejects when `codex login` reaches its own verdict (see EngineAuthSession.wait). */
  async wait(): Promise<AuthSubmitResult> {
    if (!this.started) throw new AuthProvisioningError("Session not started", "session_not_started");
    while (!this.exited && !this.cancelled) await this.nextEvent();
    if (this.cancelled) {
      throw new AuthProvisioningError("Login was cancelled", "session_cancelled");
    }
    if (this.exitCode !== 0) {
      throw new AuthProvisioningError(
        `codex login failed: ${this.tail() || `exit ${this.exitCode}`}`,
        "login_failed",
      );
    }
    // The CLI persisted the credential to ~/.codex itself; nothing to hold.
    return {};
  }

  cancel(): void {
    const proc = this.proc;
    this.proc = null;
    this.cancelled = true;
    this.wake();
    proc?.kill();
  }

  private async waitFor<T>(probe: () => T | null, timeoutMs: number): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = probe();
      if (found != null) return found;
      // Checked after probe(): printing the URL and exiting in one tick is not a failure.
      if (this.cancelled) {
        throw new AuthProvisioningError("Login was cancelled", "session_cancelled");
      }
      if (this.exited) {
        const detail = this.tail();
        this.cancel();
        throw new AuthProvisioningError(
          detail
            ? `codex login exited before printing a device code: ${detail}`
            : "codex login exited before printing a device code",
          "login_failed",
        );
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        this.cancel();
        throw new AuthProvisioningError(
          "Timed out waiting for codex to print its device code",
          "verification_url_timeout",
        );
      }
      await this.nextEvent(remaining);
    }
  }

  private nextEvent(timeoutMs?: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = timeoutMs != null ? setTimeout(finish, timeoutMs) : undefined;
      this.waiters.push(finish);
      function finish() {
        if (timer) clearTimeout(timer);
        resolve();
      }
    });
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  /** Last visible output, for error messages. The device code is not a secret
   *  (it is useless without the user's own ChatGPT login), so no redaction. */
  private tail(): string {
    return stripAnsi(this.buffer).trim().split("\n").slice(-3).join(" ").trim().slice(-300);
  }
}
