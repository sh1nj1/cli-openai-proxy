import { test, describe } from "node:test";
import assert from "node:assert";
import { CodexApiKeySession, type CommandResult, type RunCommandFn } from "./codex-api-key.js";
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

  test("an empty key is rejected before the CLI is invoked", async () => {
    const { calls, run } = recordingRunner(ok);
    await assert.rejects(new CodexApiKeySession({ run }).submit("   "), (err: AuthProvisioningError) => {
      assert.strictEqual(err.code, "empty_api_key");
      return true;
    });
    assert.deepStrictEqual(calls, []);
  });
});
