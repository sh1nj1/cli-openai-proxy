import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, test } from "node:test";
import { gzipSync } from "node:zlib";
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
import {
  AUTHORIZED_PROVISIONING_HEADER,
  PROVISIONING_GENERATION_HEADER,
  encodeProvisioningUrl,
} from "./worker-protocol.js";

afterEach(() => {
  resetCapturedProxySecrets();
  resetRequestIdentityForTests();
  for (const name of [
    "API_KEYS",
    "AUTH_ADMIN_KEYS",
    "USER_API_KEYS",
    "USER_IDENTITY_HMAC_SECRET",
    "USER_WORKER_MODE",
  ]) {
    delete process.env[name];
  }
});

test("identity configuration fails closed without active worker routing", () => {
  process.env.USER_WORKER_MODE = "enabled";
  process.env.USER_API_KEYS = JSON.stringify([
    { key: "user-key-12345678", tenantId: "tenant-a", userId: "user-a" },
  ]);
  assert.throws(
    () => createApp(),
    /require active per-user worker routing/,
    "the mode flag alone must not authorize mapped keys on the shared gateway",
  );
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

test("gateway consumes a worker provisioning notification without exposing its private header", async () => {
  const socketPath = `/tmp/cap-worker-${randomUUID().slice(0, 8)}.sock`;
  const manifestUrl = "https://collavre.test/agents/vrex/provision.json?token=secret";
  const generation = "019865f4-50d6-7000-8000-000000000001";
  const worker = http.createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "application/json",
      [AUTHORIZED_PROVISIONING_HEADER]: encodeProvisioningUrl(manifestUrl),
      [PROVISIONING_GENERATION_HEADER]: generation,
    });
    response.end(JSON.stringify({ status: "authorized" }));
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
    { key: "user-key-12345678", tenantId: "tenant-a", userId: "user-a" },
  ]);
  process.env.AUTH_ADMIN_KEYS = "admin-key-123456";
  const notifications: string[] = [];
  const gateway = createApp({
    userWorkerProxy: new UserWorkerProxy(provisioner),
    onAuthorizedProvisioningUrl: (url) => { notifications.push(url); },
  }).listen(0);
  await new Promise<void>((resolve) => gateway.once("listening", resolve));

  try {
    const port = (gateway.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/v1/auth/fake/sessions/session-1`, {
      headers: {
	authorization: "Bearer admin-key-123456",
	"x-cli-proxy-user-key": "user-key-12345678",
      },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get(AUTHORIZED_PROVISIONING_HEADER), null);
    assert.equal(response.headers.get(PROVISIONING_GENERATION_HEADER), null);
    assert.deepEqual(await response.json(), { status: "authorized" });
    assert.deepEqual(notifications, [manifestUrl]);
  } finally {
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await new Promise<void>((resolve) => worker.close(() => resolve()));
    await rm(socketPath, { force: true });
  }
});

test("gateway ignores a retained session notification after a newer session registers", async () => {
  const socketPath = `/tmp/cap-worker-${randomUUID().slice(0, 8)}.sock`;
  const generations = new Map<string, string>();
  const urls = new Map([
    ["session-a", "https://collavre.test/agents/vrex/a.json"],
    ["session-b", "https://collavre.test/agents/vrex/b.json"],
  ]);
  let created = 0;
  const worker = http.createServer((request, response) => {
    if (request.method === "POST" && request.url === "/v1/auth/fake/sessions") {
      const sessionId = created++ === 0 ? "session-a" : "session-b";
      generations.set(sessionId, String(request.headers[PROVISIONING_GENERATION_HEADER]));
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ sessionId, status: "pending" }));
      return;
    }
    const sessionId = request.url?.split("/").at(-1) ?? "";
    response.writeHead(200, {
      "content-type": "application/json",
      [AUTHORIZED_PROVISIONING_HEADER]: encodeProvisioningUrl(urls.get(sessionId)!),
      [PROVISIONING_GENERATION_HEADER]: generations.get(sessionId)!,
    });
    response.end(JSON.stringify({ sessionId, status: "authorized" }));
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
    { key: "user-key-12345678", tenantId: "tenant-a", userId: "user-a" },
  ]);
  process.env.AUTH_ADMIN_KEYS = "admin-key-123456";
  const notifications: string[] = [];
  const gateway = createApp({
    userWorkerProxy: new UserWorkerProxy(provisioner),
    onAuthorizedProvisioningUrl: (url) => { notifications.push(url); },
  }).listen(0);
  await new Promise<void>((resolve) => gateway.once("listening", resolve));

  try {
    const port = (gateway.address() as AddressInfo).port;
    const headers = {
      authorization: "Bearer admin-key-123456",
      "content-type": "application/json",
      [PROVISIONING_GENERATION_HEADER]: "ffffffff-ffff-7fff-bfff-ffffffffffff",
      "x-cli-proxy-user-key": "user-key-12345678",
    };
    const create = () => fetch(`http://127.0.0.1:${port}/v1/auth/fake/sessions`, {
      method: "POST",
      headers,
      body: "{}",
    }).then((response) => response.json() as Promise<{ sessionId: string }>);
    const first = await create();
    const second = await create();
    assert.notEqual(generations.get(first.sessionId), headers[PROVISIONING_GENERATION_HEADER]);
    assert.ok(generations.get(first.sessionId)! < generations.get(second.sessionId)!);

    await fetch(`http://127.0.0.1:${port}/v1/auth/fake/sessions/${second.sessionId}`, { headers });
    await fetch(`http://127.0.0.1:${port}/v1/auth/fake/sessions/${first.sessionId}`, { headers });

    assert.deepEqual(notifications, [urls.get(second.sessionId)]);
  } finally {
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await new Promise<void>((resolve) => worker.close(() => resolve()));
    await rm(socketPath, { force: true });
  }
});

test("gateway strips content encoding after Express inflates and reserializes JSON", async () => {
  const socketPath = `/tmp/cap-worker-${randomUUID().slice(0, 8)}.sock`;
  let seenEncoding: string | undefined;
  let seenBody = "";
  const worker = http.createServer((request, response) => {
    seenEncoding = request.headers["content-encoding"];
    request.setEncoding("utf8");
    request.on("data", (chunk) => { seenBody += chunk; });
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
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
    { key: "user-key-12345678", tenantId: "tenant-a", userId: "user-a" },
  ]);
  const gateway = createApp({ userWorkerProxy: new UserWorkerProxy(provisioner) }).listen(0);
  await new Promise<void>((resolve) => gateway.once("listening", resolve));

  try {
    const port = (gateway.address() as AddressInfo).port;
    const payload = { messages: [{ role: "user", content: "compressed" }] };
    const body = gzipSync(JSON.stringify(payload));
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = http.request({
        host: "127.0.0.1",
        port,
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          authorization: "Bearer user-key-12345678",
          "content-type": "application/json",
          "content-encoding": "gzip",
          "content-length": String(body.length),
        },
      }, (response) => {
        let responseBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { responseBody += chunk; });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body: responseBody }));
      });
      request.on("error", reject);
      request.end(body);
    });

    assert.equal(result.status, 200);
    assert.equal(result.body, "{}");
    assert.equal(seenEncoding, undefined);
    assert.deepEqual(JSON.parse(seenBody), payload);
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

test("gateway times out when a connected worker never sends response headers", { timeout: 1_000 }, async () => {
  const socketPath = `/tmp/cap-worker-hung-${randomUUID().slice(0, 8)}.sock`;
  let workerAccepted!: () => void;
  const accepted = new Promise<void>((resolve) => { workerAccepted = resolve; });
  const worker = http.createServer(() => { workerAccepted(); });
  await new Promise<void>((resolve) => worker.listen(socketPath, resolve));

  process.env.USER_API_KEYS = JSON.stringify([
    { key: "user-key-12345678", tenantId: "tenant-a", userId: "user-a" },
  ]);
  const provisioner: WorkerProvisioner = {
    async ensureWorker() {
      return { accountName: "cap_0123456789abcdef0123", endpoint: { kind: "unix", address: socketPath } };
    },
  };
  const gateway = createApp({ userWorkerProxy: new UserWorkerProxy(provisioner, 100) }).listen(0);
  await new Promise<void>((resolve) => gateway.once("listening", resolve));

  try {
    const port = (gateway.address() as AddressInfo).port;
    const responsePromise = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer user-key-12345678", "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    await accepted;
    const response = await responsePromise;
    assert.equal(response.status, 503);
    const payload = await response.json() as { error: { code: string } };
    assert.equal(payload.error.code, "worker_unavailable");
  } finally {
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await new Promise<void>((resolve) => worker.close(() => resolve()));
    await rm(socketPath, { force: true });
  }
});

test("gateway removes the readiness timeout after worker response headers", { timeout: 1_000 }, async () => {
  const socketPath = `/tmp/cap-worker-stream-${randomUUID().slice(0, 8)}.sock`;
  const worker = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.flushHeaders();
    setTimeout(() => response.end("finished"), 250);
  });
  await new Promise<void>((resolve) => worker.listen(socketPath, resolve));

  process.env.USER_API_KEYS = JSON.stringify([
    { key: "user-key-12345678", tenantId: "tenant-a", userId: "user-a" },
  ]);
  const provisioner: WorkerProvisioner = {
    async ensureWorker() {
      return { accountName: "cap_0123456789abcdef0123", endpoint: { kind: "unix", address: socketPath } };
    },
  };
  const gateway = createApp({ userWorkerProxy: new UserWorkerProxy(provisioner, 100) }).listen(0);
  await new Promise<void>((resolve) => gateway.once("listening", resolve));

  try {
    const port = (gateway.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer user-key-12345678", "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "finished");
  } finally {
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await new Promise<void>((resolve) => worker.close(() => resolve()));
    await rm(socketPath, { force: true });
  }
});
