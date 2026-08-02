import { test, describe } from "node:test";
import assert from "node:assert";
import {
  CLAUDE_API_KEY_ENV,
  ClaudeApiKeySession,
  fetchValidator,
  type KeyVerdict,
  type ValidateKeyFn,
} from "./claude-api-key.js";
import { AuthProvisioningError } from "../types.js";

interface Call { key: string; signal: AbortSignal }

function recordingValidator(result: KeyVerdict | Error): { calls: Call[]; validate: ValidateKeyFn } {
  const calls: Call[] = [];
  const validate: ValidateKeyFn = async (key, signal) => {
    calls.push({ key, signal });
    if (result instanceof Error) throw result;
    return result;
  };
  return { calls, validate };
}

const valid: KeyVerdict = { valid: true };

describe("ClaudeApiKeySession", () => {
  test("start describes the flow and offers no verification URL", async () => {
    const started = await new ClaudeApiKeySession().start();
    assert.strictEqual(started.verificationUrl, undefined);
    assert.match(started.instructions, /API key/i);
  });

  // claude has no `login --with-api-key`; the proxy must hold the key itself.
  test("a validated key is returned as a credential for the proxy to inject", async () => {
    const { calls, validate } = recordingValidator(valid);
    const result = await new ClaudeApiKeySession({ validate }).submit("  sk-ant-test-123  ");

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].key, "sk-ant-test-123");
    assert.deepStrictEqual(result, {
      credential: { envVar: CLAUDE_API_KEY_ENV, value: "sk-ant-test-123" },
    });
  });

  test("a rejected key fails with invalid_api_key and stores nothing", async () => {
    const { validate } = recordingValidator({ valid: false, detail: "HTTP 401" });
    await assert.rejects(
      new ClaudeApiKeySession({ validate }).submit("sk-ant-bad"),
      (err: AuthProvisioningError) => {
        assert.strictEqual(err.code, "invalid_api_key");
        assert.match(err.message, /HTTP 401/);
        assert.ok(!err.message.includes("sk-ant-bad"), "the key must never be echoed");
        return true;
      },
    );
  });

  test("an empty key is rejected before the validator is invoked", async () => {
    const { calls, validate } = recordingValidator(valid);
    await assert.rejects(
      new ClaudeApiKeySession({ validate }).submit("   "),
      (err: AuthProvisioningError) => {
        assert.strictEqual(err.code, "empty_api_key");
        return true;
      },
    );
    assert.deepStrictEqual(calls, []);
  });

  // An unreachable Anthropic API is no verdict about the key: reporting it as a
  // rejected key would send the caller off to rotate a credential that may be fine.
  test("a validator failure is not reported as a rejected key", async () => {
    const { validate } = recordingValidator(
      new AuthProvisioningError("Could not reach the Anthropic API", "validation_unavailable"),
    );
    await assert.rejects(
      new ClaudeApiKeySession({ validate }).submit("sk-ant-test"),
      (err: AuthProvisioningError) => {
        assert.strictEqual(err.code, "validation_unavailable");
        return true;
      },
    );
  });

  test("cancel aborts an in-flight validation", async () => {
    let sawAbort = false;
    const validate: ValidateKeyFn = (_key, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          sawAbort = true;
          reject(new Error("aborted"));
        });
      });

    const session = new ClaudeApiKeySession({ validate });
    const submitted = session.submit("sk-ant-superseded");
    session.cancel();

    await assert.rejects(submitted, (err: AuthProvisioningError) => {
      assert.strictEqual(err.code, "session_cancelled");
      return true;
    });
    assert.ok(sawAbort, "the validator must be told to stop");
  });

  // Defence for a validator that ignores the signal: a cancelled attempt must not
  // hand back a credential the session manager would then store.
  test("a verdict that arrives after cancel is refused, not reported authorized", async () => {
    let release: (() => void) | undefined;
    const validate: ValidateKeyFn = async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return valid; // deliberately ignores the abort signal
    };

    const session = new ClaudeApiKeySession({ validate });
    const submitted = session.submit("sk-ant-superseded");
    await new Promise((r) => setTimeout(r, 5));
    session.cancel();
    release!();

    await assert.rejects(submitted, (err: AuthProvisioningError) => {
      assert.strictEqual(err.code, "session_cancelled");
      return true;
    });
  });

  test("a validation that outlives its timeout rejects as a timeout, not a bad key", async () => {
    const validate: ValidateKeyFn = (_key, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    await assert.rejects(
      new ClaudeApiKeySession({ validate, timeoutMs: 50 }).submit("sk-ant-test"),
      (err: AuthProvisioningError) => {
        assert.strictEqual(err.code, "validation_timeout");
        assert.match(err.message, /50ms/);
        return true;
      },
    );
  });
});

describe("fetchValidator", () => {
  const fetchReturning = (status: number) =>
    (async () => new Response("{}", { status })) as unknown as typeof fetch;

  test("sends the key as a header, never in the URL", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    const fetchFn = (async (url: unknown, init?: RequestInit) => {
      seenUrl = String(url);
      seenHeaders = { ...(init?.headers as Record<string, string>) };
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const verdict = await fetchValidator(fetchFn)("sk-ant-test", new AbortController().signal);
    assert.deepStrictEqual(verdict, { valid: true });
    assert.ok(!seenUrl.includes("sk-ant-test"), "key must not appear in the URL");
    assert.strictEqual(seenHeaders["x-api-key"], "sk-ant-test");
  });

  test("401 and 403 are verdicts: the key is invalid", async () => {
    for (const status of [401, 403]) {
      const verdict = await fetchValidator(fetchReturning(status))("k", new AbortController().signal);
      assert.strictEqual(verdict.valid, false, String(status));
      assert.match(verdict.detail ?? "", new RegExp(String(status)));
    }
  });

  // 429 means authentication already succeeded — the key works, the account is busy.
  test("429 is a verdict: the key is valid", async () => {
    const verdict = await fetchValidator(fetchReturning(429))("k", new AbortController().signal);
    assert.deepStrictEqual(verdict, { valid: true });
  });

  test("a server error is no verdict at all", async () => {
    await assert.rejects(
      fetchValidator(fetchReturning(500))("k", new AbortController().signal),
      (err: AuthProvisioningError) => {
        assert.strictEqual(err.code, "validation_unavailable");
        return true;
      },
    );
  });

  test("a network failure is no verdict at all", async () => {
    const fetchFn = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    await assert.rejects(
      fetchValidator(fetchFn)("k", new AbortController().signal),
      (err: AuthProvisioningError) => {
        assert.strictEqual(err.code, "validation_unavailable");
        assert.match(err.message, /fetch failed/);
        return true;
      },
    );
  });

  // An abort is the session's own doing; re-labelling it "unavailable" would blame
  // the network for a race the caller lost. The session maps aborts itself.
  test("an aborted fetch rethrows instead of claiming the API was unreachable", async () => {
    const aborter = new AbortController();
    const fetchFn = (async () => {
      aborter.abort();
      throw new DOMException("This operation was aborted", "AbortError");
    }) as unknown as typeof fetch;
    await assert.rejects(
      fetchValidator(fetchFn)("k", aborter.signal),
      (err: Error) => err.name === "AbortError",
    );
  });
});
