import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, test } from "node:test";
import { resetCapturedProxySecrets } from "../config.js";
import { resetRequestIdentityForTests } from "../isolation/request-identity.js";
import type { WorkerProvisioner } from "../isolation/types.js";
import { UserWorkerProxy } from "../isolation/worker-proxy.js";
import { createApp } from "./index.js";

afterEach(() => {
  resetCapturedProxySecrets();
  resetRequestIdentityForTests();
  for (const name of ["USER_API_KEYS", "AUTH_ADMIN_KEYS", "PROVISION_SYNC"]) {
    delete process.env[name];
  }
});

const ADMIN_KEY = "admin-key";
const MAPPED_USER_KEY = "mapped-user-key-0123456789";

/**
 * Gateway wired to a fake unix-socket worker (same shape as worker-proxy.test.ts)
 * that just records every path it receives, so tests can assert forwarding
 * without depending on provision-routes' own behavior.
 */
async function startGatewayWithFakeWorker(): Promise<{
  port: number;
  workerSeenPaths: string[];
  close: () => Promise<void>;
}> {
  const socketPath = `/tmp/cap-worker-${randomUUID().slice(0, 8)}.sock`;
  const workerSeenPaths: string[] = [];
  const worker = http.createServer((request, response) => {
    workerSeenPaths.push(request.url ?? "");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => worker.listen(socketPath, resolve));

  const provisioner: WorkerProvisioner = {
    async ensureWorker() {
      return {
        accountName: "cap_0123456789abcdef0123",
        endpoint: { kind: "unix", address: socketPath },
      };
    },
  };
  process.env.USER_API_KEYS = JSON.stringify([
    { key: MAPPED_USER_KEY, tenantId: "tenant-a", userId: "user-a" },
  ]);
  process.env.AUTH_ADMIN_KEYS = ADMIN_KEY;
  const gateway = createApp({ userWorkerProxy: new UserWorkerProxy(provisioner) }).listen(0);
  await new Promise<void>((resolve) => gateway.once("listening", resolve));
  const port = (gateway.address() as AddressInfo).port;
  return {
    port,
    workerSeenPaths,
    close: async () => {
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
      await new Promise<void>((resolve) => worker.close(() => resolve()));
      await rm(socketPath, { force: true });
    },
  };
}

test("provision routes forward to the identity-selected worker", async () => {
  const { port, workerSeenPaths, close } = await startGatewayWithFakeWorker();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/provision`, {
      headers: {
        authorization: `Bearer ${ADMIN_KEY}`,
        "x-cli-proxy-user-key": MAPPED_USER_KEY,
      },
    });
    assert.equal(workerSeenPaths.at(-1), "/v1/provision");
    assert.equal(response.status, 200);
  } finally {
    await close();
  }
});

test("provision routes without identity answer 401 user_identity_required", async () => {
  const { port, close } = await startGatewayWithFakeWorker();
  try {
    // A mapped user key is also a completion key (initAuth captures the combined
    // set), so the admin-key gate consuming Authorization here means it cannot
    // double as identity — X-CLI-Proxy-User-Key must be sent separately.
    const response = await fetch(`http://127.0.0.1:${port}/v1/provision`, {
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
    });
    assert.equal(response.status, 401);
    const payload = await response.json() as { error: { code: string } };
    assert.equal(payload.error.code, "user_identity_required");
  } finally {
    await close();
  }
});

test("provision routes forward even when the gateway engine is disabled", async () => {
  // PROVISION_SYNC is deliberately left unset on the gateway process: once
  // userWorkerProxy is active, the worker's own provisionEnabledGate owns
  // that answer, so the gateway must not 404 on its own disabled engine.
  const { port, workerSeenPaths, close } = await startGatewayWithFakeWorker();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/provision/sync`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ADMIN_KEY}`,
        "x-cli-proxy-user-key": MAPPED_USER_KEY,
        "content-type": "application/json",
      },
    });
    await response.arrayBuffer();
    assert.equal(workerSeenPaths.at(-1), "/v1/provision/sync");
    assert.notEqual(response.status, 404);
  } finally {
    await close();
  }
});
