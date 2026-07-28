import { test, describe } from "node:test";
import assert from "node:assert";
import { CodexApiKeySession, runCommand, type CommandResult, type RunCommandFn } from "./codex-api-key.js";
import { AuthProvisioningError } from "../types.js";

interface Call { file: string; args: string[]; stdin: string | null }

function recordingRunner(result: CommandResult | Error): { calls: Call[]; run: RunCommandFn } {
  const calls: Call[] = [];
  const run: RunCommandFn = async (file, args, stdin) => {
    calls.push({ file, args, stdin });
    if (result instanceof Error) throw result;
    return result;
  };
  return { calls, run };
}

const ok: CommandResult = { exitCode: 0, stdout: "", stderr: "" };

describe("CodexApiKeySession", () => {
  test("start describes the flow and offers no verification URL", async () => {
    const started = await new CodexApiKeySession().start();
    assert.strictEqual(started.verificationUrl, undefined);
    assert.match(started.instructions, /API key/i);
  });

  // The key must never reach argv: process listings are world-readable.
  test("submit passes the key over stdin, not as a CLI argument", async () => {
    const { calls, run } = recordingRunner(ok);
    await new CodexApiKeySession({ run }).submit("  sk-test-123  ");

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].file, "codex");
    assert.deepStrictEqual(calls[0].args, ["login", "--with-api-key"]);
    assert.strictEqual(calls[0].stdin, "sk-test-123");
    assert.ok(!calls[0].args.some((a) => a.includes("sk-test")), "key must not appear in argv");
  });

  // codex persists its own credentials, so there is nothing for the proxy to hold.
  test("submit returns no credential because the CLI stores its own", async () => {
    const { run } = recordingRunner(ok);
    assert.deepStrictEqual(await new CodexApiKeySession({ run }).submit("sk-test"), {});
  });

  test("a nonzero exit surfaces the CLI's own first error line", async () => {
    const { run } = recordingRunner({ exitCode: 1, stdout: "", stderr: "invalid api key\nstack trace" });
    await assert.rejects(new CodexApiKeySession({ run }).submit("bad"), (err: AuthProvisioningError) => {
      assert.strictEqual(err.code, "login_failed");
      assert.match(err.message, /invalid api key/);
      assert.ok(!err.message.includes("stack trace"), "only the first line is echoed");
      return true;
    });
  });

  test("a missing codex binary is reported as such, not as a generic failure", async () => {
    const { run } = recordingRunner(new Error("spawn codex ENOENT"));
    await assert.rejects(new CodexApiKeySession({ run }).submit("sk-test"), (err: AuthProvisioningError) => {
      assert.strictEqual(err.code, "cli_unavailable");
      assert.match(err.message, /codex CLI not found/);
      return true;
    });
  });

  /**
   * `codex login` writes the host credential itself. A superseded submit left
   * running would overwrite whatever the newer session installed and then report
   * itself authorized, so cancel() has to reach the child, not just stop awaiting.
   */
  test("cancel kills an in-flight login instead of letting it finish", async () => {
    let sawAbort = false;
    const run: RunCommandFn = (_file, _args, _stdin, _timeoutMs, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          sawAbort = true;
          reject(new AuthProvisioningError("Login was cancelled", "session_cancelled"));
        });
      });

    const session = new CodexApiKeySession({ run });
    const submitted = session.submit("sk-superseded");
    session.cancel();

    await assert.rejects(submitted, (err: AuthProvisioningError) => {
      assert.strictEqual(err.code, "session_cancelled");
      return true;
    });
    assert.ok(sawAbort, "the runner must be told to kill the child");
  });

  // Defence for a runner that ignores the signal, and for a child that exits 0 in
  // the same tick it is killed: neither may resurrect a cancelled attempt.
  test("a result that arrives after cancel is refused, not reported authorized", async () => {
    let release: (() => void) | undefined;
    const run: RunCommandFn = async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return ok; // deliberately ignores the abort signal
    };

    const session = new CodexApiKeySession({ run });
    const submitted = session.submit("sk-superseded");
    await new Promise((r) => setTimeout(r, 5));
    session.cancel();
    release!();

    await assert.rejects(submitted, (err: AuthProvisioningError) => {
      assert.strictEqual(err.code, "session_cancelled");
      return true;
    });
  });

  // The real runner, not a fake: the signal has to reach an actual child process.
  test("runCommand terminates the child when its signal aborts", async () => {
    const aborter = new AbortController();
    // `sleep 30` stands in for a login the user never completes; the 30s timeout
    // is what the test would hit if the abort did not reach the process.
    const running = runCommand("sleep", ["30"], null, 30_000, aborter.signal);
    const startedAt = Date.now();
    setTimeout(() => aborter.abort(), 20);

    await assert.rejects(running, (err: AuthProvisioningError) => {
      assert.strictEqual(err.code, "session_cancelled");
      return true;
    });
    assert.ok(Date.now() - startedAt < 2_000, "must not wait out the command timeout");
  });

  test("an already-aborted signal short-circuits before spawning anything", async () => {
    const aborter = new AbortController();
    aborter.abort();
    await assert.rejects(
      runCommand("sleep", ["30"], null, 30_000, aborter.signal),
      (err: AuthProvisioningError) => {
        assert.strictEqual(err.code, "session_cancelled");
        return true;
      },
    );
  });

  test("an empty key is rejected before the CLI is invoked", async () => {
    const { calls, run } = recordingRunner(ok);
    await assert.rejects(new CodexApiKeySession({ run }).submit("   "), (err: AuthProvisioningError) => {
      assert.strictEqual(err.code, "empty_api_key");
      return true;
    });
    assert.deepStrictEqual(calls, []);
  });
});
