/**
 * Config artifacts share their item directory with the consuming CLI, so this
 * installer owns individual files instead of the whole directory.
 */

import { execFileSync } from "child_process";
import { createHash, randomBytes } from "crypto";
import {
  closeSync,
  chmodSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import path from "path";
import {
  assertArchiveSafe,
  assertDecompressionBounded,
  downloadArtifact,
} from "./installer.js";
import { managedPathParts } from "./path-policy.js";
import {
  removeAt,
  renameAtNoReplace,
  renameAtReplace,
} from "./rename-no-replace.js";
import {
  ProvisionError,
  type InstalledDirectoryIdentity,
  type InstalledFileIdentity,
} from "./types.js";

export interface ConfigInstallResult {
  files: string[];
  fileHashes: Record<string, string>;
}

const MAX_CONFIG_FILE_BYTES = 1024 * 1024;
const MAX_CONFIG_TOTAL_BYTES = 10 * 1024 * 1024;
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const CONFIG_CANDIDATE_PATTERN = /^\.provision-config-candidate-[0-9a-f]{32}$/;

function secureFileDescriptor(fd: number): void {
  if (process.platform !== "win32") fchmodSync(fd, FILE_MODE);
  fsyncSync(fd);
}

function secureDirectoryDescriptor(fd: number): void {
  if (process.platform === "win32") return;
  fchmodSync(fd, DIRECTORY_MODE);
  fsyncSync(fd);
}

function syncDirectoryDescriptor(fd: number): void {
  if (process.platform !== "win32") fsyncSync(fd);
}

export interface ConfigCandidateJournal {
  targetIdentity: InstalledDirectoryIdentity;
  candidate: InstalledFileIdentity;
}

function itemTarget(configDir: string, name: string): string {
  if (!NAME_PATTERN.test(name)) {
    throw new ProvisionError(`Invalid config name "${name}"`, "invalid_item");
  }
  return path.join(configDir, name);
}

function prepareTargetDirectory(target: string, name: string): void {
  try {
    const stat = lstatSync(target);
    if (!stat.isDirectory()) {
      throw new ProvisionError(
	`Refusing config "${name}": its target is not a directory`,
	"untracked_content",
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    mkdirSync(target, { recursive: true, mode: DIRECTORY_MODE });
  }
}

function auditConfigTree(root: string): ConfigInstallResult {
  const entries = readdirSync(root).sort();
  if (entries.length !== 1 || entries[0] !== "config.json") {
    throw new ProvisionError(
	  'Config archive must contain exactly one flat file named "config.json"',
	  "archive_rejected",
    );
  }

  const files: string[] = [];
  const fileHashes = Object.create(null) as Record<string, string>;
  let total = 0;
  for (const entry of entries) {
    const full = path.join(root, entry);
    const stat = lstatSync(full);
    if (stat.isDirectory()) {
      throw new ProvisionError(`Config archive contains a directory: ${entry}`, "archive_rejected");
    }
    if (!stat.isFile()) {
      throw new ProvisionError(`Config archive entry is not a regular file: ${entry}`, "archive_rejected");
    }
    const parts = managedPathParts(entry);
    if (!parts || parts.length !== 1) {
      throw new ProvisionError(`Config archive path cannot be recorded: ${entry}`, "archive_rejected");
    }
    if (stat.size > MAX_CONFIG_FILE_BYTES) {
      throw new ProvisionError(
	`Config file exceeds ${MAX_CONFIG_FILE_BYTES} bytes: ${entry}`,
	"audit_failed",
      );
    }
    total += stat.size;
    if (total > MAX_CONFIG_TOTAL_BYTES) {
      throw new ProvisionError(
	`Config contents exceed ${MAX_CONFIG_TOTAL_BYTES} bytes`,
	"audit_failed",
      );
    }
    const contents = readFileSync(full);
    if (contents.includes(0)) {
      throw new ProvisionError(`Binary config file refused: ${entry}`, "audit_failed");
    }
    files.push(entry);
    fileHashes[entry] = createHash("sha256").update(contents).digest("hex");
  }
  return { files, fileHashes };
}

function openTargetDirectory(target: string, name: string): number {
  try {
    return openSync(
      target,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch {
    throw new ProvisionError(
      `Refusing config "${name}": its target is not a stable directory`,
      "untracked_content",
    );
  }
}

function assertTargetIdentity(target: string, targetFd: number, name: string): void {
  try {
    const canonical = lstatSync(target, { bigint: true });
    const opened = fstatSync(targetFd, { bigint: true });
    if (
      !canonical.isDirectory()
      || canonical.dev !== opened.dev
      || canonical.ino !== opened.ino
    ) {
      throw new Error("identity changed");
    }
  } catch {
    throw new ProvisionError(
      `Refusing config "${name}": its target changed during installation`,
      "untracked_content",
    );
  }
}

function descriptorIdentity(fd: number): InstalledDirectoryIdentity {
  const stat = fstatSync(fd, { bigint: true });
  return { dev: stat.dev.toString(), ino: stat.ino.toString() };
}

function sameIdentity(fd: number, expected: InstalledDirectoryIdentity): boolean {
  const actual = descriptorIdentity(fd);
  return actual.dev === expected.dev && actual.ino === expected.ino;
}

function reserveCandidate(target: string, targetFd: number, name: string): {
  candidateFd: number;
  journal: ConfigCandidateJournal;
} {
  const targetIdentity = descriptorIdentity(targetFd);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const candidate = `.provision-config-candidate-${randomBytes(16).toString("hex")}`;
    try {
      const candidateFd = openSync(
	path.join(target, candidate),
	constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
	FILE_MODE,
      );
      try {
	assertTargetIdentity(target, targetFd, name);
	return {
	  candidateFd,
	  journal: {
	    targetIdentity,
	    candidate: { name: candidate, ...descriptorIdentity(candidateFd) },
	  },
	};
      } catch (err) {
	closeSync(candidateFd);
	throw err;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw err;
    }
  }
  throw new ProvisionError("Could not reserve a config publication candidate", "untracked_content");
}

function discardOpenCandidate(
  _target: string,
  _targetFd: number,
  candidateFd: number,
  _journal: ConfigCandidateJournal,
): boolean {
  try {
    ftruncateSync(candidateFd, 0);
    fsyncSync(candidateFd);
  } catch {
    return false;
  }
  // Node does not expose unlinkat with an expected inode. Leaving an empty,
  // random owned placeholder is safer than a check-then-unlink that could
  // remove a user file swapped into the basename after verification.
  return true;
}

/** Discard only the exact candidate inode recorded before credential publication. */
export function discardConfigCandidate(
  name: string,
  opts: {
    configDir: string;
    targetIdentity?: InstalledDirectoryIdentity;
    candidate?: InstalledFileIdentity;
  },
): boolean {
  if (!opts.targetIdentity || !opts.candidate
    || !CONFIG_CANDIDATE_PATTERN.test(opts.candidate.name)) return false;
  const target = itemTarget(opts.configDir, name);
  let targetFd: number;
  try {
    targetFd = openTargetDirectory(target, name);
  } catch {
    return false;
  }
  let candidateFd: number | undefined;
  try {
    if (!sameIdentity(targetFd, opts.targetIdentity)) return false;
    try {
      candidateFd = openSync(
	path.join(target, opts.candidate.name),
	constants.O_WRONLY | constants.O_NOFOLLOW,
      );
    } catch {
      return false;
    }
    if (!sameIdentity(candidateFd, opts.candidate)) return false;
    assertTargetIdentity(target, targetFd, name);
    return discardOpenCandidate(target, targetFd, candidateFd, {
      targetIdentity: opts.targetIdentity,
      candidate: opts.candidate,
    });
  } finally {
    if (candidateFd !== undefined) closeSync(candidateFd);
    closeSync(targetFd);
  }
}

function assertExpectedWrapper(archivePath: string, expected: string): void {
  let names: string;
  try {
    names = execFileSync("tar", ["-tzf", archivePath], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch {
    throw new ProvisionError("Config artifact is not a readable tar.gz", "archive_rejected");
  }
  const topLevel = names
    .split("\n")
    .filter(Boolean)
    .map((name) => name.replace(/\/+$/, "").split("/").filter((part) => part !== ".")[0])
    .find(Boolean);
  if (topLevel !== expected) {
    throw new ProvisionError(
      `Config archive wrapper must match item name "${expected}"`,
      "archive_rejected",
    );
  }
}

async function fetchConfigArtifact(
  url: string,
  checkUrl?: (url: string) => void,
): Promise<Buffer> {
  try {
    return await downloadArtifact(url, checkUrl);
  } catch (err) {
    if (err instanceof ProvisionError) {
      if (err.code === "archive_rejected") throw err;
      const status = err.message.match(/HTTP\s+(\d{3})/i)?.[1];
      if (err.code === "download_failed") {
	throw new ProvisionError(
	  `Config artifact download failed${status ? `: HTTP ${status}` : ""}`,
	  err.code,
	);
      }
      if (err.code === "invalid_url" || err.code === "url_not_allowed") {
	throw new ProvisionError("Config artifact URL was rejected", err.code);
      }
    }
    throw new ProvisionError("Config artifact download failed", "download_failed");
  }
}

export async function installConfig(
  item: { name: string; url: string; sha256: string },
  opts: {
    configDir: string;
    checkUrl?: (url: string) => void;
    managedFiles?: string[];
    adopt?: boolean;
    beforeCommit?: (result: ConfigInstallResult, journal: ConfigCandidateJournal) => void;
    beforeMutation?: () => void;
    beforePublish?: (target: string) => void;
    beforeReplace?: (target: string) => void;
    afterPublish?: (target: string) => void;
  },
): Promise<ConfigInstallResult> {
  const target = itemTarget(opts.configDir, item.name);
  const buf = await fetchConfigArtifact(item.url, opts.checkUrl);
  const digest = createHash("sha256").update(buf).digest("hex");
  if (digest !== item.sha256.toLowerCase()) {
    throw new ProvisionError(`sha256 mismatch for config "${item.name}"`, "sha256_mismatch");
  }
  assertDecompressionBounded(buf);
  opts.beforeMutation?.();

  mkdirSync(opts.configDir, { recursive: true });
  const staging = mkdtempSync(path.join(opts.configDir, ".provision-config-"));
  try {
    chmodSync(staging, DIRECTORY_MODE);
    const archivePath = path.join(staging, "artifact.tgz");
    writeFileSync(archivePath, buf, { mode: FILE_MODE });
    const stripWrapper = assertArchiveSafe(archivePath);
    if (stripWrapper) assertExpectedWrapper(archivePath, item.name);
    const extracted = path.join(staging, "files");
    mkdirSync(extracted, { mode: DIRECTORY_MODE });
    try {
      execFileSync("tar", [
	"-xzf",
	archivePath,
	"-C",
	extracted,
	...(stripWrapper ? ["--strip-components=1"] : []),
      ]);
    } catch {
      throw new ProvisionError("Config artifact extraction failed", "archive_rejected");
    }
    unlinkSync(archivePath);

    const result = auditConfigTree(extracted);
    for (const file of result.files) chmodSync(path.join(extracted, file), FILE_MODE);

    prepareTargetDirectory(target, item.name);
    const managed = new Set(opts.managedFiles ?? []);
    const targetFd = openTargetDirectory(target, item.name);
    let candidateFd: number | undefined;
    let candidateJournal: ConfigCandidateJournal | undefined;
    let candidateOwned = false;
    try {
      // A refused collision must not change permissions on a user-owned directory.
      if (!opts.adopt && !managed.has("config.json")) {
	try {
	  lstatSync(path.join(target, "config.json"));
	} catch (err) {
	  if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	  ({ candidateFd, journal: candidateJournal } = reserveCandidate(
	    target,
	    targetFd,
	    item.name,
	  ));
	  candidateOwned = true;
	  opts.beforeCommit?.(result, candidateJournal);
	  opts.beforePublish?.(target);
	  assertTargetIdentity(target, targetFd, item.name);
	  writeFileSync(candidateFd, readFileSync(path.join(extracted, "config.json")));
	  secureFileDescriptor(candidateFd);
	  assertTargetIdentity(target, targetFd, item.name);
	  const previousDirectoryMode = fstatSync(targetFd).mode & 0o777;
	  secureDirectoryDescriptor(targetFd);
	  if (!renameAtNoReplace(
	    targetFd,
	    target,
	    candidateJournal.candidate.name,
	    "config.json",
	    process.platform,
	    candidateFd,
	  )) {
	    if (process.platform !== "win32") {
	      fchmodSync(targetFd, previousDirectoryMode);
	      fsyncSync(targetFd);
	    }
	    throw new ProvisionError(
	      `Refusing to replace untracked file "config.json" in config "${item.name}"`,
	      "untracked_content",
	    );
	  }
	  candidateOwned = false;
	  opts.afterPublish?.(target);
	  syncDirectoryDescriptor(targetFd);
	  return result;
	}
	throw new ProvisionError(
	  `Refusing to replace untracked file "config.json" in config "${item.name}"`,
	  "untracked_content",
	);
      }

      ({ candidateFd, journal: candidateJournal } = reserveCandidate(
	target,
	targetFd,
	item.name,
      ));
      candidateOwned = true;
      opts.beforeCommit?.(result, candidateJournal);
      opts.beforePublish?.(target);
      assertTargetIdentity(target, targetFd, item.name);
      writeFileSync(candidateFd, readFileSync(path.join(extracted, "config.json")));
      secureFileDescriptor(candidateFd);
      assertTargetIdentity(target, targetFd, item.name);
      secureDirectoryDescriptor(targetFd);
      opts.beforeReplace?.(target);
      renameAtReplace(
	targetFd,
	target,
	candidateJournal.candidate.name,
	"config.json",
      );
      candidateOwned = false;
      opts.afterPublish?.(target);
      syncDirectoryDescriptor(targetFd);

      for (const stale of managed) {
	if (stale === "config.json") continue;
	const parts = managedPathParts(stale);
	if (!parts || parts.length !== 1) {
	  throw new ProvisionError(
	    `Config "${item.name}" records an unusable path`,
	    "invalid_item",
	  );
	}
	try {
	  removeAt(targetFd, target, parts[0]!);
	} catch (err) {
	  if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
      }
      return result;
    } finally {
      if (candidateOwned) {
	if (candidateFd !== undefined && candidateJournal !== undefined) {
	  discardOpenCandidate(target, targetFd, candidateFd, candidateJournal);
	}
      }
      if (candidateFd !== undefined) closeSync(candidateFd);
      closeSync(targetFd);
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Remove only lockfile-owned names; user-created siblings always survive. */
export function removeConfig(
  name: string,
  opts: { configDir: string; files: string[]; beforeRemove?: (target: string) => void },
): { removed: string[] } {
  const target = itemTarget(opts.configDir, name);
  const removed: string[] = [];
  const files = opts.files.map((file) => {
    const parts = managedPathParts(file);
    if (!parts || parts.length !== 1) {
      throw new ProvisionError(`Config "${name}" records an unusable path`, "invalid_item");
    }
    return parts[0]!;
  });
  try {
    if (!lstatSync(target).isDirectory()) {
      const message = `Refusing to remove config "${name}": its target is not a directory`;
      throw new ProvisionError(message, "untracked_content");
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { removed };
    throw err;
  }
  const targetFd = openTargetDirectory(target, name);
  try {
    opts.beforeRemove?.(target);
    assertTargetIdentity(target, targetFd, name);
    for (const file of files) {
      try {
	if (removeAt(targetFd, target, file)) removed.push(file);
      } catch (err) {
	if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
    if (removed.length > 0) syncDirectoryDescriptor(targetFd);
  } finally {
    closeSync(targetFd);
  }
  return { removed };
}
