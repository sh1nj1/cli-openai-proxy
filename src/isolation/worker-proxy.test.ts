import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  PROVISIONING_SESSION_TTL_HEADER,
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
    "PROVISION_ALLOWLIST",
    "PROVISION_SYNC",
    "AUTH_SESSION_TTL_MS",
  ]) {
    delete process.env[name];
  }
});

const provisioningUrlHash = (url: string) =>
  createHash("sha256").update(new URL(url).toString()).digest("hex");

async function seedIssuedBinding(
  generationStateFile: string,
  binding: {
    generation: string;
    url: string;
    accountName?: string;
    engine?: string;
    sessionId: string;
  },
): Promise<void> {
  await writeFile(`${generationStateFile}.issued`, JSON.stringify({
    version: 1,
    latestGeneration: binding.generation,
    bindings: [{
      generation: binding.generation,
      urlHash: provisioningUrlHash(binding.url),
      accountName: binding.accountName ?? "cap_0123456789abcdef0123",
      engine: binding.engine ?? "fake",
      sessionId: binding.sessionId,
      expiresAt: Date.now() + 600_000,
    }],
  }));
}

async function latestIssuedGeneration(generationStateFile: string): Promise<string> {
  const state = JSON.parse(await readFile(`${generationStateFile}.issued`, "utf8")) as {
    latestGeneration: string;
  };
  return state.latestGeneration;
}

async function forwardAuthCreateWithBlockedGenerationState(options: {
  provisioningEnabled: boolean;
  body: Record<string, unknown>;
}): Promise<{ status: number; generation: string | undefined }> {
  const socketPath = `/tmp/cap-worker-${randomUUID().slice(0, 8)}.sock`;
  const stateBlocker = `/tmp/cap-generation-blocker-${randomUUID().slice(0, 8)}`;
  await writeFile(stateBlocker, "not a directory");
  let generation: string | undefined;
  const worker = http.createServer((request, response) => {
    generation = request.headers[PROVISIONING_GENERATION_HEADER] as string | undefined;
    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "pending" }));
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
  if (options.provisioningEnabled) process.env.PROVISION_SYNC = "1";
  const gateway = createApp({
    userWorkerProxy: new UserWorkerProxy(provisioner, 30_000, `${stateBlocker}/generation`),
  }).listen(0);
  await new Promise<void>((resolve) => gateway.once("listening", resolve));

  try {
    const port = (gateway.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/v1/auth/fake/sessions`, {
      method: "POST",
      headers: {
	authorization: "Bearer admin-key-123456",
	"content-type": "application/json",
	"x-cli-proxy-user-key": "user-key-12345678",
      },
      body: JSON.stringify(options.body),
    });
    await response.arrayBuffer();
    return { status: response.status, generation };
  } finally {
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await new Promise<void>((resolve) => worker.close(() => resolve()));
    await rm(socketPath, { force: true });
    await rm(stateBlocker, { force: true });
  }
}

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

test("ordinary auth sessions do not require writable provisioning generation state", async () => {
  const result = await forwardAuthCreateWithBlockedGenerationState({
    provisioningEnabled: true,
    body: { flow: "device-code" },
  });
  assert.equal(result.status, 201);
  assert.equal(result.generation, undefined);
});

test("gateway withholds a successful provisioning session when its binding cannot be persisted", async () => {
  const socketPath = `/tmp/cap-worker-${randomUUID().slice(0, 8)}.sock`;
  const generationStateFile = `/tmp/cap-generation-${randomUUID().slice(0, 8)}.state`;
  let workerSessionCreated = false;
  const worker = http.createServer(async (_request, response) => {
    await rm(`${generationStateFile}.issued`, { force: true });
    await mkdir(`${generationStateFile}.issued`);
    workerSessionCreated = true;
    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify({
      sessionId: "unbound-session",
      status: "pending",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    }));
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
  process.env.PROVISION_SYNC = "1";
  const gateway = createApp({
    userWorkerProxy: new UserWorkerProxy(provisioner, 30_000, generationStateFile),
    onAuthorizedProvisioningUrl: () => {},
  }).listen(0);
  await new Promise<void>((resolve) => gateway.once("listening", resolve));

  try {
    const port = (gateway.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/v1/auth/fake/sessions`, {
      method: "POST",
      headers: {
	authorization: "Bearer admin-key-123456",
	"content-type": "application/json",
	"x-cli-proxy-user-key": "user-key-12345678",
      },
      body: JSON.stringify({
	provisioning_url: "https://collavre.test/agents/vrex/provision.json",
      }),
    });
    assert.equal(workerSessionCreated, true);
    assert.equal(response.status, 503);
    const payload = await response.json() as { error: { code: string } };
    assert.equal(payload.error.code, "worker_unavailable");
    assert.equal(JSON.stringify(payload).includes("unbound-session"), false);
  } finally {
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await new Promise<void>((resolve) => worker.close(() => resolve()));
    await rm(socketPath, { force: true });
    await rm(generationStateFile, { force: true });
    await rm(`${generationStateFile}.issued`, { force: true, recursive: true });
  }
});

test("gateway preserves live provisioning bindings and reuses only expired capacity", async () => {
  const socketPath = `/tmp/cap-worker-${randomUUID().slice(0, 8)}.sock`;
  const generationStateFile = `/tmp/cap-generation-${randomUUID().slice(0, 8)}.state`;
  const manifestUrl = "https://collavre.test/agents/vrex/provision.json";
  const liveExpiresAt = Date.now() + 600_000;
  const bindings = Array.from({ length: 512 }, (_, index) => ({
    generation: `019865f4-50d6-7000-8000-${index.toString(16).padStart(12, "0")}`,
    urlHash: provisioningUrlHash(manifestUrl),
    accountName: "cap_0123456789abcdef0123",
    engine: "fake",
    sessionId: `session-${index}`,
    expiresAt: liveExpiresAt,
  }));
  await writeFile(`${generationStateFile}.issued`, JSON.stringify({
    version: 1,
    latestGeneration: bindings.at(-1)!.generation,
    bindings,
  }));

  let workerRequests = 0;
  const worker = http.createServer((_request, response) => {
    workerRequests += 1;
    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify({
      sessionId: "new-session",
      status: "pending",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    }));
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
  process.env.PROVISION_SYNC = "1";
  const headers = {
    authorization: "Bearer admin-key-123456",
    "content-type": "application/json",
    "x-cli-proxy-user-key": "user-key-12345678",
  };
  let gateway: http.Server | undefined;
  const startGateway = async () => {
    gateway = createApp({
      userWorkerProxy: new UserWorkerProxy(provisioner, 30_000, generationStateFile),
      onAuthorizedProvisioningUrl: () => {},
    }).listen(0);
    await new Promise<void>((resolve) => gateway!.once("listening", resolve));
    return (gateway.address() as AddressInfo).port;
  };
  const stopGateway = async () => {
    if (gateway) await new Promise<void>((resolve) => gateway!.close(() => resolve()));
    gateway = undefined;
  };

  try {
    let port = await startGateway();
    const atCapacity = await fetch(`http://127.0.0.1:${port}/v1/auth/fake/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ provisioning_url: manifestUrl }),
    });
    assert.equal(atCapacity.status, 503);
    assert.equal(workerRequests, 0, "capacity must be reserved before forwarding a create");
    await stopGateway();

    const stored = JSON.parse(await readFile(`${generationStateFile}.issued`, "utf8")) as {
      bindings: Array<{ generation: string; expiresAt: number }>;
    };
    assert.equal(stored.bindings.length, 512);
    assert.equal(stored.bindings[0]!.generation, bindings[0]!.generation);
    stored.bindings[0]!.expiresAt = Date.now() - 1;
    await writeFile(`${generationStateFile}.issued`, JSON.stringify({
      version: 1,
      latestGeneration: bindings.at(-1)!.generation,
      bindings: stored.bindings,
    }));

    port = await startGateway();
    const afterExpiry = await fetch(`http://127.0.0.1:${port}/v1/auth/fake/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ provisioning_url: manifestUrl }),
    });
    assert.equal(afterExpiry.status, 201);
    assert.equal(workerRequests, 1);
    await afterExpiry.arrayBuffer();
    const after = JSON.parse(await readFile(`${generationStateFile}.issued`, "utf8")) as {
      bindings: Array<{ generation: string }>;
    };
    assert.equal(after.bindings.length, 512);
    assert.equal(after.bindings.some(({ generation }) => generation === bindings[0]!.generation), false);
    assert.equal(after.bindings.some(({ generation }) => generation === bindings[1]!.generation), true);
  } finally {
    await stopGateway();
    await new Promise<void>((resolve) => worker.close(() => resolve()));
    await rm(socketPath, { force: true });
    await rm(generationStateFile, { force: true });
    await rm(`${generationStateFile}.issued`, { force: true });
  }
});

test("gateway releases provisional bindings when worker session creation fails", async () => {
  const socketPath = `/tmp/cap-worker-${randomUUID().slice(0, 8)}.sock`;
  const generationStateFile = `/tmp/cap-generation-${randomUUID().slice(0, 8)}.state`;
  let createAttempts = 0;
  const worker = http.createServer((_request, response) => {
    createAttempts += 1;
    if (createAttempts === 1) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "unsupported_flow" } }));
      return;
    }
    if (createAttempts === 2) {
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "pending" }));
      return;
    }
    if (createAttempts === 3) {
      response.destroy();
      return;
    }
    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify({
      sessionId: "accepted",
      status: "pending",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    }));
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
  process.env.PROVISION_SYNC = "1";
  const gateway = createApp({
    userWorkerProxy: new UserWorkerProxy(provisioner, 30_000, generationStateFile),
    onAuthorizedProvisioningUrl: () => {},
  }).listen(0);
  await new Promise<void>((resolve) => gateway.once("listening", resolve));

  try {
    const port = (gateway.address() as AddressInfo).port;
    const create = () => fetch(`http://127.0.0.1:${port}/v1/auth/fake/sessions`, {
      method: "POST",
      headers: {
	authorization: "Bearer admin-key-123456",
	"content-type": "application/json",
	"x-cli-proxy-user-key": "user-key-12345678",
      },
      body: JSON.stringify({
	provisioning_url: "https://collavre.test/agents/vrex/provision.json",
      }),
    });
    for (const expectedStatus of [400, 503, 503]) {
      const response = await create();
      assert.equal(response.status, expectedStatus);
      await response.arrayBuffer();
      const state = JSON.parse(await readFile(`${generationStateFile}.issued`, "utf8")) as {
	bindings: unknown[];
      };
      assert.equal(state.bindings.length, 0);
    }

    const accepted = await create();
    assert.equal(accepted.status, 201);
    const state = JSON.parse(await readFile(`${generationStateFile}.issued`, "utf8")) as {
      bindings: Array<{ sessionId?: string }>;
    };
    assert.deepEqual(state.bindings.map(({ sessionId }) => sessionId), ["accepted"]);
  } finally {
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await new Promise<void>((resolve) => worker.close(() => resolve()));
    await rm(socketPath, { force: true });
    await rm(generationStateFile, { force: true });
    await rm(`${generationStateFile}.issued`, { force: true });
  }
});

test("gateway shares its auth session TTL with provisioning workers", async () => {
  const socketPath = `/tmp/cap-worker-${randomUUID().slice(0, 8)}.sock`;
  const generationStateFile = `/tmp/cap-generation-${randomUUID().slice(0, 8)}.state`;
  let receivedTtl: string | undefined;
  const worker = http.createServer((request, response) => {
    receivedTtl = request.headers[PROVISIONING_SESSION_TTL_HEADER] as string | undefined;
    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify({
      sessionId: "shared-ttl",
      status: "pending",
      expiresAt: new Date(Date.now() + Number(receivedTtl)).toISOString(),
    }));
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
  process.env.PROVISION_SYNC = "1";
  process.env.AUTH_SESSION_TTL_MS = "300000";
  const gateway = createApp({
    userWorkerProxy: new UserWorkerProxy(provisioner, 30_000, generationStateFile),
    onAuthorizedProvisioningUrl: () => {},
  }).listen(0);
  await new Promise<void>((resolve) => gateway.once("listening", resolve));

  try {
    const port = (gateway.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/v1/auth/fake/sessions`, {
      method: "POST",
      headers: {
	authorization: "Bearer admin-key-123456",
	"content-type": "application/json",
	"x-cli-proxy-user-key": "user-key-12345678",
      },
      body: JSON.stringify({
	provisioning_url: "https://collavre.test/agents/vrex/provision.json",
      }),
    });
    assert.equal(response.status, 201);
    assert.equal(receivedTtl, "300000");
  } finally {
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await new Promise<void>((resolve) => worker.close(() => resolve()));
    await rm(socketPath, { force: true });
    await rm(generationStateFile, { force: true });
    await rm(`${generationStateFile}.issued`, { force: true });
  }
});

test("disabled provisioning ignores auth URLs without writing generation state", async () => {
  const result = await forwardAuthCreateWithBlockedGenerationState({
    provisioningEnabled: false,
    body: { provisioning_url: "https://collavre.test/agents/vrex/provision.json" },
  });
  assert.equal(result.status, 201);
  assert.equal(result.generation, undefined);
});

test("unaccepted and pending provisioning sessions do not supersede retained notifications", async () => {
  const socketPath = `/tmp/cap-worker-${randomUUID().slice(0, 8)}.sock`;
  const generationStateFile = `/tmp/cap-generation-${randomUUID().slice(0, 8)}.state`;
  const retainedGeneration = "019865f4-50d6-7000-8000-000000000001";
  const retainedUrl = "https://collavre.test/agents/vrex/retained.json";
  await writeFile(generationStateFile, `${retainedGeneration}\n`);
  await seedIssuedBinding(generationStateFile, {
    generation: retainedGeneration,
    url: retainedUrl,
    sessionId: "retained",
  });
  let rejectedGeneration: string | undefined;
  let acceptedGeneration: string | undefined;
  let createAttempts = 0;
  const worker = http.createServer((request, response) => {
    if (request.method === "POST") {
      const generation = request.headers[PROVISIONING_GENERATION_HEADER] as string | undefined;
      if (createAttempts++ === 0) {
	rejectedGeneration = generation;
	response.writeHead(400, { "content-type": "application/json" });
	response.end(JSON.stringify({ error: { code: "unsupported_flow" } }));
	return;
      }
      acceptedGeneration = generation;
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({
	sessionId: "accepted",
	status: "pending",
	expiresAt: new Date(Date.now() + 600_000).toISOString(),
      }));
      return;
    }
    response.writeHead(200, {
      "content-type": "application/json",
      [AUTHORIZED_PROVISIONING_HEADER]: encodeProvisioningUrl(retainedUrl),
      [PROVISIONING_GENERATION_HEADER]: retainedGeneration,
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
  process.env.PROVISION_SYNC = "1";
  const notifications: string[] = [];
  const gateway = createApp({
    userWorkerProxy: new UserWorkerProxy(provisioner, 30_000, generationStateFile),
    onAuthorizedProvisioningUrl: (url) => { notifications.push(url); },
  }).listen(0);
  await new Promise<void>((resolve) => gateway.once("listening", resolve));

  try {
    const port = (gateway.address() as AddressInfo).port;
    const headers = {
      authorization: "Bearer admin-key-123456",
      "content-type": "application/json",
      "x-cli-proxy-user-key": "user-key-12345678",
    };
    const rejected = await fetch(`http://127.0.0.1:${port}/v1/auth/fake/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ provisioning_url: "https://collavre.test/agents/vrex/new.json" }),
    });
    assert.equal(rejected.status, 400);
    assert.ok(rejectedGeneration && rejectedGeneration > retainedGeneration);
    assert.equal((await readFile(generationStateFile, "utf8")).trim(), retainedGeneration);

    const retained = await fetch(`http://127.0.0.1:${port}/v1/auth/fake/sessions/retained`, { headers });
    await retained.arrayBuffer();
    assert.deepEqual(notifications, [retainedUrl]);

    const accepted = await fetch(`http://127.0.0.1:${port}/v1/auth/fake/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ provisioning_url: "https://collavre.test/agents/vrex/retry.json" }),
    });
    assert.equal(accepted.status, 201);
    assert.ok(acceptedGeneration && rejectedGeneration && acceptedGeneration > rejectedGeneration);
    assert.equal((await readFile(generationStateFile, "utf8")).trim(), retainedGeneration);
    assert.equal(await latestIssuedGeneration(generationStateFile), acceptedGeneration);

    const retainedAfterPending = await fetch(
      `http://127.0.0.1:${port}/v1/auth/fake/sessions/retained`,
      { headers },
    );
    await retainedAfterPending.arrayBuffer();
    assert.deepEqual(notifications, [retainedUrl, retainedUrl]);
  } finally {
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await new Promise<void>((resolve) => worker.close(() => resolve()));
    await rm(socketPath, { force: true });
    await rm(generationStateFile, { force: true });
    await rm(`${generationStateFile}.issued`, { force: true });
  }
});

test("a policy-rejected provisioning URL does not supersede retained notifications", async () => {
  const socketPath = `/tmp/cap-worker-${randomUUID().slice(0, 8)}.sock`;
  const generationStateFile = `/tmp/cap-generation-${randomUUID().slice(0, 8)}.state`;
  const retainedGeneration = "019865f4-50d6-7000-8000-000000000001";
  const rejectedNotificationGeneration = "019865f4-50d6-7000-8000-000000000002";
  const retainedUrl = "https://collavre.test/agents/vrex/retained.json";
  await writeFile(generationStateFile, `${retainedGeneration}\n`);
  await seedIssuedBinding(generationStateFile, {
    generation: retainedGeneration,
    url: retainedUrl,
    sessionId: "retained",
  });
  let rejectedGeneration: string | undefined;
  const worker = http.createServer((request, response) => {
    if (request.method === "POST") {
      rejectedGeneration = request.headers[PROVISIONING_GENERATION_HEADER] as string | undefined;
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({
	sessionId: "rejected",
	status: "pending",
	expiresAt: new Date(Date.now() + 600_000).toISOString(),
      }));
      return;
    }
    const invalidNotification = request.url?.endsWith("/rejected") ?? false;
    response.writeHead(200, {
      "content-type": "application/json",
      [AUTHORIZED_PROVISIONING_HEADER]: encodeProvisioningUrl(
	invalidNotification ? "https://excluded.test/provision.json" : retainedUrl,
      ),
      [PROVISIONING_GENERATION_HEADER]: invalidNotification
	? rejectedNotificationGeneration
	: retainedGeneration,
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
  process.env.PROVISION_SYNC = "1";
  process.env.PROVISION_ALLOWLIST = "collavre.test";
  const notifications: string[] = [];
  const gateway = createApp({
    userWorkerProxy: new UserWorkerProxy(provisioner, 30_000, generationStateFile),
    onAuthorizedProvisioningUrl: (url) => { notifications.push(url); },
  }).listen(0);
  await new Promise<void>((resolve) => gateway.once("listening", resolve));

  try {
    const port = (gateway.address() as AddressInfo).port;
    const headers = {
      authorization: "Bearer admin-key-123456",
      "content-type": "application/json",
      "x-cli-proxy-user-key": "user-key-12345678",
    };
    const rejected = await fetch(`http://127.0.0.1:${port}/v1/auth/fake/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ provisioning_url: "https://excluded.test/provision.json" }),
    });
    assert.equal(rejected.status, 201);
    assert.equal(rejectedGeneration, undefined);
    assert.equal((await readFile(generationStateFile, "utf8")).trim(), retainedGeneration);

    const rejectedPoll = await fetch(`http://127.0.0.1:${port}/v1/auth/fake/sessions/rejected`, { headers });
    await rejectedPoll.arrayBuffer();
    assert.deepEqual(notifications, []);
    assert.equal((await readFile(generationStateFile, "utf8")).trim(), retainedGeneration);

    const retained = await fetch(`http://127.0.0.1:${port}/v1/auth/fake/sessions/retained`, { headers });
    await retained.arrayBuffer();
    assert.deepEqual(notifications, [retainedUrl]);
  } finally {
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await new Promise<void>((resolve) => worker.close(() => resolve()));
    await rm(socketPath, { force: true });
    await rm(generationStateFile, { force: true });
    await rm(`${generationStateFile}.issued`, { force: true });
  }
});

test("gateway consumes a worker provisioning notification without exposing its private header", async () => {
  const socketPath = `/tmp/cap-worker-${randomUUID().slice(0, 8)}.sock`;
  const generationStateFile = `/tmp/cap-generation-${randomUUID().slice(0, 8)}.state`;
  const manifestUrl = "https://collavre.test/agents/vrex/provision.json?token=secret";
  let generation: string | undefined;
  const worker = http.createServer((request, response) => {
    if (request.method === "POST") {
      generation = request.headers[PROVISIONING_GENERATION_HEADER] as string | undefined;
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({
	sessionId: "session-1",
	status: "pending",
	expiresAt: new Date(Date.now() + 600_000).toISOString(),
      }));
      return;
    }
    response.writeHead(200, {
      "content-type": "application/json",
      [AUTHORIZED_PROVISIONING_HEADER]: encodeProvisioningUrl(manifestUrl),
      [PROVISIONING_GENERATION_HEADER]: generation!,
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
  process.env.PROVISION_SYNC = "1";
  const notifications: string[] = [];
  const gateway = createApp({
    userWorkerProxy: new UserWorkerProxy(provisioner, 30_000, generationStateFile),
    onAuthorizedProvisioningUrl: (url) => { notifications.push(url); },
  }).listen(0);
  await new Promise<void>((resolve) => gateway.once("listening", resolve));

  try {
    const port = (gateway.address() as AddressInfo).port;
    const headers = {
	  authorization: "Bearer admin-key-123456",
	  "content-type": "application/json",
	  "x-cli-proxy-user-key": "user-key-12345678",
	};
    const created = await fetch(`http://127.0.0.1:${port}/v1/auth/fake/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ provisioning_url: manifestUrl }),
    });
    assert.equal(created.status, 201);
    await created.arrayBuffer();
    assert.ok(generation);
    const response = await fetch(`http://127.0.0.1:${port}/v1/auth/fake/sessions/session-1`, {
      headers,
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
    await rm(generationStateFile, { force: true });
    await rm(`${generationStateFile}.issued`, { force: true });
  }
});

test("gateway rejects worker notifications outside their issued URL, worker, and session binding", async () => {
  const socketPath = `/tmp/cap-worker-${randomUUID().slice(0, 8)}.sock`;
  const generationStateFile = `/tmp/cap-generation-${randomUUID().slice(0, 8)}.state`;
  const manifestUrl = "https://collavre.test/agents/vrex/provision.json?token=secret";
  const forgedUrl = "https://attacker.test/arbitrary.json";
  let issuedGeneration: string | undefined;
  let responseGeneration: string | undefined;
  let responseUrl = manifestUrl;
  let accountName = "cap_worker_a";
  const worker = http.createServer((request, response) => {
    if (request.method === "POST" && request.url === "/v1/auth/fake/sessions") {
      issuedGeneration = request.headers[PROVISIONING_GENERATION_HEADER] as string | undefined;
      responseGeneration = issuedGeneration;
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({
	sessionId: "session-1",
	status: "pending",
	expiresAt: new Date(Date.now() + 600_000).toISOString(),
      }));
      return;
    }
    response.writeHead(200, {
      "content-type": "application/json",
      [AUTHORIZED_PROVISIONING_HEADER]: encodeProvisioningUrl(responseUrl),
      [PROVISIONING_GENERATION_HEADER]: responseGeneration!,
    });
    response.end(JSON.stringify({ status: "authorized" }));
  });
  await new Promise<void>((resolve) => worker.listen(socketPath, resolve));

  const provisioner: WorkerProvisioner = {
    async ensureWorker() {
      return { accountName, endpoint: { kind: "unix", address: socketPath } };
    },
  };
  process.env.USER_API_KEYS = JSON.stringify([
    { key: "user-key-12345678", tenantId: "tenant-a", userId: "user-a" },
  ]);
  process.env.AUTH_ADMIN_KEYS = "admin-key-123456";
  process.env.PROVISION_SYNC = "1";
  const notifications: string[] = [];
  const gateway = createApp({
    userWorkerProxy: new UserWorkerProxy(provisioner, 30_000, generationStateFile),
    onAuthorizedProvisioningUrl: (url) => { notifications.push(url); },
  }).listen(0);
  await new Promise<void>((resolve) => gateway.once("listening", resolve));

  try {
    const port = (gateway.address() as AddressInfo).port;
    const headers = {
      authorization: "Bearer admin-key-123456",
      "content-type": "application/json",
      "x-cli-proxy-user-key": "user-key-12345678",
    };
    const request = async (pathname: string, options: RequestInit = {}) => {
      const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { headers, ...options });
      await response.arrayBuffer();
    };
    await request("/v1/auth/fake/sessions", {
      method: "POST",
      body: JSON.stringify({ provisioning_url: manifestUrl }),
    });
    assert.ok(issuedGeneration);

    responseUrl = forgedUrl;
    await request("/v1/chat/completions", { method: "POST", body: "{}" });
    await request("/v1/auth/fake/sessions/session-1");
    assert.deepEqual(notifications, [], "route and URL mismatches must not authorize relay");

    responseUrl = manifestUrl;
    responseGeneration = "ffffffff-ffff-7fff-bfff-ffffffffffff";
    await request("/v1/auth/fake/sessions/session-1");
    assert.deepEqual(notifications, [], "unissued future generations must not advance the watermark");

    responseGeneration = issuedGeneration;
    accountName = "cap_worker_b";
    await request("/v1/auth/fake/sessions/session-1");
    assert.deepEqual(notifications, [], "another worker must not consume the binding");

    accountName = "cap_worker_a";
    await request("/v1/auth/fake/sessions/session-1");
    assert.deepEqual(notifications, [manifestUrl]);
  } finally {
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await new Promise<void>((resolve) => worker.close(() => resolve()));
    await rm(socketPath, { force: true });
    await rm(generationStateFile, { force: true });
    await rm(`${generationStateFile}.issued`, { force: true });
  }
});

test("gateway persists issued and authorized notification ordering separately across restart", async () => {
  const socketPath = `/tmp/cap-worker-${randomUUID().slice(0, 8)}.sock`;
  const generationStateFile = `/tmp/cap-generation-${randomUUID().slice(0, 8)}.state`;
  const persistedGeneration = "0fffffff-ffff-7fff-bfff-ffffffffffff";
  await writeFile(generationStateFile, `${persistedGeneration}\n`);
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
      response.end(JSON.stringify({
	sessionId,
	status: "pending",
	expiresAt: new Date(Date.now() + 600_000).toISOString(),
      }));
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
  process.env.PROVISION_SYNC = "1";
  const notifications: string[] = [];
  let gateway: http.Server | undefined = createApp({
    userWorkerProxy: new UserWorkerProxy(provisioner, 30_000, generationStateFile),
    onAuthorizedProvisioningUrl: (url) => { notifications.push(url); },
  }).listen(0);
  await new Promise<void>((resolve) => gateway!.once("listening", resolve));

  try {
    let port = (gateway.address() as AddressInfo).port;
    const headers = {
      authorization: "Bearer admin-key-123456",
      "content-type": "application/json",
      [PROVISIONING_GENERATION_HEADER]: "ffffffff-ffff-7fff-bfff-ffffffffffff",
      "x-cli-proxy-user-key": "user-key-12345678",
    };
    const create = (provisioningUrl: string) => fetch(`http://127.0.0.1:${port}/v1/auth/fake/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ provisioning_url: provisioningUrl }),
    }).then((response) => response.json() as Promise<{ sessionId: string }>);
    const first = await create(urls.get("session-a")!);
    const second = await create(urls.get("session-b")!);
    assert.notEqual(generations.get(first.sessionId), headers[PROVISIONING_GENERATION_HEADER]);
    assert.ok(persistedGeneration < generations.get(first.sessionId)!);
    assert.ok(generations.get(first.sessionId)! < generations.get(second.sessionId)!);
    assert.equal((await readFile(generationStateFile, "utf8")).trim(), persistedGeneration);
    assert.equal(await latestIssuedGeneration(generationStateFile), generations.get(second.sessionId));

    const poll = async (sessionId: string) => {
      const response = await fetch(`http://127.0.0.1:${port}/v1/auth/fake/sessions/${sessionId}`, { headers });
      await response.arrayBuffer();
    };
    await new Promise<void>((resolve) => gateway!.close(() => resolve()));
    gateway = undefined;
    gateway = createApp({
      userWorkerProxy: new UserWorkerProxy(provisioner, 30_000, generationStateFile),
      onAuthorizedProvisioningUrl: (url) => { notifications.push(url); },
    }).listen(0);
    await new Promise<void>((resolve) => gateway!.once("listening", resolve));
    port = (gateway.address() as AddressInfo).port;

    await poll(first.sessionId);
    assert.deepEqual(notifications, [urls.get(first.sessionId)]);
    assert.equal((await readFile(generationStateFile, "utf8")).trim(), generations.get(first.sessionId));

    await poll(second.sessionId);
    assert.deepEqual(notifications, [urls.get(first.sessionId), urls.get(second.sessionId)]);
    assert.equal((await readFile(generationStateFile, "utf8")).trim(), generations.get(second.sessionId));

    await new Promise<void>((resolve) => gateway!.close(() => resolve()));
    gateway = undefined;
    gateway = createApp({
      userWorkerProxy: new UserWorkerProxy(provisioner, 30_000, generationStateFile),
      onAuthorizedProvisioningUrl: (url) => { notifications.push(url); },
    }).listen(0);
    await new Promise<void>((resolve) => gateway!.once("listening", resolve));
    port = (gateway.address() as AddressInfo).port;

    await poll(second.sessionId);
    await poll(first.sessionId);

    assert.deepEqual(notifications, [
      urls.get(first.sessionId),
      urls.get(second.sessionId),
      urls.get(second.sessionId),
    ]);
  } finally {
    if (gateway) await new Promise<void>((resolve) => gateway!.close(() => resolve()));
    await new Promise<void>((resolve) => worker.close(() => resolve()));
    await rm(socketPath, { force: true });
    await rm(generationStateFile, { force: true });
    await rm(`${generationStateFile}.issued`, { force: true });
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
