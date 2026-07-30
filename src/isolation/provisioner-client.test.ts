import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { afterEach, test } from "node:test";
import { IpcProvisionerClient, createPlatformProvisioner } from "./provisioner-client.js";
import { startProvisionerServer, type UserProvisioningService } from "./provisioner-server.js";
import { WorkerIsolationError } from "./types.js";

let socketPath: string | undefined;

afterEach(async () => {
  if (socketPath) await rm(socketPath, { force: true });
  socketPath = undefined;
});

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
