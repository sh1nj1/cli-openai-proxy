/**
 * The provisioning lockfile: the proxy's record of what IT installed.
 *
 * This file is the ownership boundary — removal logic deletes only what is
 * recorded here, so skills a user installed by hand are never touched. Loading
 * tolerates a corrupt file (crash mid-write, manual edit) by answering the
 * empty state: worst case the next sync reinstalls, which is idempotent.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import path from "path";
import { managedPathParts } from "./path-policy.js";
import type { InstalledRecord, InstalledSnapshot, ProvisionStateFile } from "./types.js";

export function provisionStateDir(): string {
  return process.env.PROVISION_STATE_DIR?.trim() || path.join(homedir(), ".cli-openai-proxy");
}

export function stateFilePath(): string {
  return path.join(provisionStateDir(), "provision.lock.json");
}

const emptyState = (): ProvisionStateFile => ({ version: 1, approved: [], revoked: [], installed: {} });
const HASH_PATTERN = /^[0-9a-f]{64}$/i;
const INSTALL_MARKER_PATTERN = /^[0-9a-f]{32}$/;
const RECOVERY_ID_PATTERN = /^[0-9a-f]{32}$/;
const KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}\/[a-z0-9][a-z0-9_-]{0,63}$/i;

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
  return {
    sha256: record.sha256.toLowerCase(),
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
  return {
    ...stable,
    ...(raw.uncommitted === true ? { uncommitted: true as const } : {}),
    ...(typeof raw.installMarker === "string" && INSTALL_MARKER_PATTERN.test(raw.installMarker)
      ? { installMarker: raw.installMarker }
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
      approved: Array.isArray(parsed.approved)
	? parsed.approved.filter((k): k is string => typeof k === "string" && KEY_PATTERN.test(k))
	: [],
      revoked: Array.isArray(parsed.revoked)
	? parsed.revoked.filter((k): k is string => typeof k === "string" && KEY_PATTERN.test(k))
        : [],
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
