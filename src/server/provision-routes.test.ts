import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { createServer } from "http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "os";
import path from "path";
import type { Express, Request, Response } from "express";
import {
  PROVISION_PREFIX,
  handleProvisionApprove,
  handleProvisionDelete,
  handleProvisionStatus,
  handleProvisionSync,
  provisionAdminMiddleware,
} from "./provision-routes.js";
import { handleCreateAuthSession, initAuthAdmin } from "./auth-routes.js";
import { authMiddleware, initAuth } from "./auth.js";
import { createApp } from "./index.js";
import { getStatus, initProvisioning, registerManifestUrl, shutdownProvisioning } from "../provision/sync.js";
import { engineRegistry } from "../auth/registry.js";
import { resetSessions } from "../auth/session-manager.js";
import type { EngineAuthDescriptor, EngineAuthSession } from "../auth/types.js";

/** Matches the fetch-against-a-listening-server idiom used by the sibling *-restart/*-ordering tests. */
async function listen(app: Express): Promise<{ server: Server; port: number }> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  return { server, port: (server.address() as AddressInfo).port };
}

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
  return { headers: {}, params: {}, body: {}, path: `${PROVISION_PREFIX}`, ...overrides } as Request;
}

const errorOf = (res: FakeRes) => (res.payload as { error: { code: string; message: string } }).error;

const SAVED_VARS = ["PROVISION_SYNC", "PROVISION_STATE_DIR", "PROVISION_SKILLS_DIR", "AUTH_ADMIN_KEYS"] as const;

describe("provision-routes", () => {
  const saved = new Map<string, string | undefined>();
  let stateDir: string;

  beforeEach(() => {
    for (const name of SAVED_VARS) {
      saved.set(name, process.env[name]);
      delete process.env[name];
    }
    stateDir = mkdtempSync(path.join(tmpdir(), "provision-routes-"));
    process.env.PROVISION_STATE_DIR = stateDir;
    process.env.PROVISION_SKILLS_DIR = path.join(stateDir, "skills");
  });

  afterEach(async () => {
    resetSessions();
    await shutdownProvisioning();
    for (const name of SAVED_VARS) {
      const value = saved.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    initAuthAdmin();
    rmSync(stateDir, { recursive: true, force: true });
  });

  function enable(): void {
    process.env.PROVISION_SYNC = "1";
    process.env.AUTH_ADMIN_KEYS = "admin-1";
    initProvisioning();
    initAuthAdmin();
  }

  // Fail-closed: without the opt-in the surface does not exist, valid key or not.
  test("PROVISION_SYNC unset answers 404 before any key check", () => {
    process.env.AUTH_ADMIN_KEYS = "admin-1";
    initProvisioning();
    initAuthAdmin();

    const res = fakeRes();
    provisionAdminMiddleware(
      fakeReq({ headers: { authorization: "Bearer admin-1" } }),
      res,
      () => assert.fail("must not pass"),
    );
    assert.equal(res.statusCode, 404);
    assert.equal(errorOf(res).code, "provisioning_disabled");
  });

  test("enabled but keyless requests are rejected by the admin gate", () => {
    enable();
    const res = fakeRes();
    provisionAdminMiddleware(fakeReq(), res, () => assert.fail("must not pass"));
    assert.equal(res.statusCode, 401);
  });

  test("a valid admin key passes the gate", () => {
    enable();
    const res = fakeRes();
    let nexted = false;
    provisionAdminMiddleware(fakeReq({ headers: { authorization: "Bearer admin-1" } }), res, () => { nexted = true; });
    assert.equal(nexted, true);
  });

  test("the completion middleware defers /v1/provision to the provisioning gate", () => {
    process.env.API_KEYS = "sk-completion";
    initAuth();

    const res = fakeRes();
    let nexted = false;
    authMiddleware(fakeReq({ path: `${PROVISION_PREFIX}/sync` }), res, () => { nexted = true; });
    assert.equal(nexted, true, "must fall through to provisionAdminMiddleware");
    delete process.env.API_KEYS;
    initAuth();
  });

  test("status reports the sync engine's view", () => {
    enable();
    const res = fakeRes();
    handleProvisionStatus(fakeReq(), res);
    assert.deepEqual(res.payload, getStatus());
  });

  test("sync without a registered manifest url is a 400", async () => {
    enable();
    const res = fakeRes();
    await handleProvisionSync(fakeReq(), res);
    assert.equal(res.statusCode, 400);
    assert.equal(errorOf(res).code, "no_manifest_url");
  });

  test("a malformed item from the registry is an upstream 502", async () => {
    enable();
    const server = createServer((_req, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
	schema: "agent-provisioning/v1",
	items: [{ type: "skill", name: "missing-artifact-fields" }],
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as { port: number }).port;
      registerManifestUrl(`http://127.0.0.1:${port}/provision.json`);
      const res = fakeRes();
      await handleProvisionSync(fakeReq(), res);
      assert.equal(res.statusCode, 502);
      assert.equal(errorOf(res).code, "invalid_item");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  });

  test("approving an item no manifest has named is a 404", async () => {
    enable();
    const res = fakeRes();
    await handleProvisionApprove(fakeReq({ params: { type: "skill", name: "ghost" } as any }), res);
    assert.equal(res.statusCode, 404);
    assert.equal(errorOf(res).code, "unknown_item");
  });

  test("deleting an item that was never installed reports removed: false", async () => {
    enable();
    const res = fakeRes();
    await handleProvisionDelete(fakeReq({ params: { type: "skill", name: "ghost" } as any }), res);
    assert.deepEqual(res.payload, { type: "skill", name: "ghost", removed: false });
  });

  test("a hostile item name in the path is a 400, not a 500", async () => {
    enable();
    const res = fakeRes();
    await handleProvisionDelete(fakeReq({ params: { type: "skill", name: "../../etc" } as any }), res);
    assert.equal(res.statusCode, 400);
  });

  describe("auth session provisioning_url pass-through", () => {
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

    beforeEach(() => {
      engineRegistry.resolve = (engine) => (engine === "fake" ? fakeDescriptor : realResolve(engine));
    });
    afterEach(() => {
      engineRegistry.resolve = realResolve;
    });

    test("a non-string provisioning_url is refused with 400", async () => {
      enable();
      const res = fakeRes();
      await handleCreateAuthSession(
        fakeReq({ params: { engine: "fake" } as any, body: { provisioning_url: 42 } }),
        res,
      );
      assert.equal(res.statusCode, 400);
      assert.equal(errorOf(res).code, "invalid_provisioning_url");
    });

    test("an unparseable provisioning_url is refused with 400", async () => {
      enable();
      const res = fakeRes();
      await handleCreateAuthSession(
        fakeReq({ params: { engine: "fake" } as any, body: { provisioning_url: "not a url" } }),
        res,
      );
      assert.equal(res.statusCode, 400);
      assert.equal(errorOf(res).code, "invalid_provisioning_url");
    });

    test("an authorized session registers its provisioning_url with the sync engine", async () => {
      enable();
      const url = "http://127.0.0.1:1/agents/vrex/provision.json";
      const created = fakeRes();
      await handleCreateAuthSession(
        fakeReq({ params: { engine: "fake" } as any, body: { provisioning_url: url } }),
        created,
      );
      const { sessionId } = created.payload as { sessionId: string };

      const { handleSubmitAuthSession } = await import("./auth-routes.js");
      const res = fakeRes();
      await handleSubmitAuthSession(
        fakeReq({ params: { engine: "fake", sessionId } as any, body: { value: "code" } }),
        res,
      );
      assert.equal((res.payload as { status: string }).status, "authorized");
      assert.equal(getStatus().manifest_url, url);
    });

    test("with provisioning disabled the url is accepted but ignored", async () => {
      process.env.AUTH_ADMIN_KEYS = "admin-1";
      initProvisioning();
      initAuthAdmin();

      const created = fakeRes();
      await handleCreateAuthSession(
        fakeReq({
          params: { engine: "fake" } as any,
          body: { provisioning_url: "https://collavre.example/provision.json" },
        }),
        created,
      );
      assert.equal(created.statusCode, 201);
      const { sessionId } = created.payload as { sessionId: string };

      const { handleSubmitAuthSession } = await import("./auth-routes.js");
      const res = fakeRes();
      await handleSubmitAuthSession(
        fakeReq({ params: { engine: "fake", sessionId } as any, body: { value: "code" } }),
        res,
      );
      assert.equal((res.payload as { status: string }).status, "authorized");
      assert.equal(getStatus().manifest_url, null);
    });
  });

  describe("worker role", () => {
    // Workers never receive AUTH_ADMIN_KEYS (the gateway already authenticated
    // the caller), so their /v1/provision surface must open on the opt-in gate
    // alone rather than requiring the admin-key gate too.
    test("serves provision status without admin keys when PROVISION_SYNC=1", async () => {
      process.env.PROVISION_SYNC = "1";
      const { server, port } = await listen(createApp({ role: "worker" }));
      try {
        const response = await fetch(`http://127.0.0.1:${port}${PROVISION_PREFIX}`);
        assert.equal(response.status, 200);
        const body = await response.json() as { enabled: boolean };
        assert.equal(body.enabled, true);
      } finally {
        server.close();
      }
    });

    test("answers 404 provisioning_disabled when PROVISION_SYNC unset", async () => {
      const { server, port } = await listen(createApp({ role: "worker" }));
      try {
        const response = await fetch(`http://127.0.0.1:${port}${PROVISION_PREFIX}`);
        assert.equal(response.status, 404);
        const body = await response.json() as { error: { code: string } };
        assert.equal(body.error.code, "provisioning_disabled");
      } finally {
        server.close();
      }
    });
  });
});
