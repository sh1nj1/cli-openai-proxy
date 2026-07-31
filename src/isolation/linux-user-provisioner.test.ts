import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
  LinuxUserProvisioner,
  type LinuxProvisionerConfig,
  type LinuxProvisionerDeps,
} from "./linux-user-provisioner.js";

describe("LinuxUserProvisioner", () => {
  let temporary: string;
  let commands: Array<{ command: string; args: string[] }>;
  let accounts: Set<string>;
  let config: LinuxProvisionerConfig;
  let deps: LinuxProvisionerDeps;

  beforeEach(async () => {
    temporary = await mkdtemp(path.join(os.tmpdir(), "proxy-provisioner-test-"));
    commands = [];
    accounts = new Set();
    config = {
      identitySecret: Buffer.alloc(32, 7),
      stateFile: path.join(temporary, "state", "users.json"),
      usersDir: path.join(temporary, "users"),
      workerSocketDir: path.join(temporary, "run"),
      useraddPath: "/usr/sbin/useradd",
      idPath: "/usr/bin/id",
      systemctlPath: "/usr/bin/systemctl",
      workerUnitPrefix: "cli-openai-proxy-worker",
      maxUsers: 1000,
    };
    deps = {
      async run(command, args) {
        commands.push({ command, args });
        if (command === config.useraddPath) accounts.add(args.at(-1)!);
        if (command === config.idPath) {
          if (!accounts.has(args[1])) throw new Error("no such user");
          return { stdout: args[0] === "-u" ? "1201\n" : "1202\n" };
        }
        return { stdout: "" };
      },
      async secureHome() {},
      async readTextFile(file) { return readFile(file, "utf8"); },
      now: () => new Date("2026-07-30T00:00:00.000Z"),
    };
  });

  afterEach(async () => {
    await rm(temporary, { recursive: true, force: true });
  });

  test("creates one non-login account on concurrent first requests", async () => {
    const provisioner = new LinuxUserProvisioner(config, deps);
    const identity = { tenantId: "tenant-a", userId: "user-a" };
    const [first, second] = await Promise.all([
      provisioner.ensureWorker(identity),
      provisioner.ensureWorker(identity),
    ]);

    assert.deepEqual(first, second);
    assert.match(first.accountName, /^cap_[a-f0-9]{20}$/);
    assert.equal(first.endpoint.kind, "unix");
    assert.equal(commands.filter(({ command }) => command === config.useraddPath).length, 1);
    const useradd = commands.find(({ command }) => command === config.useraddPath)!;
    assert.deepEqual(useradd.args, [
      "--system",
      "--create-home",
      "--home-dir",
      first.home,
      "--shell",
      "/usr/sbin/nologin",
      "--user-group",
      first.accountName,
    ]);
    assert.equal(useradd.args.at(-1), first.accountName, "raw user identity must never become a command argument");
    assert.equal(
      commands.filter(({ command, args }) =>
        command === config.systemctlPath && args[1] === `cli-openai-proxy-worker@${first.accountName}.socket`).length,
      1,
    );
  });

  test("reuses persisted mapping and verifies the account UID/GID", async () => {
    const first = new LinuxUserProvisioner(config, deps);
    const target = await first.ensureWorker({ tenantId: "tenant-a", userId: "user-a" });
    commands.length = 0;

    const restarted = new LinuxUserProvisioner(config, deps);
    const reused = await restarted.ensureWorker({ tenantId: "tenant-a", userId: "user-a" });
    assert.deepEqual(reused, target);
    assert.equal(commands.some(({ command }) => command === config.useraddPath), false);
    assert.equal(commands.filter(({ command }) => command === config.idPath).length, 2);

    const state = JSON.parse(await readFile(config.stateFile, "utf8")) as { users: Record<string, unknown> };
    const serialized = JSON.stringify(state);
    assert.equal(serialized.includes("tenant-a"), false);
    assert.equal(serialized.includes("user-a"), false);
  });

  test("uses different accounts for the same user id in different tenants", async () => {
    const provisioner = new LinuxUserProvisioner(config, deps);
    const a = await provisioner.ensureWorker({ tenantId: "tenant-a", userId: "shared" });
    const b = await provisioner.ensureWorker({ tenantId: "tenant-b", userId: "shared" });
    assert.notEqual(a.accountName, b.accountName);
  });

  test("rejects shell syntax in identity before running a privileged command", async () => {
    const provisioner = new LinuxUserProvisioner(config, deps);
    assert.throws(
      () => provisioner.ensureWorker({ tenantId: "tenant-a", userId: "user-a;$(unsafe)" }),
      /tenantId and userId/,
    );
    assert.equal(commands.length, 0);
  });

  test("caps dynamically-created accounts", async () => {
    config.maxUsers = 1;
    const provisioner = new LinuxUserProvisioner(config, deps);
    await provisioner.ensureWorker({ tenantId: "tenant-a", userId: "user-a" });
    await assert.rejects(
      provisioner.ensureWorker({ tenantId: "tenant-a", userId: "user-b" }),
      /user limit \(1\) reached/,
    );
  });

  test("serializes mapping reservations for distinct first requests", async () => {
    let releaseRead!: () => void;
    let firstReadStarted!: () => void;
    let readCount = 0;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const firstRead = new Promise<void>((resolve) => { firstReadStarted = resolve; });
    const readTextFile = deps.readTextFile;
    deps.readTextFile = async (file) => {
      readCount += 1;
      if (readCount === 1) { firstReadStarted(); await readGate; }
      return readTextFile(file);
    };
    const provisioner = new LinuxUserProvisioner(config, deps);

    const first = provisioner.ensureWorker({ tenantId: "tenant-a", userId: "user-a" });
    await firstRead;
    const second = provisioner.ensureWorker({ tenantId: "tenant-a", userId: "user-b" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const readsBeforeRelease = readCount;
    releaseRead();
    await Promise.all([first, second]);
    assert.equal(readsBeforeRelease, 1);
    const state = JSON.parse(await readFile(config.stateFile, "utf8")) as { users: Record<string, unknown> };
    assert.equal(Object.keys(state.users).length, 2);
  });

  test("does not block ready workers behind another identity's OS checks", async () => {
    const provisioner = new LinuxUserProvisioner(config, deps);
    const firstIdentity = { tenantId: "tenant-a", userId: "user-a" };
    const secondIdentity = { tenantId: "tenant-a", userId: "user-b" };
    await provisioner.ensureWorker(firstIdentity);
    await provisioner.ensureWorker(secondIdentity);
    const readyState = await readFile(config.stateFile, "utf8");
    deps.readTextFile = async () => readyState;

    let secureCalls = 0;
    let releaseFirst!: () => void;
    let firstCheckStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>((resolve) => { firstCheckStarted = resolve; });
    deps.secureHome = async () => {
      secureCalls += 1;
      if (secureCalls === 1) {
	firstCheckStarted();
	await firstGate;
      }
    };

    const first = provisioner.ensureWorker(firstIdentity);
    await firstStarted;
    const second = provisioner.ensureWorker(secondIdentity);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(secureCalls, 2, "a ready identity must not wait for another identity's OS checks");
    releaseFirst();
    await Promise.all([first, second]);
  });

  test("recovers a pending mapping after useradd succeeded but finalization failed", async () => {
    let failOnce = true;
    deps.secureHome = async () => {
      if (failOnce) {
        failOnce = false;
        throw new Error("simulated crash after useradd");
      }
    };
    const provisioner = new LinuxUserProvisioner(config, deps);
    const identity = { tenantId: "tenant-a", userId: "user-a" };
    await assert.rejects(provisioner.ensureWorker(identity), /simulated crash/);
    const recovered = await provisioner.ensureWorker(identity);

    assert.match(recovered.accountName, /^cap_[a-f0-9]{20}$/);
    assert.equal(commands.filter(({ command }) => command === config.useraddPath).length, 1);
  });
});
