import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import http, { type Server } from "node:http";
import { afterEach, test } from "node:test";
import { IpcProvisionerClient, createPlatformProvisioner } from "./provisioner-client.js";
import {
  createProvisionerApp,
  startProvisionerServer,
  type UserProvisioningService,
} from "./provisioner-server.js";
import { WorkerIsolationError } from "./types.js";

let socketPath: string | undefined;
let openServer: Server | undefined;

afterEach(async () => {
  if (openServer) {
    await new Promise<void>((resolve) => openServer!.close(() => resolve()));
    openServer = undefined;
  }
  if (socketPath) await rm(socketPath, { force: true });
  socketPath = undefined;
});

async function listen(server: Server): Promise<string> {
  socketPath = `/tmp/cap-prov-${randomUUID().slice(0, 8)}.sock`;
  openServer = server;
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath!);
  });
  return socketPath;
}

test("provisioner client exchanges a typed target over a Unix socket", async () => {
  socketPath = `/tmp/cap-prov-${randomUUID().slice(0, 8)}.sock`;
  const service: UserProvisioningService = {
    async ensureWorker(identity) {
      assert.deepEqual(identity, { tenantId: "tenant-a", userId: "user-a" });
      return {
        accountName: "cap_0123456789abcdef0123",
        uid: 1201,
        gid: 1202,
        home: "/var/lib/cli-openai-proxy/users/cap_0123456789abcdef0123",
        endpoint: { kind: "unix", address: "/run/worker.sock" },
      };
    },
  };
  const server = await startProvisionerServer(service, { path: socketPath });
  try {
    const client = new IpcProvisionerClient({ kind: "unix", address: socketPath });
    const target = await client.ensureWorker({ tenantId: "tenant-a", userId: "user-a" });
    assert.equal(target.uid, 1201);
    assert.deepEqual(target.endpoint, { kind: "unix", address: "/run/worker.sock" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("platform factory fails closed where no OS adapter exists", () => {
  assert.throws(
    () => createPlatformProvisioner("darwin"),
    (error) => error instanceof WorkerIsolationError && error.code === "platform_unsupported",
  );
});

test("provisioner server logs details but returns a normalized error", async () => {
  const endpoint = await listen(http.createServer(createProvisionerApp({
    async ensureWorker() {
      throw new Error("account quota reached");
    },
  })));
  const client = new IpcProvisionerClient({ kind: "unix", address: endpoint });
  await assert.rejects(
    client.ensureWorker({ tenantId: "tenant-a", userId: "user-a" }),
    (error) =>
      error instanceof WorkerIsolationError
      && error.code === "provisioning_failed"
      && error.message === "Provisioning failed",
  );
});

test("provisioner client rejects malformed JSON and invalid targets", async () => {
  let responseBody = "{";
  const endpoint = await listen(http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(responseBody);
  }));
  const client = new IpcProvisionerClient({ kind: "unix", address: endpoint });
  await assert.rejects(
    client.ensureWorker({ tenantId: "tenant-a", userId: "user-a" }),
    (error) => error instanceof WorkerIsolationError && error.message.includes("malformed JSON"),
  );

  responseBody = JSON.stringify({ accountName: 123, endpoint: { kind: "tcp", address: "" } });
  await assert.rejects(
    client.ensureWorker({ tenantId: "tenant-a", userId: "user-a" }),
    (error) => error instanceof WorkerIsolationError && error.message.includes("invalid worker target"),
  );
});

test("provisioner client fails closed when its IPC endpoint is unavailable", async () => {
  const missing = `/tmp/cap-prov-missing-${randomUUID().slice(0, 8)}.sock`;
  const client = new IpcProvisionerClient({ kind: "unix", address: missing }, 50);
  await assert.rejects(
    client.ensureWorker({ tenantId: "tenant-a", userId: "user-a" }),
    (error) => error instanceof WorkerIsolationError && error.code === "provisioner_unavailable",
  );
});

test("platform factory creates Linux and Windows IPC clients", () => {
  assert.ok(createPlatformProvisioner("linux", "/tmp/provisioner.sock") instanceof IpcProvisionerClient);
  assert.ok(createPlatformProvisioner("win32", "\\\\.\\pipe\\provisioner") instanceof IpcProvisionerClient);
});
