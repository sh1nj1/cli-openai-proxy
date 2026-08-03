import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { gzipSync } from "node:zlib";
import { resetCapturedProxySecrets } from "../config.js";
import { engineRegistry } from "../auth/registry.js";
import { resetSessions } from "../auth/session-manager.js";
import { resetRequestIdentityForTests } from "../isolation/request-identity.js";
import type { WorkerProvisioner } from "../isolation/types.js";
import { UserWorkerProxy } from "../isolation/worker-proxy.js";
import type { EngineAuthDescriptor, EngineAuthSession } from "../auth/types.js";
import { resetProvisioning } from "../provision/sync.js";
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

/**
 * Minimal single-file tar.gz — same construction as provision/sync.test.ts's
 * fixture helper (not exported from there, so reproduced here).
 */
function skillArchive(content: string, fileName = "SKILL.md"): Buffer {
  const body = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(fileName, 0, 100, "utf-8");
  header.write("0000644", 100, 8, "ascii");
  header.write("0000000", 108, 8, "ascii");
  header.write("0000000", 116, 8, "ascii");
  header.write(body.length.toString(8).padStart(11, "0"), 124, 12, "ascii");
  header.write("00000000000", 136, 12, "ascii");
  header.write("        ", 148, 8, "ascii");
  header.write("0", 156, 1, "ascii");
  header.write("ustar", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  body.copy(padded);
  return gzipSync(Buffer.concat([header, padded, Buffer.alloc(1024)]));
}

const sha256Hex = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

/** Serves a real provisioning manifest + skill tarball over 127.0.0.1, like sync.test.ts. */
async function startManifestServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const archive = skillArchive("watch the demo");
  const manifest = {
    schema: "agent-provisioning/v1",
    items: [{
      type: "skill",
      name: "demo-skill",
      url: "PLACEHOLDER/demo-skill.tgz",
      sha256: sha256Hex(archive),
    }],
  };
  const server = http.createServer((req, res) => {
    if (req.url === "/provision.json") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(manifest));
      return;
    }
    if (req.url === "/demo-skill.tgz") {
      res.end(archive);
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  manifest.items[0]!.url = `${baseUrl}/demo-skill.tgz`;
  return {
    baseUrl,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

class FakeAuthSession implements EngineAuthSession {
  async start() {
    return { verificationUrl: "https://example.test/authorize", instructions: "open it" };
  }
  async submit(_input: string) {
    return {};
  }
  cancel() {}
}

const fakeAuthDescriptor: EngineAuthDescriptor = {
  engine: "fake",
  flows: [{ flow: "paste-code", createSession: () => new FakeAuthSession() }],
  checkStatus: async () => ({ state: "unknown" }),
};

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("authorized login installs into the worker's own state dirs only", async () => {
  // Full HTTP-driven form: a real worker-role app, driven through the same
  // /v1/auth session endpoints a Collavre client would call, with the fake
  // engine wired in the same way auth-routes.test.ts drives authorization.
  const workerAStateDir = mkdtempSync(path.join(tmpdir(), "worker-a-state-"));
  const workerASkillsDir = mkdtempSync(path.join(tmpdir(), "worker-a-skills-"));
  const gatewayStateDir = mkdtempSync(path.join(tmpdir(), "gateway-state-"));

  const savedEnv = new Map<string, string | undefined>();
  for (const name of [
    "PROVISION_SYNC", "PROVISION_AUTOAPPLY", "PROVISION_STATE_DIR",
    "PROVISION_SKILLS_DIR", "PROVISION_ALLOWLIST",
  ] as const) {
    savedEnv.set(name, process.env[name]);
  }

  const realResolve = engineRegistry.resolve;
  const realIds = engineRegistry.ids;
  engineRegistry.resolve = (engine) => (engine === "fake" ? fakeAuthDescriptor : realResolve(engine));
  engineRegistry.ids = () => ["fake", ...realIds()];

  const manifestServer = await startManifestServer();
  let close: (() => Promise<void>) | undefined;

  try {
    process.env.PROVISION_SYNC = "1";
    process.env.PROVISION_AUTOAPPLY = "auto";
    process.env.PROVISION_STATE_DIR = workerAStateDir;
    process.env.PROVISION_SKILLS_DIR = workerASkillsDir;
    process.env.PROVISION_ALLOWLIST = "127.0.0.1";

    const worker = createApp({ role: "worker" }).listen(0);
    await new Promise<void>((resolve) => worker.once("listening", resolve));
    const port = (worker.address() as AddressInfo).port;
    close = () => new Promise<void>((resolve) => worker.close(() => resolve()));

    const created = await fetch(`http://127.0.0.1:${port}/v1/auth/fake/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provisioning_url: `${manifestServer.baseUrl}/provision.json` }),
    });
    assert.equal(created.status, 201);
    const { sessionId } = await created.json() as { sessionId: string };

    const submitted = await fetch(`http://127.0.0.1:${port}/v1/auth/fake/sessions/${sessionId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "code" }),
    });
    assert.equal(submitted.status, 200);
    const submittedView = await submitted.json() as { status: string };
    assert.equal(submittedView.status, "authorized");
    // The worker never echoes a provisioning header back once its own engine
    // is enabled — the notification is applied locally instead of upward.
    assert.equal(submitted.headers.has("x-cli-proxy-authorized-provisioning"), false);

    // handleAuthorizedSession runs fire-and-forget off the submit response, so
    // the skill install lands asynchronously.
    await waitFor(() => existsSync(path.join(workerASkillsDir, "demo-skill", "SKILL.md")));

    assert.ok(existsSync(path.join(workerASkillsDir, "demo-skill", "SKILL.md")));
    assert.ok(existsSync(path.join(workerAStateDir, "provision.lock.json")));
    assert.ok(existsSync(path.join(workerAStateDir, "manifest.key")));
    // Nothing about this login touches the separate gateway-scoped dir.
    assert.ok(!existsSync(path.join(gatewayStateDir, "provision.lock.json")));
  } finally {
    if (close) await close();
    await manifestServer.close();
    resetSessions();
    resetProvisioning();
    engineRegistry.resolve = realResolve;
    engineRegistry.ids = realIds;
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name as string];
      else process.env[name as string] = value;
    }
    await Promise.all([workerAStateDir, workerASkillsDir, gatewayStateDir].map((dir) =>
      rm(dir, { recursive: true, force: true })));
  }
});
