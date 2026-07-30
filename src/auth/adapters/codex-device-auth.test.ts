import { test, describe } from "node:test";
import assert from "node:assert";
import { CodexDeviceAuthSession, type PipedProcess } from "./codex-device-auth.js";
import { AuthProvisioningError } from "../types.js";

/** Stands in for the `codex login --device-auth` child on plain pipes. */
class FakeProc implements PipedProcess {
  killed = false;
  private dataListeners: Array<(data: string) => void> = [];
  private exitListeners: Array<(event: { exitCode: number | null }) => void> = [];

  onData(listener: (data: string) => void) { this.dataListeners.push(listener); }
  onExit(listener: (event: { exitCode: number | null }) => void) { this.exitListeners.push(listener); }
  kill() { this.killed = true; }

  emit(data: string) { for (const l of this.dataListeners) l(data); }
  exit(exitCode: number | null) { for (const l of this.exitListeners) l({ exitCode }); }
}

/** Verbatim shape of codex 0.145.0 output, colors included, streamed over pipes. */
const DEVICE_PROMPT =
  "Welcome to Codex [v\x1b[90m0.145.0\x1b[0m]\n" +
  "\x1b[90mOpenAI's command-line coding agent\x1b[0m\n\n" +
  "Follow these steps to sign in with ChatGPT using device code authorization:\n\n" +
  "1. Open this link in your browser and sign in to your account\n" +
  "   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n" +
  "2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n" +
  "   \x1b[94mYQVF-8EBLA\x1b[0m\n";

function startSession(options: { urlTimeoutMs?: number } = {}) {
  const proc = new FakeProc();
  const session = new CodexDeviceAuthSession({ spawn: () => proc, ...options });
  return { proc, session };
}

const codeOf = (err: unknown): string => (err as AuthProvisioningError).code;

describe("codex device-auth adapter", () => {
  test("start scrapes the verification URL and one-time code from colored output", async () => {
    const { proc, session } = startSession();
    const started = session.start();
    proc.emit(DEVICE_PROMPT);

    const result = await started;
    assert.strictEqual(result.verificationUrl, "https://auth.openai.com/codex/device");
    assert.strictEqual(result.userCode, "YQVF-8EBLA");
    // The instructions must carry the code: they are what a minimal UI renders.
    assert.match(result.instructions, /YQVF-8EBLA/);
  });

  // The URL and code arrive in separate writes on a real pipe; returning on the
  // URL alone would show the user a page asking for a code we do not have yet.
  test("start waits until both the URL and the code have been printed", async () => {
    const { proc, session } = startSession();
    const started = session.start();
    const split = DEVICE_PROMPT.indexOf("2. Enter");
    proc.emit(DEVICE_PROMPT.slice(0, split));
    await new Promise((r) => setImmediate(r));
    proc.emit(DEVICE_PROMPT.slice(split));

    assert.strictEqual((await started).userCode, "YQVF-8EBLA");
  });

  test("a CLI that exits before printing a code fails the start with its output", async () => {
    const { proc, session } = startSession();
    const started = session.start();
    proc.emit("error: device auth is not enabled for this account\n");
    proc.exit(1);

    await assert.rejects(started, (err) => {
      assert.strictEqual(codeOf(err), "login_failed");
      assert.match((err as Error).message, /device auth is not enabled/);
      return true;
    });
  });

  test("a start that never sees a code times out and kills the child", async () => {
    const { proc, session } = startSession({ urlTimeoutMs: 30 });
    await assert.rejects(session.start(), (err) => {
      assert.strictEqual(codeOf(err), "verification_url_timeout");
      return true;
    });
    assert.strictEqual(proc.killed, true);
  });

  test("cancelling a pending start rejects it and kills the child", async () => {
    const { proc, session } = startSession();
    const started = session.start();
    session.cancel();

    await assert.rejects(started, (err) => {
      assert.strictEqual(codeOf(err), "session_cancelled");
      return true;
    });
    assert.strictEqual(proc.killed, true);
  });

  test("a session cannot be started twice", async () => {
    const { proc, session } = startSession();
    const started = session.start();
    await assert.rejects(session.start(), (err) => {
      assert.strictEqual(codeOf(err), "session_already_started");
      return true;
    });
    proc.emit(DEVICE_PROMPT);
    await started;
  });

  // There is nothing to submit: the user carries the code TO the browser.
  test("submit is refused", async () => {
    const { session } = startSession();
    await assert.rejects(session.submit(), (err) => {
      assert.strictEqual(codeOf(err), "submission_not_supported");
      return true;
    });
  });

  test("wait resolves once the CLI exits cleanly", async () => {
    const { proc, session } = startSession();
    const started = session.start();
    proc.emit(DEVICE_PROMPT);
    await started;

    const waited = session.wait();
    proc.exit(0);
    // The CLI persisted the credential itself; nothing comes back to hold.
    assert.deepStrictEqual(await waited, {});
  });

  test("wait fails with the CLI's last words when the login is denied", async () => {
    const { proc, session } = startSession();
    const started = session.start();
    proc.emit(DEVICE_PROMPT);
    await started;

    const waited = session.wait();
    proc.emit("Login failed: the device code was denied\n");
    proc.exit(1);

    await assert.rejects(waited, (err) => {
      assert.strictEqual(codeOf(err), "login_failed");
      assert.match((err as Error).message, /denied/);
      return true;
    });
  });

  // An abandoned device login keeps polling OpenAI and would install a
  // credential nobody is waiting for; cancel must reach the process.
  test("cancelling after start kills the polling child and fails wait", async () => {
    const { proc, session } = startSession();
    const started = session.start();
    proc.emit(DEVICE_PROMPT);
    await started;

    const waited = session.wait();
    session.cancel();

    await assert.rejects(waited, (err) => {
      assert.strictEqual(codeOf(err), "session_cancelled");
      return true;
    });
    assert.strictEqual(proc.killed, true);
  });
});
