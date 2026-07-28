import { test, describe } from "node:test";
import assert from "node:assert";
import { ClaudeSetupTokenSession } from "./claude-setup-token.js";
import type { PtyProcess } from "../pty.js";
import { AuthProvisioningError } from "../types.js";

const AUTHORIZE = "https://claude.com/oauth/authorize?client_id=abc&state=xyz";
const osc8 = (url: string, label: string) => `\x1b]8;id=1;${url}\x1b\\${label}\x1b]8;;\x1b\\`;

/** Stand-in for the pty-hosted `claude setup-token` child. */
class FakePty implements PtyProcess {
  written: string[] = [];
  killed = false;
  private dataListeners: Array<(d: string) => void> = [];
  private exitListeners: Array<(e: { exitCode: number }) => void> = [];
  /** Called with whatever was written, so a test can script the CLI's reply. */
  onWrite: ((data: string, pty: FakePty) => void) | null = null;

  onData(l: (d: string) => void): void { this.dataListeners.push(l); }
  onExit(l: (e: { exitCode: number }) => void): void { this.exitListeners.push(l); }
  write(data: string): void { this.written.push(data); this.onWrite?.(data, this); }
  kill(): void { this.killed = true; }

  emit(data: string): void { for (const l of this.dataListeners) l(data); }
  exit(exitCode = 0): void { for (const l of this.exitListeners) l({ exitCode }); }
}

interface SpawnCall { file: string; args: string[]; env?: Record<string, string> }
const spawnCalls: SpawnCall[] = [];

function sessionWith(pty: FakePty, overrides: { urlTimeoutMs?: number; submitTimeoutMs?: number } = {}) {
  return new ClaudeSetupTokenSession({
    spawn: async (file, args, options) => {
      spawnCalls.push({ file, args, env: options?.env });
      return pty;
    },
    urlTimeoutMs: 200,
    submitTimeoutMs: 200,
    ...overrides,
  });
}

describe("ClaudeSetupTokenSession", () => {
  // This flow authenticates a remote user; a browser opening on the proxy host
  // could approve the request before that user ever sees the URL.
  test("start asks the CLI not to open a browser on the proxy host", async () => {
    spawnCalls.length = 0;
    const pty = new FakePty();
    const session = sessionWith(pty);
    const started = session.start();
    setTimeout(() => pty.emit(osc8(AUTHORIZE, "auth")), 5);
    await started;

    assert.deepStrictEqual(spawnCalls[0].args, ["setup-token"]);
    assert.strictEqual(spawnCalls[0].env?.BROWSER, "none");
    session.cancel();
  });

  test("start resolves with the authorize URL once the CLI prints it", async () => {
    const pty = new FakePty();
    const session = sessionWith(pty);
    const started = session.start();
    // Wrapped display text, intact hyperlink target — what a real pty produces.
    setTimeout(() => pty.emit(`Browser didn't open?\n${osc8(AUTHORIZE, "https://claude.com/oauth/\r\nauthorize?...")}\n`), 5);

    const result = await started;
    assert.strictEqual(result.verificationUrl, AUTHORIZE);
    assert.match(result.instructions, /code/i);
    session.cancel();
  });

  test("start ignores non-authorize links printed before the real URL", async () => {
    const pty = new FakePty();
    const session = sessionWith(pty);
    const started = session.start();
    setTimeout(() => pty.emit(osc8("https://docs.claude.com/troubleshooting", "docs")), 5);
    setTimeout(() => pty.emit(osc8(AUTHORIZE, "auth")), 15);

    assert.strictEqual((await started).verificationUrl, AUTHORIZE);
    session.cancel();
  });

  test("start times out (and kills the child) when no URL is ever printed", async () => {
    const pty = new FakePty();
    const session = sessionWith(pty, { urlTimeoutMs: 50 });
    await assert.rejects(session.start(), (err: AuthProvisioningError) => {
      assert.strictEqual(err.code, "verification_url_timeout");
      return true;
    });
    assert.strictEqual(pty.killed, true, "an abandoned pty child must not be left running");
  });

  // cancel() only wakes the waiter; with an empty buffer it would find no URL and
  // wait again, so the caller that lost the race sat out the whole URL timeout.
  test("cancelling a pending start fails it at once rather than at the URL timeout", async () => {
    const pty = new FakePty();
    const session = sessionWith(pty, { urlTimeoutMs: 5_000 });
    const started = session.start();
    const begin = Date.now();
    setTimeout(() => session.cancel(), 5);

    await assert.rejects(started, (err: AuthProvisioningError) => {
      assert.strictEqual(err.code, "session_cancelled");
      return true;
    });
    assert.ok(Date.now() - begin < 1_000, "must not wait out the 5s URL timeout");
    assert.strictEqual(pty.killed, true);
  });

  // Same stall, different cause: a CLI that dies before printing anything.
  test("start fails as soon as the CLI exits without an authorization URL", async () => {
    const pty = new FakePty();
    const session = sessionWith(pty, { urlTimeoutMs: 5_000 });
    const started = session.start();
    const begin = Date.now();
    setTimeout(() => { pty.emit("not logged in\r\n"); pty.exit(1); }, 5);

    await assert.rejects(started, (err: AuthProvisioningError) => {
      assert.strictEqual(err.code, "session_closed");
      assert.match(err.message, /not logged in/);
      return true;
    });
    assert.ok(Date.now() - begin < 1_000, "must not wait out the 5s URL timeout");
  });

  test("submit writes the code with a carriage return and returns the token", async () => {
    const pty = new FakePty();
    const session = sessionWith(pty);
    const started = session.start();
    setTimeout(() => pty.emit(osc8(AUTHORIZE, "auth")), 5);
    await started;

    pty.onWrite = (_data, p) => setTimeout(() => p.emit("\r\nsk-ant-oat01-ABCdef_123\r\n"), 5);
    const result = await session.submit("  code-123  ");

    // \r, not \n: the CLI reads Enter from a terminal.
    assert.deepStrictEqual(pty.written, ["code-123\r"]);
    assert.deepStrictEqual(result.credential, {
      envVar: "CLAUDE_CODE_OAUTH_TOKEN",
      value: "sk-ant-oat01-ABCdef_123",
    });
    assert.strictEqual(pty.killed, true, "a completed session releases its child");
  });

  test("submit fails fast when the CLI exits without printing a token", async () => {
    const pty = new FakePty();
    const session = sessionWith(pty, { submitTimeoutMs: 5_000 });
    const started = session.start();
    setTimeout(() => pty.emit(osc8(AUTHORIZE, "auth")), 5);
    await started;

    pty.onWrite = (_d, p) => setTimeout(() => { p.emit("Invalid code\r\n"); p.exit(1); }, 5);
    await assert.rejects(session.submit("bad"), (err: AuthProvisioningError) => {
      assert.strictEqual(err.code, "code_rejected");
      assert.match(err.message, /Invalid code/);
      return true;
    });
  });

  test("a token printed in the same tick as exit still counts as success", async () => {
    const pty = new FakePty();
    const session = sessionWith(pty);
    const started = session.start();
    setTimeout(() => pty.emit(osc8(AUTHORIZE, "auth")), 5);
    await started;

    pty.onWrite = (_d, p) => setTimeout(() => { p.emit("sk-ant-oat01-TOKEN\r\n"); p.exit(0); }, 5);
    const result = await session.submit("code");
    assert.strictEqual(result.credential?.value, "sk-ant-oat01-TOKEN");
  });

  test("submit before start is rejected rather than silently spawning", async () => {
    const session = sessionWith(new FakePty());
    await assert.rejects(session.submit("code"), (err: AuthProvisioningError) => {
      assert.strictEqual(err.code, "session_not_started");
      return true;
    });
  });

  test("an empty code is rejected without touching the CLI", async () => {
    const pty = new FakePty();
    const session = sessionWith(pty);
    const started = session.start();
    setTimeout(() => pty.emit(osc8(AUTHORIZE, "auth")), 5);
    await started;

    await assert.rejects(session.submit("   "), (err: AuthProvisioningError) => {
      assert.strictEqual(err.code, "empty_code");
      return true;
    });
    assert.deepStrictEqual(pty.written, []);
    session.cancel();
  });
});
