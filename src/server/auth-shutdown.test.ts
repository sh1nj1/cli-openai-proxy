/**
 * Auth sessions are module state, not listener state, so stopping the server does
 * not by itself release them. A pending paste-code session owns a pty child that
 * no route can reach once the listener is gone — left to its TTL it leaks a login
 * for ten minutes, and an in-process restart can still resolve and submit it.
 *
 * Own file: it drives the real startServer/stopServer singleton and boots with
 * AUTH_ADMIN_KEYS, both of which a sibling test would otherwise inherit.
 */

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { startServer, stopServer, getServer } from "./index.js";
import { engineRegistry } from "../auth/registry.js";
import type { EngineAuthDescriptor, EngineAuthSession } from "../auth/types.js";

const ADMIN_KEY = "admin-shutdown";
const authHeaders = { Authorization: `Bearer ${ADMIN_KEY}` };

/** Stands in for the pty child the real paste-code adapter holds open. */
class FakeSession implements EngineAuthSession {
  cancelled = false;
  async start() {
    return { verificationUrl: "https://example.test/authorize", instructions: "open it" };
  }
  async submit() {
    return {};
  }
  cancel() {
    this.cancelled = true;
  }
}

let created: FakeSession[] = [];
const realResolve = engineRegistry.resolve;

const fakeDescriptor: EngineAuthDescriptor = {
  engine: "fake",
  flows: [
    {
      flow: "paste-code",
      createSession: () => {
        const s = new FakeSession();
        created.push(s);
        return s;
      },
    },
  ],
  checkStatus: async () => ({ state: "unknown" }),
};

async function boot(): Promise<number> {
  process.env.AUTH_ADMIN_KEYS = ADMIN_KEY;
  created = [];
  engineRegistry.resolve = (engine) => (engine === "fake" ? fakeDescriptor : realResolve(engine));
  const server = await startServer({ port: 0 });
  return (server.address() as AddressInfo).port;
}

afterEach(async () => {
  if (getServer()) await stopServer();
  engineRegistry.resolve = realResolve;
  delete process.env.AUTH_ADMIN_KEYS;
});

async function createFakeSession(port: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/auth/fake/sessions`, {
    method: "POST",
    headers: authHeaders,
  });
  assert.equal(res.status, 201, "the fake engine must be reachable through the real routes");
  return ((await res.json()) as { sessionId: string }).sessionId;
}

test("stopping the server kills the child a pending session holds", async () => {
  const port = await boot();
  await createFakeSession(port);

  assert.equal(created.length, 1);
  assert.equal(created[0].cancelled, false, "the session must be live before shutdown");

  await stopServer();

  assert.equal(
    created[0].cancelled,
    true,
    "an abandoned login must not outlive the server that started it",
  );
});

test("a pending session is not resolvable after an in-process restart", async () => {
  const port = await boot();
  const sessionId = await createFakeSession(port);

  await stopServer();
  const restarted = await startServer({ port: 0 });
  const newPort = (restarted.address() as AddressInfo).port;

  const res = await fetch(`http://127.0.0.1:${newPort}/v1/auth/fake/sessions/${sessionId}`, {
    headers: authHeaders,
  });
  // 200 here would mean the session survived its server and is still submittable —
  // a credential write driven by a request the operator believed they had stopped.
  assert.equal(res.status, 404, "a session must not be resolvable after a restart");
  const body = (await res.json()) as { error: { code: string } };
  assert.equal(body.error.code, "unknown_session");
});
