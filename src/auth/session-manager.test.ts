import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { engineRegistry } from "./registry.js";
import {
  cancelSession,
  createSession,
  getSession,
  resetSessions,
  submitSession,
} from "./session-manager.js";
import { clearAllCredentials, getProvisionedAuthEnv } from "./token-store.js";
import { AuthProvisioningError, type EngineAuthDescriptor, type EngineAuthSession } from "./types.js";

/** Records lifecycle calls so tests can assert a held child is released. */
class FakeSession implements EngineAuthSession {
  cancelled = false;
  submitted: string[] = [];
  constructor(private readonly behavior: { failSubmit?: boolean; credential?: boolean } = {}) {}

  async start() {
    return { verificationUrl: "https://example.test/authorize", instructions: "open it" };
  }
  async submit(input: string) {
    this.submitted.push(input);
    if (this.behavior.failSubmit) throw new AuthProvisioningError("nope", "code_rejected");
    return this.behavior.credential
      ? { credential: { envVar: "FAKE_TOKEN", value: `tok-${input}` } }
      : {};
  }
  cancel() { this.cancelled = true; }
}

let created: FakeSession[] = [];
let behavior: { failSubmit?: boolean; credential?: boolean } = {};
const realResolve = engineRegistry.resolve;

const fakeDescriptor: EngineAuthDescriptor = {
  engine: "fake",
  flow: "paste-code",
  createSession: () => {
    const s = new FakeSession(behavior);
    created.push(s);
    return s;
  },
  checkStatus: async () => ({ state: "unknown" }),
};

describe("session-manager", () => {
  beforeEach(() => {
    created = [];
    behavior = {};
    clearAllCredentials();
    engineRegistry.resolve = (engine) => (engine === "fake" ? fakeDescriptor : realResolve(engine));
  });

  afterEach(() => {
    resetSessions();
    engineRegistry.resolve = realResolve;
  });

  test("create returns the flow and verification URL from the adapter", async () => {
    const view = await createSession("fake");
    assert.strictEqual(view.engine, "fake");
    assert.strictEqual(view.flow, "paste-code");
    assert.strictEqual(view.status, "pending");
    assert.strictEqual(view.verificationUrl, "https://example.test/authorize");
    assert.ok(Date.parse(view.expiresAt) > Date.now());
  });

  test("an unknown engine is rejected before any session is created", async () => {
    await assert.rejects(createSession("nope"), (err: AuthProvisioningError) => {
      assert.strictEqual(err.code, "unknown_engine");
      return true;
    });
  });

  // The paste-code flow holds a live CLI child, so a superseded session is a leak
  // unless it is cancelled.
  test("starting a second session for an engine cancels the first", async () => {
    const first = await createSession("fake");
    await createSession("fake");

    assert.strictEqual(created[0].cancelled, true);
    assert.throws(() => getSession("fake", first.sessionId), (err: AuthProvisioningError) => {
      assert.strictEqual(err.code, "unknown_session");
      return true;
    });
  });

  test("a successful submit stores the credential and releases the session", async () => {
    behavior = { credential: true };
    const view = await createSession("fake");
    const result = await submitSession("fake", view.sessionId, "code-1");

    assert.strictEqual(result.status, "authorized");
    assert.deepStrictEqual(getProvisionedAuthEnv(), { FAKE_TOKEN: "tok-code-1" });
    assert.strictEqual(created[0].cancelled, true);
  });

  // A rejected credential is a completed attempt, not a transport failure.
  test("a rejected submit resolves as a failed session carrying the reason", async () => {
    behavior = { failSubmit: true };
    const view = await createSession("fake");
    const result = await submitSession("fake", view.sessionId, "bad");

    assert.strictEqual(result.status, "failed");
    assert.deepStrictEqual(result.error, { message: "nope", code: "code_rejected" });
    assert.deepStrictEqual(getProvisionedAuthEnv(), {});
  });

  test("a session cannot be submitted twice", async () => {
    const view = await createSession("fake");
    await submitSession("fake", view.sessionId, "code");
    await assert.rejects(submitSession("fake", view.sessionId, "code"), (err: AuthProvisioningError) => {
      assert.strictEqual(err.code, "unknown_session");
      return true;
    });
  });

  // Otherwise a session id leaked from one engine's route could drive another's.
  test("a session id is not usable against a different engine", async () => {
    const view = await createSession("fake");
    assert.throws(() => getSession("claude", view.sessionId), (err: AuthProvisioningError) => {
      assert.strictEqual(err.code, "unknown_session");
      return true;
    });
  });

  test("cancel releases the held child and forgets the session", async () => {
    const view = await createSession("fake");
    assert.strictEqual(cancelSession("fake", view.sessionId).status, "cancelled");
    assert.strictEqual(created[0].cancelled, true);
    assert.throws(() => getSession("fake", view.sessionId));
  });

  test("an abandoned session is reaped after its TTL, killing the child", async () => {
    const prev = process.env.AUTH_SESSION_TTL_MS;
    process.env.AUTH_SESSION_TTL_MS = "40";
    try {
      const view = await createSession("fake");
      await new Promise((r) => setTimeout(r, 90));
      assert.strictEqual(created[0].cancelled, true);
      assert.throws(() => getSession("fake", view.sessionId));
    } finally {
      if (prev === undefined) delete process.env.AUTH_SESSION_TTL_MS;
      else process.env.AUTH_SESSION_TTL_MS = prev;
    }
  });
});
