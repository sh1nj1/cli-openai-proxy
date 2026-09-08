import { test, describe, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { createApp } from "./index.js";
import { resetCapturedProxySecrets } from "../config.js";
import { engineRegistry } from "../auth/registry.js";
import type { EngineAuthDescriptor, EngineAuthStatus } from "../auth/types.js";
import { resetEngineProbe, warmEngineProbe } from "./health.js";

const savedResolve = engineRegistry.resolve;
const savedIds = engineRegistry.ids;

/** Keeps the suite off the real CLIs — a probe here would spawn `codex login status`. */
function stubEngines(states: Record<string, EngineAuthStatus["state"]>): void {
  engineRegistry.ids = () => Object.keys(states);
  engineRegistry.resolve = (engine: string): EngineAuthDescriptor | null =>
    Object.hasOwn(states, engine)
      ? ({ engine, flows: [], checkStatus: async () => ({ state: states[engine] }) } as unknown as EngineAuthDescriptor)
      : null;
}

/** node:test runs with strict TS; the health bodies are asserted field by field. */
const jsonOf = async (res: Response): Promise<any> => await res.json();

async function serve(fn: (base: string, server: Server) => Promise<void>): Promise<void> {
  const app = createApp();
  const server = app.listen(0);
  try {
    await new Promise<void>(resolve => server.once("listening", () => resolve()));
    const { port } = server.address() as AddressInfo;
    await fn(`http://127.0.0.1:${port}`, server);
  } finally {
    server.close();
  }
}

describe("health endpoints", () => {
  beforeEach(() => {
    resetEngineProbe();
    resetCapturedProxySecrets();
  });

  afterEach(() => {
    resetEngineProbe();
    resetCapturedProxySecrets();
    delete process.env.API_KEYS;
    engineRegistry.resolve = savedResolve;
    engineRegistry.ids = savedIds;
  });

  test("liveness answers unauthenticated and reveals nothing about the install", async () => {
    process.env.API_KEYS = "sk-health-liveness";
    stubEngines({ codex: "authenticated" });
    await serve(async base => {
      const res = await fetch(`${base}/health`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("cache-control"), "no-store");
      const body = await jsonOf(res);
      assert.deepEqual(Object.keys(body).sort(), ["role", "status", "uptimeSeconds"]);
      assert.equal(body.status, "ok");
    });
  });

  // The reason liveness and readiness are separate paths at all: launchd, the
  // docker healthcheck and both installers restart on a failure here, and a
  // logged-out CLI is not something a restart fixes.
  test("liveness stays 200 when every engine is logged out", async () => {
    stubEngines({ codex: "unauthenticated", claude: "unauthenticated" });
    await warmEngineProbe();
    await serve(async base => {
      assert.equal((await fetch(`${base}/health`)).status, 200);
    });
  });

  test("readiness without a key gives the rollup and nothing more", async () => {
    process.env.API_KEYS = "sk-health-ready";
    stubEngines({ codex: "authenticated", claude: "unknown" });
    await warmEngineProbe();
    await serve(async base => {
      const res = await fetch(`${base}/health/ready`);
      assert.equal(res.status, 200, "an unauthenticated monitor must still be able to poll");
      const body = await jsonOf(res);
      assert.deepEqual(body, { status: "degraded", engines: { ready: 1, total: 2 } });
    });
  });

  test("readiness with a valid key names each engine", async () => {
    process.env.API_KEYS = "sk-health-detail";
    stubEngines({ codex: "authenticated", claude: "unknown" });
    await warmEngineProbe();
    await serve(async base => {
      const res = await fetch(`${base}/health/ready`, {
        headers: { Authorization: "Bearer sk-health-detail" },
      });
      assert.equal(res.status, 200);
      const body = await jsonOf(res);
      assert.equal(body.status, "degraded");
      assert.equal(body.engines.mode, "host");
      assert.equal(body.engines.stale, false);
      assert.equal(body.engines.items.codex.state, "authenticated");
      assert.equal(body.engines.items.claude.state, "unknown");
      assert.equal(body.features.apiKeyAuth, true);
      assert.equal(typeof body.version, "string");
      assert.equal(typeof body.usage.totalRequests, "number");
    });
  });

  test("readiness answers 503 only when every engine is provably unusable", async () => {
    stubEngines({ codex: "unauthenticated", claude: "unauthenticated" });
    await warmEngineProbe();
    await serve(async base => {
      const res = await fetch(`${base}/health/ready`);
      assert.equal(res.status, 503);
      assert.equal((await jsonOf(res)).status, "down");
    });
  });

  // A healthy macOS host reports claude as unknown forever (keychain), so this is
  // the state a fail-closed rollup would have pinned at 503.
  test("an all-unknown host is degraded at 200, not down", async () => {
    stubEngines({ codex: "unknown", claude: "unknown" });
    await warmEngineProbe();
    await serve(async base => {
      const res = await fetch(`${base}/health/ready`);
      assert.equal(res.status, 200);
      assert.equal((await jsonOf(res)).status, "degraded");
    });
  });

  test("under per-user routing readiness refuses to answer for the host's engines", async () => {
    stubEngines({ codex: "unauthenticated" });
    await warmEngineProbe();
    const app = createApp();
    app.locals.userWorkerRouting = true;
    const server = app.listen(0);
    try {
      await new Promise<void>(resolve => server.once("listening", () => resolve()));
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/health/ready`);
      assert.equal(res.status, 200);
      const body = await jsonOf(res);
      assert.equal(body.status, "ok");
      assert.equal(body.engines.mode, "per-user");
      assert.equal(body.engines.ready, undefined, "the gateway's own engines are not the answer here");
    } finally {
      server.close();
    }
  });
});
