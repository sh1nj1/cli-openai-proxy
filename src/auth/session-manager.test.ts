import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { engineRegistry } from "./registry.js";
import {
  cancelSession,
  createSession,
  getSession,
  resetSessions,
  submitSession,
  type SessionView,
} from "./session-manager.js";
import { clearAllCredentials, getProvisionedAuthEnv } from "./token-store.js";
import { AuthProvisioningError, type EngineAuthDescriptor, type EngineAuthSession } from "./types.js";

/** Records lifecycle calls so tests can assert a held child is released. */
class FakeSession implements EngineAuthSession {
  cancelled = false;
  submitted: string[] = [];
  private abortStart: ((err: Error) => void) | null = null;
  constructor(private readonly behavior: Behavior = {}) {}

  async start() {
    // Models the real gap between spawning the CLI and it printing its URL.
    if (this.behavior.startDelayMs) {
      await new Promise<void>((resolve, reject) => {
        // Like the pty adapter, a cancelled start fails rather than resolving:
        // the child it was waiting on is gone.
        if (this.behavior.startFailsOnCancel) this.abortStart = reject;
        setTimeout(resolve, this.behavior.startDelayMs);
      });
    }
    return { verificationUrl: "https://example.test/authorize", instructions: "open it" };
  }
  async submit(input: string) {
    this.submitted.push(input);
    // Models the real gap between handing the credential to the CLI and the CLI
    // finishing with it — the window two overlapping POSTs would both enter.
    if (this.behavior.submitDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, this.behavior.submitDelayMs));
    }
    if (this.behavior.failSubmit) throw new AuthProvisioningError("nope", "code_rejected");
    return this.behavior.credential
      ? { credential: { envVar: "FAKE_TOKEN", value: `tok-${input}` } }
      : {};
  }
  cancel() {
    this.cancelled = true;
    this.abortStart?.(new AuthProvisioningError("waiter gave up", "verification_url_timeout"));
    this.abortStart = null;
  }
}

interface Behavior {
  failSubmit?: boolean;
  credential?: boolean;
  startDelayMs?: number;
  startFailsOnCancel?: boolean;
  submitDelayMs?: number;
}

let created: FakeSession[] = [];
let behavior: Behavior = {};
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

  // The engine slot is only claimed once start() resolves, so two overlapping
  // starts used to both launch a CLI child: one was left orphaned (nothing could
  // dispose it) and both remained submittable, racing to set the credential.
  test("overlapping starts for one engine leave exactly one live session", async () => {
    behavior = { startDelayMs: 30 };
    const [first, second] = await Promise.allSettled([createSession("fake"), createSession("fake")]);

    const winners = [first, second].filter((r) => r.status === "fulfilled");
    assert.strictEqual(winners.length, 1, "only one start may register a session");

    const loser = [first, second].find((r) => r.status === "rejected");
    assert.strictEqual((loser as PromiseRejectedResult).reason.code, "session_superseded");

    assert.strictEqual(created.length, 2, "both attempts created a session object");
    assert.strictEqual(
      created.filter((s) => !s.cancelled).length,
      1,
      "the superseded attempt's child must be killed, not orphaned",
    );

    // The surviving session is the one the caller was handed.
    const view = (winners[0] as PromiseFulfilledResult<SessionView>).value;
    assert.strictEqual(getSession("fake", view.sessionId).status, "pending");
  });

  // The real paste-code adapter does not resolve a cancelled start — its waiter
  // fails. Reporting that failure verbatim would answer 400 verification_url_timeout
  // for a request whose only problem was losing a race.
  test("a start cancelled by a newer one reports the race, not the adapter's reason", async () => {
    behavior = { startDelayMs: 60, startFailsOnCancel: true };
    const [first, second] = await Promise.allSettled([createSession("fake"), createSession("fake")]);

    const loser = [first, second].find((r) => r.status === "rejected") as PromiseRejectedResult;
    assert.ok(loser, "one of two overlapping starts must lose the slot");
    assert.strictEqual(loser.reason.code, "session_superseded");
    assert.strictEqual([first, second].filter((r) => r.status === "fulfilled").length, 1);
  });

  // `status` stays "pending" until submit() resolves, so it cannot gate this on
  // its own: both requests would drive the same session — two codes into one pty,
  // or two `codex login` runs racing to replace the host credential.
  test("overlapping submits for one session drive the handle exactly once", async () => {
    behavior = { credential: true, submitDelayMs: 50 };
    const view = await createSession("fake");
    const [first, second] = await Promise.allSettled([
      submitSession("fake", view.sessionId, "code-first"),
      submitSession("fake", view.sessionId, "code-second"),
    ]);

    const loser = [first, second].find((r) => r.status === "rejected") as PromiseRejectedResult;
    assert.ok(loser, "one of two overlapping submits must be refused");
    assert.strictEqual(loser.reason.code, "session_submitting");

    const winners = [first, second].filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<SessionView>[];
    assert.strictEqual(winners.length, 1);
    assert.strictEqual(winners[0].value.status, "authorized");
    assert.deepStrictEqual(created[0].submitted, ["code-first"], "only one credential reaches the CLI");
    // Whichever ran, the stored credential must be the one that was reported.
    assert.deepStrictEqual(getProvisionedAuthEnv("fake"), { FAKE_TOKEN: "tok-code-first" });
  });

  // The in-progress flag is a race guard, not session state: an observer polling
  // GET must not see a status the documented vocabulary does not contain.
  test("an in-progress submit is not visible as a new session status", async () => {
    behavior = { submitDelayMs: 50 };
    const view = await createSession("fake");
    const inFlight = submitSession("fake", view.sessionId, "code");
    assert.strictEqual(getSession("fake", view.sessionId).status, "pending");
    assert.ok(!("submitting" in getSession("fake", view.sessionId)), "internal flag must not leak into the view");
    await inFlight;
  });

  test("a successful submit stores the credential and releases the session", async () => {
    behavior = { credential: true };
    const view = await createSession("fake");
    const result = await submitSession("fake", view.sessionId, "code-1");

    assert.strictEqual(result.status, "authorized");
    assert.deepStrictEqual(getProvisionedAuthEnv("fake"), { FAKE_TOKEN: "tok-code-1" });
    assert.strictEqual(created[0].cancelled, true);
  });

  // A rejected credential is a completed attempt, not a transport failure.
  test("a rejected submit resolves as a failed session carrying the reason", async () => {
    behavior = { failSubmit: true };
    const view = await createSession("fake");
    const result = await submitSession("fake", view.sessionId, "bad");

    assert.strictEqual(result.status, "failed");
    assert.deepStrictEqual(result.error, { message: "nope", code: "code_rejected" });
    assert.deepStrictEqual(getProvisionedAuthEnv("fake"), {});
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
