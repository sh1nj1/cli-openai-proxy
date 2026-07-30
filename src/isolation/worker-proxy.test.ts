import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, test } from "node:test";
import { resetCapturedProxySecrets } from "../config.js";
import { createApp } from "../server/index.js";
import { resetRequestIdentityForTests } from "./request-identity.js";
import type { WorkerProvisioner } from "./types.js";
import { UserWorkerProxy } from "./worker-proxy.js";

afterEach(() => {
  resetCapturedProxySecrets();
  resetRequestIdentityForTests();
  for (const name of ["API_KEYS", "AUTH_ADMIN_KEYS", "USER_API_KEYS", "USER_IDENTITY_HMAC_SECRET"]) {
    delete process.env[name];
  }
});

test("gateway provisions by authenticated identity and strips private headers", async () => {
  const socketPath = `/tmp/cap-worker-${randomUUID().slice(0, 8)}.sock`;
  let seenHeaders: http.IncomingHttpHeaders = {};
  let seenBody = "";
  const worker = http.createServer((request, response) => {
    seenHeaders = request.headers;
    request.setEncoding("utf8");
    request.on("data", (chunk) => { seenBody += chunk; });
    request.on("end", () => {
      response.writeHead(207, { "content-type": "application/json" });
      response.end(JSON.stringify({ worker: true }));
    });
  });
  await new Promise<void>((resolve) => worker.listen(socketPath, resolve));

  const identities: unknown[] = [];
  const provisioner: WorkerProvisioner = {
    async ensureWorker(identity) {
      identities.push(identity);
      return {
        accountName: "cap_0123456789abcdef0123",
        endpoint: { kind: "unix", address: socketPath },
      };
    },
  };
  process.env.USER_API_KEYS = JSON.stringify([
    { key: "user-key-12345678", tenantId: "tenant-a", userId: "user-a" },
  ]);
  process.env.AUTH_ADMIN_KEYS = "admin-key-123456";
  const gateway = createApp({ userWorkerProxy: new UserWorkerProxy(provisioner) }).listen(0);
  await new Promise<void>((resolve) => gateway.once("listening", resolve));
  try {
    const port = (gateway.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer user-key-12345678",
        "content-type": "application/json",
        "x-cli-proxy-user-id": "attacker-controlled",
      },
      body: JSON.stringify({ user: "also-untrusted", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(response.status, 207);
    assert.deepEqual(await response.json(), { worker: true });
    assert.deepEqual(identities, [{ tenantId: "tenant-a", userId: "user-a" }]);
    assert.equal(seenHeaders.authorization, undefined);
    assert.equal(seenHeaders["x-cli-proxy-user-id"], undefined);
    assert.match(seenBody, /"user":"also-untrusted"/, "OpenAI user remains data, never authority");

    const authResponse = await fetch(`http://127.0.0.1:${port}/v1/auth/engines`, {
      headers: {
        authorization: "Bearer admin-key-123456",
        "x-cli-proxy-user-key": "user-key-12345678",
      },
    });
    assert.equal(authResponse.status, 207);
    assert.deepEqual(identities, [
      { tenantId: "tenant-a", userId: "user-a" },
      { tenantId: "tenant-a", userId: "user-a" },
    ]);
    assert.equal(seenHeaders.authorization, undefined);
    assert.equal(seenHeaders["x-cli-proxy-user-key"], undefined);
  } finally {
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await new Promise<void>((resolve) => worker.close(() => resolve()));
    await rm(socketPath, { force: true });
  }
});

test("shared API key cannot select a worker or force JSON parsing without signed identity", async () => {
  let provisioned = false;
  const provisioner: WorkerProvisioner = {
    async ensureWorker() {
      provisioned = true;
      throw new Error("must not run");
    },
  };
  process.env.API_KEYS = "shared-key";
  const gateway = createApp({ userWorkerProxy: new UserWorkerProxy(provisioner) }).listen(0);
  await new Promise<void>((resolve) => gateway.once("listening", resolve));
  try {
    const port = (gateway.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer shared-key", "content-type": "application/json" },
      body: "{ this malformed body must not reach express.json",
    });
    assert.equal(response.status, 401);
    const payload = await response.json() as { error: { code: string } };
    assert.equal(payload.error.code, "user_identity_required");
    assert.equal(provisioned, false);
  } finally {
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
  }
});
