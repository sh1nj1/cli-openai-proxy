import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdir, chmod, chown, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { UserIdentity, WorkerTarget } from "./types.js";

const execFileAsync = promisify(execFile);
const ACCOUNT_RE = /^cap_[a-f0-9]{20}$/;

interface UserRecord {
  accountName: string;
  uid?: number;
  gid?: number;
  home: string;
  createdAt: string;
  status?: "creating" | "ready";
}

interface MappingState {
  version: 1;
  users: Record<string, UserRecord>;
}

export interface LinuxProvisionerConfig {
  identitySecret: Buffer;
  stateFile: string;
  usersDir: string;
  workerSocketDir: string;
  useraddPath: string;
  idPath: string;
  systemctlPath: string;
  workerUnitPrefix: string;
  maxUsers: number;
}

export interface LinuxProvisionerDeps {
  run(command: string, args: string[]): Promise<{ stdout: string }>;
  secureHome(home: string, uid: number, gid: number): Promise<void>;
  readTextFile(file: string): Promise<string>;
  now(): Date;
}

const defaultDeps: LinuxProvisionerDeps = {
  async run(command, args) {
    const result = await execFileAsync(command, args, {
      encoding: "utf8",
      env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
      timeout: 30_000,
      maxBuffer: 64 * 1024,
    });
    return { stdout: result.stdout };
  },
  async secureHome(home, uid, gid) {
    const info = await stat(home);
    if (!info.isDirectory()) throw new Error(`Provisioned HOME is not a directory: ${home}`);
    await chown(home, uid, gid);
    await chmod(home, 0o700);
  },
  async readTextFile(file) {
    return readFile(file, "utf8");
  },
  now: () => new Date(),
};

const STABLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;

function assertIdentity(identity: UserIdentity): void {
  if (
    !identity
    || typeof identity.tenantId !== "string"
    || !STABLE_ID_RE.test(identity.tenantId)
    || typeof identity.userId !== "string"
    || !STABLE_ID_RE.test(identity.userId)
  ) {
    throw new Error("tenantId and userId must be non-empty strings of at most 200 characters");
  }
}

export class LinuxUserProvisioner {
  private readonly locks = new Map<string, Promise<WorkerTarget>>();
  private stateQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: LinuxProvisionerConfig,
    private readonly deps: LinuxProvisionerDeps = defaultDeps,
  ) {
    if (config.identitySecret.length < 32) {
      throw new Error("Provisioner identity secret must contain at least 32 bytes");
    }
  }

  ensureWorker(identity: UserIdentity): Promise<WorkerTarget> {
    assertIdentity(identity);
    const fingerprint = this.fingerprint(identity);
    const running = this.locks.get(fingerprint);
    if (running) return running;
    const operation = this.withStateLock(() => this.ensureLocked(fingerprint)).finally(() => {
      this.locks.delete(fingerprint);
    });
    this.locks.set(fingerprint, operation);
    return operation;
  }

  private withStateLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.stateQueue.then(operation);
    this.stateQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private fingerprint(identity: UserIdentity): string {
    return createHmac("sha256", this.config.identitySecret)
      .update(`v1\0${identity.tenantId}\0${identity.userId}`)
      .digest("hex");
  }

  private async ensureLocked(fingerprint: string): Promise<WorkerTarget> {
    const state = await this.readState();
    let record = state.users[fingerprint];
    if (!record) {
      if (Object.keys(state.users).length >= this.config.maxUsers) {
        throw new Error(`Provisioner user limit (${this.config.maxUsers}) reached`);
      }
      const accountName = `cap_${fingerprint.slice(0, 20)}`;
      if (!ACCOUNT_RE.test(accountName)) throw new Error("Generated account name is invalid");
      const home = path.join(this.config.usersDir, accountName);
      await mkdir(this.config.usersDir, { recursive: true, mode: 0o755 });
      record = {
        accountName,
        home,
        createdAt: this.deps.now().toISOString(),
        status: "creating",
      };
      state.users[fingerprint] = record;
      await this.writeState(state);
    }

    if (record.status === "creating" || record.uid === undefined || record.gid === undefined) {
      this.assertPendingRecord(record);
      const existingUid = await this.optionalNumericId("-u", record.accountName);
      if (existingUid === null) {
        await this.deps.run(this.config.useraddPath, [
          "--system",
          "--create-home",
          "--home-dir",
          record.home,
          "--shell",
          "/usr/sbin/nologin",
          "--user-group",
          record.accountName,
        ]);
      }
      record.uid = await this.numericId("-u", record.accountName);
      record.gid = await this.numericId("-g", record.accountName);
      await this.deps.secureHome(record.home, record.uid, record.gid);
      record.status = "ready";
      await this.writeState(state);
    } else {
      this.assertRecord(record);
      const actualUid = await this.numericId("-u", record.accountName);
      const actualGid = await this.numericId("-g", record.accountName);
      if (actualUid !== record.uid || actualGid !== record.gid) {
        throw new Error(`OS account ${record.accountName} no longer matches its provisioned UID/GID`);
      }
      await this.deps.secureHome(record.home, record.uid, record.gid);
    }

    this.assertRecord(record);
    await this.deps.run(this.config.systemctlPath, [
      "start",
      `${this.config.workerUnitPrefix}@${record.accountName}.socket`,
    ]);
    return {
      accountName: record.accountName,
      uid: record.uid,
      gid: record.gid,
      home: record.home,
      endpoint: {
        kind: "unix",
        address: path.join(this.config.workerSocketDir, `${record.accountName}.sock`),
      },
    };
  }

  private async numericId(flag: "-u" | "-g", accountName: string): Promise<number> {
    const output = (await this.deps.run(this.config.idPath, [flag, accountName])).stdout.trim();
    if (!/^\d+$/.test(output)) throw new Error(`Unable to resolve ${flag} for ${accountName}`);
    return Number(output);
  }

  private async optionalNumericId(flag: "-u" | "-g", accountName: string): Promise<number | null> {
    try {
      return await this.numericId(flag, accountName);
    } catch {
      return null;
    }
  }

  private assertPendingRecord(record: UserRecord): void {
    if (
      !ACCOUNT_RE.test(record.accountName)
      || record.home !== path.join(this.config.usersDir, record.accountName)
    ) {
      throw new Error("Provisioner state contains an invalid pending user record");
    }
  }

  private assertRecord(record: UserRecord): void {
    if (
      !ACCOUNT_RE.test(record.accountName)
      || !Number.isSafeInteger(record.uid)
      || record.uid! < 1
      || !Number.isSafeInteger(record.gid)
      || record.gid! < 1
      || record.home !== path.join(this.config.usersDir, record.accountName)
    ) {
      throw new Error("Provisioner state contains an invalid user record");
    }
  }

  private async readState(): Promise<MappingState> {
    try {
      const raw = await this.deps.readTextFile(this.config.stateFile);
      const value = JSON.parse(raw) as MappingState;
      if (value.version !== 1 || !value.users || typeof value.users !== "object" || Array.isArray(value.users)) {
        throw new Error("Provisioner state has an unsupported format");
      }
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, users: {} };
      }
      throw error;
    }
  }

  private async writeState(state: MappingState): Promise<void> {
    const directory = path.dirname(this.config.stateFile);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.config.stateFile}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.config.stateFile);
  }
}

export async function linuxProvisionerConfigFromEnv(): Promise<LinuxProvisionerConfig> {
  const secretFile =
    process.env.PROVISIONER_IDENTITY_SECRET_FILE
    ?? "/etc/cli-openai-proxy/provisioner-identity.key";
  const identitySecret = Buffer.from((await readFile(secretFile, "utf8")).trim(), "base64");
  return {
    identitySecret,
    stateFile:
      process.env.PROVISIONER_STATE_FILE
      ?? "/var/lib/cli-openai-proxy/provisioner/users.json",
    usersDir:
      process.env.PROVISIONER_USERS_DIR
      ?? "/var/lib/cli-openai-proxy/users",
    workerSocketDir:
      process.env.PROVISIONER_WORKER_SOCKET_DIR
      ?? "/run/cli-openai-proxy/workers",
    useraddPath: process.env.PROVISIONER_USERADD_PATH ?? "/usr/sbin/useradd",
    idPath: process.env.PROVISIONER_ID_PATH ?? "/usr/bin/id",
    systemctlPath: process.env.PROVISIONER_SYSTEMCTL_PATH ?? "/usr/bin/systemctl",
    workerUnitPrefix:
      process.env.PROVISIONER_WORKER_UNIT_PREFIX
      ?? "cli-openai-proxy-worker",
    maxUsers: (() => {
      const parsed = Number.parseInt(process.env.PROVISIONER_MAX_USERS ?? "1000", 10);
      if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new Error("PROVISIONER_MAX_USERS must be a positive integer");
      }
      return parsed;
    })(),
  };
}
