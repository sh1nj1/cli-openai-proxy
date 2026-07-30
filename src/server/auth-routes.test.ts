import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import {
  authAdminMiddleware,
  handleAuthEngines,
  handleAuthStatus,
  handleCreateAuthSession,
  handleForgetCredential,
  handleSubmitAuthSession,
  initAuthAdmin,
} from "./auth-routes.js";
import { authMiddleware, initAuth } from "./auth.js";
import { engineRegistry } from "../auth/registry.js";
import { resetSessions } from "../auth/session-manager.js";
import { clearAllCredentials, setCredential } from "../auth/token-store.js";
import type { EngineAuthDescriptor, EngineAuthSession } from "../auth/types.js";

interface FakeRes extends Response {
  statusCode: number;
  payload: unknown;
}

function fakeRes(): FakeRes {
  const res: any = {};
  res.statusCode = 200;
  res.payload = undefined;
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (obj: unknown) => { res.payload = obj; return res; };
  return res as FakeRes;
}

function fakeReq(overrides: Partial<Request> = {}): Request {
  return { headers: {}, params: {}, body: {}, path: "/v1/auth/fake/sessions", ...overrides } as Request;
}

const errorOf = (res: FakeRes) => (res.payload as { error: { code: string; message: string } }).error;

class FakeSession implements EngineAuthSession {
  async start() { return { verificationUrl: "https://example.test/authorize", instructions: "open it" }; }
  async submit(input: string) {
    return { credential: { envVar: "FAKE_TOKEN", value: `tok-${input}` } };
  }
  cancel() {}
}

const fakeDescriptor: EngineAuthDescriptor = {
  engine: "fake",
  flows: [{ flow: "paste-code", createSession: () => new FakeSession() }],
  checkStatus: async () => ({ state: "authenticated", source: "provisioned" }),
};

const realResolve = engineRegistry.resolve;
const realIds = engineRegistry.ids;
let savedAdminKeys: string | undefined;

describe("auth-routes", () => {
  beforeEach(() => {
    savedAdminKeys = process.env.AUTH_ADMIN_KEYS;
    clearAllCredentials();
    engineRegistry.resolve = (engine) => (engine === "fake" ? fakeDescriptor : realResolve(engine));
    engineRegistry.ids = () => ["fake", ...realIds()];
  });

  afterEach(() => {
    resetSessions();
    engineRegistry.resolve = realResolve;
    engineRegistry.ids = realIds;
    if (savedAdminKeys === undefined) delete process.env.AUTH_ADMIN_KEYS;
    else process.env.AUTH_ADMIN_KEYS = savedAdminKeys;
    initAuthAdmin();
  });

  // Fail-closed: upgrading the proxy must not silently expose a login endpoint.
  test("the whole surface is disabled (404) when AUTH_ADMIN_KEYS is unset", () => {
    delete process.env.AUTH_ADMIN_KEYS;
    assert.equal(initAuthAdmin().enabled, false);

    const res = fakeRes();
    let nexted = false;
    authAdminMiddleware(fakeReq(), res, () => { nexted = true; });

    assert.equal(nexted, false);
    assert.equal(res.statusCode, 404);
    assert.equal(errorOf(res).code, "auth_provisioning_disabled");
  });

  test("a request without the admin key is rejected with 401", () => {
    process.env.AUTH_ADMIN_KEYS = "admin-1";
    initAuthAdmin();

    const res = fakeRes();
    authAdminMiddleware(fakeReq(), res, () => assert.fail("must not pass"));
    assert.equal(res.statusCode, 401);
    assert.equal(errorOf(res).code, "invalid_admin_key");
  });

  // The two key sets are separate trust levels; a completion key must not
  // become a credential-mutation key.
  test("a completion API key is not accepted as an admin key", () => {
    process.env.API_KEYS = "sk-completion";
    process.env.AUTH_ADMIN_KEYS = "admin-1";
    initAuth();
    initAuthAdmin();

    const res = fakeRes();
    authAdminMiddleware(
      fakeReq({ headers: { authorization: "Bearer sk-completion" } }),
      res,
      () => assert.fail("must not pass"),
    );
    assert.equal(res.statusCode, 401);
    delete process.env.API_KEYS;
    initAuth();
  });

  // The completion gate would otherwise reject the (correct) admin key, making
  // the auth routes unreachable whenever API_KEYS is set.
  test("the completion middleware defers /v1/auth to the admin gate", () => {
    process.env.API_KEYS = "sk-completion";
    initAuth();

    const res = fakeRes();
    let nexted = false;
    authMiddleware(fakeReq({ path: "/v1/auth/codex/sessions" }), res, () => { nexted = true; });

    assert.equal(nexted, true, "must fall through to authAdminMiddleware");
    assert.equal(res.statusCode, 200);
    delete process.env.API_KEYS;
    initAuth();
  });

  /**
   * Both inits keep their keys in module state, so the process variable is dead
   * weight afterwards — and dead weight that every CLI child would inherit. The
   * Paperclip adapters build the child env inside a dependency, so removing it at
   * the source is what makes the guarantee hold for run paths this repo cannot filter.
   */
  test("the inits take their keys out of the process environment", () => {
    process.env.AUTH_ADMIN_KEYS = "admin-1";
    process.env.API_KEYS = "sk-completion";
    assert.equal(initAuthAdmin().keyCount, 1);
    assert.equal(initAuth().keyCount, 1);

    assert.equal("AUTH_ADMIN_KEYS" in process.env, false);
    assert.equal("API_KEYS" in process.env, false);

    // Still enforced from module state, so removal costs nothing at the gate.
    const res = fakeRes();
    let nexted = false;
    authAdminMiddleware(fakeReq({ headers: { authorization: "Bearer admin-1" } }), res, () => { nexted = true; });
    assert.equal(nexted, true);
    initAuth();
  });

  test("a valid admin key passes the gate", () => {
    process.env.AUTH_ADMIN_KEYS = " admin-1 , admin-2 ";
    assert.equal(initAuthAdmin().keyCount, 2);

    const res = fakeRes();
    let nexted = false;
    authAdminMiddleware(fakeReq({ headers: { authorization: "Bearer admin-2" } }), res, () => { nexted = true; });
    assert.equal(nexted, true);
  });

  test("GET engines advertises each engine's flows so the caller can branch its UI", () => {
    const res = fakeRes();
    handleAuthEngines(fakeReq(), res);
    const data = (res.payload as { data: Array<{ engine: string; flow: string; flows: string[] }> }).data;
    // `flow` stays the default so a caller written against single-flow engines keeps working.
    assert.deepEqual(data.find((e) => e.engine === "claude"), {
      engine: "claude", flow: "paste-code", flows: ["paste-code"],
    });
    assert.deepEqual(data.find((e) => e.engine === "codex"), {
      engine: "codex", flow: "api-key", flows: ["api-key", "device-code"],
    });
  });

  test("an unregistered engine answers 404 rather than starting anything", async () => {
    const res = fakeRes();
    await handleCreateAuthSession(fakeReq({ params: { engine: "gemini" } as any }), res);
    assert.equal(res.statusCode, 404);
    assert.equal(errorOf(res).code, "unknown_engine");
  });

  test("inherited Object.prototype names answer unknown_engine on status and session routes", async () => {
    const cases = ["toString", "constructor", "__proto__"].flatMap((engine) =>
      [handleAuthStatus, handleCreateAuthSession].map((handler) => ({ engine, handler })),
    );
    for (const { engine, handler } of cases) {
      const res = fakeRes();
      await handler(fakeReq({ params: { engine } as any }), res);
      assert.equal(res.statusCode, 404, `${engine} via ${handler.name}`);
      assert.equal(errorOf(res).code, "unknown_engine", `${engine} via ${handler.name}`);
    }
  });

  test("creating a session answers 201 with the verification URL", async () => {
    const res = fakeRes();
    await handleCreateAuthSession(fakeReq({ params: { engine: "fake" } as any }), res);

    assert.equal(res.statusCode, 201);
    const view = res.payload as { sessionId: string; flow: string; verificationUrl: string; status: string };
    assert.equal(view.flow, "paste-code");
    assert.equal(view.status, "pending");
    assert.equal(view.verificationUrl, "https://example.test/authorize");
    assert.ok(view.sessionId);
  });

  test("a non-string `flow` is refused before reaching the session manager", async () => {
    const res = fakeRes();
    await handleCreateAuthSession(fakeReq({ params: { engine: "fake" } as any, body: { flow: 42 } }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(errorOf(res).code, "invalid_flow");
  });

  test("a flow the engine does not offer answers 400 naming the supported ones", async () => {
    const res = fakeRes();
    await handleCreateAuthSession(
      fakeReq({ params: { engine: "fake" } as any, body: { flow: "device-code" } }),
      res,
    );
    assert.equal(res.statusCode, 400);
    assert.equal(errorOf(res).code, "unsupported_flow");
    assert.match(errorOf(res).message, /paste-code/);
  });

  test("submit accepts `code` and `api_key` as aliases of `value`", async () => {
    for (const body of [{ value: "a" }, { code: "b" }, { api_key: "c" }]) {
      const created = fakeRes();
      await handleCreateAuthSession(fakeReq({ params: { engine: "fake" } as any }), created);
      const { sessionId } = created.payload as { sessionId: string };

      const res = fakeRes();
      await handleSubmitAuthSession(
        fakeReq({ params: { engine: "fake", sessionId } as any, body }),
        res,
      );
      assert.equal((res.payload as { status: string }).status, "authorized");
    }
  });

  test("a submit with no credential in the body is a 400, not a 500", async () => {
    const res = fakeRes();
    await handleSubmitAuthSession(
      fakeReq({ params: { engine: "fake", sessionId: "whatever" } as any, body: { value: "  " } }),
      res,
    );
    assert.equal(res.statusCode, 400);
    assert.equal(errorOf(res).code, "missing_value");
  });

  test("an unknown session id answers 404", async () => {
    const res = fakeRes();
    await handleSubmitAuthSession(
      fakeReq({ params: { engine: "fake", sessionId: "nope" } as any, body: { value: "x" } }),
      res,
    );
    assert.equal(res.statusCode, 404);
    assert.equal(errorOf(res).code, "unknown_session");
  });

  test("status reports the engine's own verdict", async () => {
    const res = fakeRes();
    await handleAuthStatus(fakeReq({ params: { engine: "fake" } as any }), res);
    assert.deepEqual(res.payload, {
      engine: "fake", flow: "paste-code", flows: ["paste-code"], state: "authenticated", source: "provisioned",
    });
  });

  test("forgetting a credential reports whether one was held", () => {
    setCredential("fake", { envVar: "FAKE_TOKEN", value: "tok" });
    const first = fakeRes();
    handleForgetCredential(fakeReq({ params: { engine: "fake" } as any }), first);
    assert.deepEqual(first.payload, { engine: "fake", cleared: true });

    const second = fakeRes();
    handleForgetCredential(fakeReq({ params: { engine: "fake" } as any }), second);
    assert.deepEqual(second.payload, { engine: "fake", cleared: false });
  });
});
