/**
 * The provisioning lockfile: the proxy's record of what IT installed.
 *
 * This file is the ownership boundary — removal logic deletes only what is
 * recorded here, so skills a user installed by hand are never touched. Loading
 * tolerates a corrupt file (crash mid-write, manual edit) by answering the
 * empty state: worst case the next sync reinstalls, which is idempotent.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
  scryptSync,
} from "crypto";
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import path from "path";
import { isCanonicalGitPath, isGitObjectId, isValidGitRevision } from "./git-source.js";
import { managedPathParts } from "./path-policy.js";
import { currentWorkspaceContext } from "./workspace-context.js";
import type {
  InstalledFileIdentity,
  InstalledRecord,
  InstalledSnapshot,
  ProvisionStateFile,
} from "./types.js";

export function provisionStateDir(): string {
  const workspace = currentWorkspaceContext();
  return workspace?.scoped && workspace.stateDir
    ? workspace.stateDir
    : process.env.PROVISION_STATE_DIR?.trim() || path.join(homedir(), ".cli-openai-proxy");
}

export function stateFilePath(): string {
  return path.join(provisionStateDir(), "provision.lock.json");
}

export function registeredManifestFilePath(): string {
  return path.join(provisionStateDir(), "provision.manifest.json");
}

export function localManifestKeyFilePath(): string {
  return path.join(provisionStateDir(), "manifest.key");
}

/**
 * Per-state-dir encryption key for workers, which never receive AUTH_ADMIN_KEYS.
 * The file lives beside the lockfile inside the user's 0700 HOME, so it grants
 * nothing beyond what filesystem ownership already grants.
 */
export function loadOrCreateLocalManifestKey(): string {
  const file = localManifestKeyFilePath();
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (/^[A-Za-z0-9_-]{43}$/.test(existing)) return existing;
  } catch {
    // Fall through to creation.
  }
  const key = randomBytes(32).toString("base64url");
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, `${key}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try {
      // Hard-link creation is atomic and never replaces a key another process won.
      linkSync(temporary, file);
      return key;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  } finally {
    rmSync(temporary, { force: true });
  }
  // Another process won creation; its valid file is the source of truth.
  const winner = readFileSync(file, "utf8").trim();
  if (/^[A-Za-z0-9_-]{43}$/.test(winner)) return winner;
  // Preserve self-healing for a corrupt key. Worker processes are single-instance
  // per state dir, so recovery is not expected to contend.
  const replacement = `${file}.replacement-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(replacement, `${key}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(replacement, file);
    return key;
  } finally {
    rmSync(replacement, { force: true });
  }
}

const MAX_REGISTERED_MANIFEST_BYTES = 16 * 1024;
const MANIFEST_CIPHER_AAD = Buffer.from("cli-openai-proxy/provision-manifest/v1", "utf8");

function decodeField(value: unknown, expectedBytes?: number): Buffer | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const decoded = Buffer.from(value, "base64url");
  return expectedBytes === undefined || decoded.length === expectedBytes ? decoded : null;
}

/** Load the last auth-delivered registry without trusting persisted input. */
export function loadRegisteredManifestUrl(keys: readonly string[]): string | null {
  const file = registeredManifestFilePath();
  try {
    if (statSync(file).size > MAX_REGISTERED_MANIFEST_BYTES) return null;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record.version !== 1) return null;
    const salt = decodeField(record.salt, 16);
    const iv = decodeField(record.iv, 12);
    const tag = decodeField(record.tag, 16);
    const ciphertext = decodeField(record.ciphertext);
    if (!salt || !iv || !tag || !ciphertext || ciphertext.length === 0) return null;
    for (const key of keys) {
      try {
	const decipher = createDecipheriv("aes-256-gcm", scryptSync(key, salt, 32), iv);
	decipher.setAAD(MANIFEST_CIPHER_AAD);
	decipher.setAuthTag(tag);
	const url = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
	if (url.length > 0 && Buffer.byteLength(url, "utf8") <= MAX_REGISTERED_MANIFEST_BYTES) return url;
      } catch {
	// Try the next configured admin key; rotation may have changed ordering.
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Persist signed query URLs outside the non-secret ownership lockfile. */
export function saveRegisteredManifestUrl(url: string, key: string | undefined): void {
  if (!key) throw new Error("Cannot persist an auth-delivered manifest URL without an auth-admin key.");
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", scryptSync(key, salt, 32), iv);
  cipher.setAAD(MANIFEST_CIPHER_AAD);
  const ciphertext = Buffer.concat([cipher.update(url, "utf8"), cipher.final()]);
  const record = {
    version: 1,
    salt: salt.toString("base64url"),
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
  const file = registeredManifestFilePath();
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

const emptyState = (): ProvisionStateFile => ({ version: 1, approved: [], revoked: [], installed: {} });
const HASH_PATTERN = /^[0-9a-f]{64}$/i;
const INSTALL_MARKER_PATTERN = /^[0-9a-f]{32}$/;
const RECOVERY_ID_PATTERN = /^[0-9a-f]{32}$/;
const FILESYSTEM_ID_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const CONFIG_CANDIDATE_PATTERN = /^\.provision-config-candidate-[0-9a-f]{32}$/;
// Loading remains case-insensitive for lockfiles written before names became
// lowercase-only. Installed keys retain their spelling because it identifies
// the legacy on-disk directory; consent/tombstone keys have no path identity
// and can be canonicalized immediately.
const KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}\/[a-z0-9][a-z0-9_-]{0,63}$/i;

function canonicalKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((key): key is string => typeof key === "string" && KEY_PATTERN.test(key))
    .map((key) => key.toLowerCase()))];
}

function safeRelativeFile(value: unknown): value is string {
  return managedPathParts(value) !== null;
}

function installedSnapshot(value: unknown): InstalledSnapshot | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.sha256 !== "string" || !HASH_PATTERN.test(record.sha256)) return null;
  if (!Array.isArray(record.files) || record.files.length === 0 || !record.files.every(safeRelativeFile)) return null;
  const files = record.files as string[];
  if (new Set(files).size !== files.length) return null;
  let directories: string[] | undefined;
  if (record.directories !== undefined) {
    if (!Array.isArray(record.directories) || !record.directories.every(safeRelativeFile)) return null;
    directories = record.directories as string[];
    if (new Set(directories).size !== directories.length) return null;
  }
  if (typeof record.installedAt !== "string" || !Number.isFinite(Date.parse(record.installedAt))) return null;
  let fileHashes: Record<string, string> | undefined;
  if (record.fileHashes !== undefined) {
    if (typeof record.fileHashes !== "object" || record.fileHashes === null || Array.isArray(record.fileHashes)) return null;
    const entries = Object.entries(record.fileHashes);
    if (entries.length !== files.length) return null;
    if (entries.some(([file, hash]) => !safeRelativeFile(file) || !files.includes(file)
      || typeof hash !== "string" || !HASH_PATTERN.test(hash))) return null;
    fileHashes = Object.fromEntries(entries) as Record<string, string>;
  }
  const rawSource = record.source;
  const rawGitSource = typeof rawSource === "object" && rawSource !== null && !Array.isArray(rawSource)
    ? rawSource as Record<string, unknown>
    : null;
  const gitRef = rawGitSource?.ref ?? rawGitSource?.rev;
  const source = typeof rawSource === "object"
    && rawSource !== null
    && !Array.isArray(rawSource)
    && rawGitSource?.type === "git"
    && isValidGitRevision(gitRef)
    && isGitObjectId(rawGitSource.rev)
    && (rawGitSource.path === undefined || isCanonicalGitPath(rawGitSource.path))
    ? {
	type: "git" as const,
	ref: gitRef,
	rev: (rawGitSource.rev as string).toLowerCase(),
	...(rawGitSource.path !== undefined
	  ? { path: rawGitSource.path as string }
	  : {}),
      }
    : undefined;
  return {
    sha256: record.sha256.toLowerCase(),
    ...(source ? { source } : {}),
    files: [...files],
    ...(directories !== undefined ? { directories: [...directories] } : {}),
    ...(fileHashes ? { fileHashes } : {}),
    installedAt: record.installedAt,
  };
}

function installedRecord(value: unknown): InstalledRecord | null {
  const stable = installedSnapshot(value);
  if (!stable) return null;
  const raw = value as Record<string, unknown>;
  const pending = raw.pending === undefined ? null : installedSnapshot(raw.pending);
  const rawCandidateIdentity = raw.candidateIdentity;
  const candidateIdentity = typeof rawCandidateIdentity === "object"
    && rawCandidateIdentity !== null
    && !Array.isArray(rawCandidateIdentity)
    && typeof (rawCandidateIdentity as Record<string, unknown>).dev === "string"
    && FILESYSTEM_ID_PATTERN.test((rawCandidateIdentity as Record<string, string>).dev)
    && typeof (rawCandidateIdentity as Record<string, unknown>).ino === "string"
    && FILESYSTEM_ID_PATTERN.test((rawCandidateIdentity as Record<string, string>).ino)
    ? {
	dev: (rawCandidateIdentity as Record<string, string>).dev,
	ino: (rawCandidateIdentity as Record<string, string>).ino,
      }
    : undefined;
  const rawConfigCandidate = raw.configCandidate;
  const configCandidate: InstalledFileIdentity | undefined =
    typeof rawConfigCandidate === "object"
    && rawConfigCandidate !== null
    && !Array.isArray(rawConfigCandidate)
    && typeof (rawConfigCandidate as Record<string, unknown>).name === "string"
    && CONFIG_CANDIDATE_PATTERN.test((rawConfigCandidate as Record<string, string>).name)
    && typeof (rawConfigCandidate as Record<string, unknown>).dev === "string"
    && FILESYSTEM_ID_PATTERN.test((rawConfigCandidate as Record<string, string>).dev)
    && typeof (rawConfigCandidate as Record<string, unknown>).ino === "string"
    && FILESYSTEM_ID_PATTERN.test((rawConfigCandidate as Record<string, string>).ino)
      ? {
	  name: (rawConfigCandidate as Record<string, string>).name,
	  dev: (rawConfigCandidate as Record<string, string>).dev,
	  ino: (rawConfigCandidate as Record<string, string>).ino,
	}
      : undefined;
  return {
    ...stable,
    ...(raw.uncommitted === true ? { uncommitted: true as const } : {}),
    ...(candidateIdentity ? { candidateIdentity } : {}),
    ...(configCandidate ? { configCandidate } : {}),
    ...(typeof raw.installMarker === "string" && INSTALL_MARKER_PATTERN.test(raw.installMarker)
      ? { installMarker: raw.installMarker }
      : {}),
    ...(typeof raw.rejectionRecoveryId === "string" && RECOVERY_ID_PATTERN.test(raw.rejectionRecoveryId)
      ? { rejectionRecoveryId: raw.rejectionRecoveryId }
      : {}),
    ...(typeof raw.removalRecoveryId === "string" && RECOVERY_ID_PATTERN.test(raw.removalRecoveryId)
      ? { removalRecoveryId: raw.removalRecoveryId }
      : {}),
    ...(pending ? { pending } : {}),
  };
}

export function loadState(): ProvisionStateFile {
  let raw: string;
  try {
    raw = readFileSync(stateFilePath(), "utf-8");
  } catch {
    return emptyState();
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ProvisionStateFile>;
    if (typeof parsed !== "object" || parsed === null) return emptyState();
    const installed: Record<string, InstalledRecord> = {};
    if (typeof parsed.installed === "object" && parsed.installed !== null) {
      for (const [key, value] of Object.entries(parsed.installed)) {
	const record = KEY_PATTERN.test(key) ? installedRecord(value) : null;
	if (record) installed[key] = record;
      }
    }
    return {
      version: 1,
      approved: canonicalKeys(parsed.approved),
      revoked: canonicalKeys(parsed.revoked),
      ...(parsed.adopted !== undefined ? { adopted: canonicalKeys(parsed.adopted) } : {}),
      ...(Array.isArray(parsed.removalRecoveries)
	? {
	  removalRecoveries: [...new Set(parsed.removalRecoveries.filter(
	    (id): id is string => typeof id === "string" && RECOVERY_ID_PATTERN.test(id),
	  ))],
	}
	: {}),
      ...(Array.isArray(parsed.upgradeRecoveries)
	? {
	  upgradeRecoveries: [...new Set(parsed.upgradeRecoveries.filter(
	    (id): id is string => typeof id === "string" && RECOVERY_ID_PATTERN.test(id),
	  ))],
	}
	: {}),
      installed,
    };
  } catch {
    return emptyState();
  }
}

export function saveState(state: ProvisionStateFile): void {
  const file = stateFilePath();
  mkdirSync(path.dirname(file), { recursive: true });
  // Write-then-rename so a crash never leaves a half-written lockfile in place.
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, file);
}
