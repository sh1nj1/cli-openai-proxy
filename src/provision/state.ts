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
import type { InstalledRecord, ProvisionStateFile } from "./types.js";

function stateDir(): string {
  return process.env.PROVISION_STATE_DIR?.trim() || path.join(homedir(), ".cli-openai-proxy");
}

export function stateFilePath(): string {
  return path.join(stateDir(), "provision.lock.json");
}

const emptyState = (): ProvisionStateFile => ({ version: 1, approved: [], installed: {} });

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
    return {
      version: 1,
      approved: Array.isArray(parsed.approved)
        ? parsed.approved.filter((k): k is string => typeof k === "string")
        : [],
      installed:
        typeof parsed.installed === "object" && parsed.installed !== null
          ? (parsed.installed as Record<string, InstalledRecord>)
          : {},
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
