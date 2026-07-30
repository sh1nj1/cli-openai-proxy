import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, test } from "node:test";
import type { Request, Response } from "express";
import { resetCapturedProxySecrets } from "../config.js";
import { createApp } from "../server/index.js";
import {
  initRequestIdentity,
  requireRequestIdentity,
  resetRequestIdentityForTests,
} from "./request-identity.js";
import type { WorkerProvisioner } from "./types.js";
import { WorkerIsolationError } from "./types.js";
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

test("gateway normalizes platform, provisioning, and unavailable-worker failures without fallback", async () => {
  process.env.USER_API_KEYS = JSON.stringify([
    { key: "user-key-12345678", tenantId: "tenant-a", userId: "user-a" },
  ]);
  const unsupported: WorkerProvisioner = {
    async ensureWorker() {
      throw new WorkerIsolationError("platform unavailable", "platform_unsupported");
    },
  };
  const gateway = createApp({ userWorkerProxy: new UserWorkerProxy(unsupported) }).listen(0);
  await new Promise<void>((resolve) => gateway.once("listening", resolve));
  try {
    const port = (gateway.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer user-key-12345678", connection: "close", "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(response.status, 501);
    const payload = await response.json() as { error: { code: string; message: string } };
    assert.equal(payload.error.code, "platform_unsupported");
    assert.equal(payload.error.message, "Per-user workers are not supported on this platform");
  } finally {
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
  }

  resetCapturedProxySecrets();
  resetRequestIdentityForTests();
  process.env.USER_API_KEYS = JSON.stringify([
    { key: "user-key-12345678", tenantId: "tenant-a", userId: "user-a" },
  ]);
  const failedProvisioner: WorkerProvisioner = {
    async ensureWorker() {
      throw new WorkerIsolationError("useradd failed at /var/lib/private/path", "provisioning_failed");
    },
  };
  const failedGateway = createApp({ userWorkerProxy: new UserWorkerProxy(failedProvisioner) }).listen(0);
  await new Promise<void>((resolve) => failedGateway.once("listening", resolve));
  try {
    const port = (failedGateway.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer user-key-12345678", connection: "close", "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(response.status, 503);
    const payload = await response.json() as { error: { code: string; message: string } };
    assert.equal(payload.error.code, "provisioning_failed");
    assert.equal(payload.error.message, "Unable to provision user worker");
    assert.equal(payload.error.message.includes("/var/lib/private/path"), false);
  } finally {
    await new Promise<void>((resolve) => failedGateway.close(() => resolve()));
  }

  resetCapturedProxySecrets();
  resetRequestIdentityForTests();
  process.env.USER_API_KEYS = JSON.stringify([
    { key: "user-key-12345678", tenantId: "tenant-a", userId: "user-a" },
  ]);
  const missingSocket = `/tmp/cap-worker-missing-${randomUUID().slice(0, 8)}.sock`;
  const unavailable: WorkerProvisioner = {
    async ensureWorker() {
      return { accountName: "cap_0123456789abcdef0123", endpoint: { kind: "unix", address: missingSocket } };
    },
  };
  const secondGateway = createApp({ userWorkerProxy: new UserWorkerProxy(unavailable, 50) }).listen(0);
  await new Promise<void>((resolve) => secondGateway.once("listening", resolve));
  try {
    const port = (secondGateway.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer user-key-12345678", connection: "close", "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(response.status, 503);
    const payload = await response.json() as { error: { code: string; message: string } };
    assert.equal(payload.error.code, "worker_unavailable");
    assert.equal(payload.error.message, "User worker unavailable");
    assert.equal(payload.error.message.includes("cap_0123456789abcdef0123"), false);
  } finally {
    await new Promise<void>((resolve) => secondGateway.close(() => resolve()));
  }
});

test("client disconnect during provisioning never reaches a worker", { timeout: 1_000 }, async () => {
  process.env.USER_API_KEYS = JSON.stringify([
    { key: "user-key-12345678", tenantId: "tenant-a", userId: "user-a" },
  ]);
  initRequestIdentity();
  const headers = { authorization: "Bearer user-key-12345678", "content-type": "application/json" };
  const request = {
    method: "POST",
    path: "/v1/chat/completions",
    originalUrl: "/v1/chat/completions",
    headers,
    body: { messages: [{ role: "user", content: "hi" }] },
    header(name: string) {
      return headers[name.toLowerCase() as keyof typeof headers];
    },
  } as unknown as Request;
  let statusCalls = 0;
  const response = Object.assign(new EventEmitter(), {
    headersSent: false,
    status() { statusCalls += 1; return this; },
    json() { return this; },
  }) as unknown as Response & EventEmitter;
  let identityAccepted = false;
  requireRequestIdentity(request, response, () => { identityAccepted = true; });
  assert.equal(identityAccepted, true);

  let releaseProvisioning!: () => void;
  let provisioningStarted!: () => void;
  const gate = new Promise<void>((resolve) => { releaseProvisioning = resolve; });
  const started = new Promise<void>((resolve) => { provisioningStarted = resolve; });
  const provisioner: WorkerProvisioner = {
    async ensureWorker() {
      provisioningStarted();
      await gate;
      const address = `/tmp/cap-worker-missing-${randomUUID().slice(0, 8)}.sock`;
      return { accountName: "cap_0123456789abcdef0123", endpoint: { kind: "unix", address } };
    },
  };
  const forwarding = new UserWorkerProxy(provisioner).forward(request, response);
  await started;
  response.emit("close");
  releaseProvisioning();
  await forwarding;
  assert.equal(statusCalls, 0);
});
