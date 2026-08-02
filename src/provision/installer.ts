/**
 * Skill artifact installer: download → sha256 → safe extraction → static audit
 * → atomic swap into the type's sandbox directory.
 *
 * The pipeline is fail-closed at every stage and nothing is executed from the
 * archive — installation is file placement only. The audit mirrors the checks
 * Paperclip applies to imported skills (no binaries, size caps, no
 * pipe-download-into-shell instructions): with no signature scheme in v1, hash
 * pinning guarantees WHAT arrived and the audit bounds what it can say.
 */

import { execFileSync } from "child_process";
import { createHash, randomBytes } from "crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";
import { gunzipSync } from "zlib";
import { fetchWithPolicy, readResponseBody } from "./manifest.js";
import { managedPathParts, MAX_MANAGED_PATH_LENGTH } from "./path-policy.js";
import { renameDirectoryNoReplace } from "./rename-no-replace.js";
import { ProvisionError } from "./types.js";

export interface InstallResult {
  /** Installed file paths relative to the skill's directory. */
  files: string[];
  /** Installed directory paths, including empty directories. */
  directories: string[];
  /** Hashes of installed contents, used by periodic drift repair. */
  fileHashes: Record<string, string>;
}

const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
/** Content cap plus slack for tar headers and padding (~512B per entry). */
const MAX_DECOMPRESSED_BYTES = MAX_TOTAL_BYTES + 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const INSTALL_MARKER_PATTERN = /^[0-9a-f]{32}$/;
const RECOVERY_ID_PATTERN = /^[0-9a-f]{32}$/;
const REMOVAL_RECOVERY_PREFIX = ".provision-removed-";
const REMOVAL_RECOVERY_METADATA = ".recovery.json";
const UPGRADE_RECOVERY_PREFIX = ".provision-staging-";
const UPGRADE_RECOVERY_METADATA = ".upgrade-recovery.json";

/** Same charset the manifest enforces; re-checked here so no other caller can widen it. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export function firstInstallMarkerPath(root: string, marker: string): string {
  if (!INSTALL_MARKER_PATTERN.test(marker)) {
    throw new ProvisionError("Invalid first-install marker", "invalid_item");
  }
  return path.join(root, `.provision-install-${marker}`);
}

/**
 * A skill is instructions loaded into a model's prompt; one that tells the
 * agent to pipe a download into a shell defeats the "no execution at install
 * time" guarantee at USE time instead. Heuristics, not proof — the TOFU
 * approval gate is the backstop for what these cannot see.
 */
const REMOTE_EXEC_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:curl|wget)\b[^\n]*\|\s*(?:ba|z|da)?sh\b/, "pipes a download into a shell"],
  [/\beval\s*"?\$\(/, "evals command substitution"],
];

async function download(url: string, checkUrl?: (url: string) => void): Promise<Buffer> {
  const response = await fetchWithPolicy(url, {
    checkUrl: checkUrl ?? (() => {}),
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    failCode: "download_failed",
  });
  if (!response.ok) {
    throw new ProvisionError(`Download failed: HTTP ${response.status}`, "download_failed");
  }
  // The cap is enforced WHILE the body streams: a host that sends an oversized
  // or never-ending body is cut off at the limit, not buffered to completion.
  return readResponseBody(response, {
    maxBytes: MAX_ARCHIVE_BYTES,
    tooLargeCode: "archive_rejected",
    readErrorCode: "download_failed",
    label: "Archive",
  });
}

/**
 * Extraction writes whatever the gzip stream expands to, so the expansion is
 * bounded BEFORE tar runs: a small archive that decompresses to gigabytes (a
 * gzip bomb) must never reach the filesystem. The audit's per-file/total caps
 * remain as the backstop for what fits under this bound.
 */
function assertDecompressionBounded(buf: Buffer): void {
  try {
    gunzipSync(buf, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
      throw new ProvisionError(
        `Archive decompresses beyond ${MAX_DECOMPRESSED_BYTES} bytes`,
        "archive_rejected",
      );
    }
    throw new ProvisionError("Artifact is not a readable tar.gz", "archive_rejected");
  }
}

/**
 * Reject hostile archives from the member listing, BEFORE extraction: link
 * entries (a symlinked directory would let a later entry write through it) and
 * any traversal or absolute name.
 */
function assertArchiveSafe(archivePath: string): boolean {
  let verbose: string;
  let names: string;
  try {
    const opts = { encoding: "utf-8" as const, maxBuffer: MAX_ARCHIVE_BYTES };
    verbose = execFileSync("tar", ["-tvzf", archivePath], opts);
    names = execFileSync("tar", ["-tzf", archivePath], opts);
  } catch {
    throw new ProvisionError("Artifact is not a readable tar.gz", "archive_rejected");
  }
  const verboseEntries = verbose.split("\n").filter(Boolean);
  for (const line of verboseEntries) {
    if (line[0] === "l" || line[0] === "h") {
      throw new ProvisionError("Archive contains a link entry", "archive_rejected");
    }
  }
  const archiveNames = names.split("\n").filter(Boolean);
  for (const name of archiveNames) {
    const relative = name.replace(/\/+$/, "");
    if (relative.length > MAX_MANAGED_PATH_LENGTH) {
      throw new ProvisionError(
	`Archive entry path exceeds ${MAX_MANAGED_PATH_LENGTH} characters`,
	"archive_rejected",
      );
    }
    if (path.isAbsolute(name) || name.split("/").includes("..")) {
      throw new ProvisionError(`Archive entry escapes its root: ${name}`, "archive_rejected");
    }
  }
  const members = archiveNames
    .map((name, index) => ({
      name,
      isDirectory: verboseEntries[index]?.[0] === "d",
      parts: name.replace(/\/+$/, "").split("/").filter((part) => part !== "."),
    }))
    .filter((entry) => entry.parts.length > 0);
  const wrapper = members[0]?.parts[0];
  return wrapper !== undefined
    && members.every((entry) => entry.parts[0] === wrapper)
    && members.some((entry) => entry.parts.length > 1)
    && !members.some((entry) => entry.parts.length === 1 && !entry.isDirectory);
}

/** Walk the extracted tree, enforcing the audit, returning relative file paths. */
function auditTree(root: string): InstallResult {
  const files: string[] = [];
  const directories: string[] = [];
  const fileHashes: Record<string, string> = {};
  let total = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) {
        throw new ProvisionError("Extracted tree contains a symlink", "archive_rejected");
      }
      if (stat.isDirectory()) {
	const relative = path.relative(root, full).split(path.sep).join("/");
	if (!managedPathParts(relative)) {
	  throw new ProvisionError(`Archive path cannot be recorded: ${relative}`, "archive_rejected");
	}
	directories.push(relative);
        walk(full);
        continue;
      }
      if (!stat.isFile()) {
        throw new ProvisionError(`Not a regular file: ${entry}`, "archive_rejected");
      }
      const relative = path.relative(root, full).split(path.sep).join("/");
      if (!managedPathParts(relative)) {
	throw new ProvisionError(`Archive path cannot be recorded: ${relative}`, "archive_rejected");
      }
      if (stat.size > MAX_FILE_BYTES) {
        throw new ProvisionError(`File exceeds ${MAX_FILE_BYTES} bytes: ${relative}`, "audit_failed");
      }
      total += stat.size;
      if (total > MAX_TOTAL_BYTES) {
        throw new ProvisionError(`Contents exceed ${MAX_TOTAL_BYTES} bytes`, "audit_failed");
      }
      const contents = readFileSync(full);
      if (contents.includes(0)) {
        throw new ProvisionError(`Binary file refused: ${relative}`, "audit_failed");
      }
      const text = contents.toString("utf-8");
      for (const [pattern, why] of REMOTE_EXEC_PATTERNS) {
        if (pattern.test(text)) {
          throw new ProvisionError(`${relative} ${why}`, "audit_failed");
        }
      }
      files.push(relative);
      fileHashes[relative] = createHash("sha256").update(contents).digest("hex");
    }
  };
  walk(root);
  return { files, directories, fileHashes };
}

/** Ensure the gateway can audit, replace, and remove extracted content. */
function normalizeDirectoryMode(directory: string): void {
  const stat = lstatSync(directory);
  chmodSync(directory, stat.mode | 0o700);
}

function normalizeExtractedModes(root: string): void {
  const walk = (dir: string): void => {
    normalizeDirectoryMode(dir);
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      const stat = lstatSync(full);
      if (stat.isDirectory()) {
	walk(full);
      } else if (stat.isFile()) {
	chmodSync(full, stat.mode | 0o400);
      }
    }
  };
  walk(root);
}

export async function installSkill(
  item: { name: string; url: string; sha256: string },
  opts: {
    skillsDir: string;
    checkUrl?: (url: string) => void;
    /** Persist ownership before exposure; return an undo for a failed first-install rename. */
    beforeCommit?: (result: InstallResult) => void | (() => void);
    /** Random journal marker that moves atomically with a first-install candidate. */
    firstInstallMarker?: string;
    /** Existing managed paths; an upgrade must not erase additions outside this set. */
    managedFiles?: string[];
    /** Existing managed directories; omitted for legacy lockfiles that did not track them. */
    managedDirectories?: string[];
    /** Accepted hashes for existing managed files, including either journal snapshot. */
    managedFileHashes?: Record<string, string | string[]>;
    /** New upgrade recovery identity preclaimed in the lockfile before staging begins. */
    upgradeRecoveryId?: string;
    /** Test seam for deterministically exercising restoration races. */
    afterPreviousMove?: () => void;
    /** Test seam for mutation between first exposure and journal reconciliation. */
    afterFirstInstallMove?: (target: string) => void;
    /** Test seam for a target appearing immediately before candidate exposure. */
    beforeCandidateMove?: (target: string) => void;
    /** Test seam for replacing the old reservation immediately before the atomic rename. */
    beforeCandidateRename?: (target: string) => void;
    /** Test seam for an addition made after the moved-aside tree passes its audit. */
    afterPreviousAudit?: (previousRoot: string) => void;
    /** Test seam for a mutation made after cleanup verifies an isolated file. */
    afterCleanupHash?: (previousRoot: string, relative: string) => void;
  },
): Promise<InstallResult> {
  if (!NAME_PATTERN.test(item.name)) {
    throw new ProvisionError(`Invalid skill name "${item.name}"`, "invalid_item");
  }
  const buf = await download(item.url, opts.checkUrl);
  const digest = createHash("sha256").update(buf).digest("hex");
  if (digest !== item.sha256.toLowerCase()) {
    throw new ProvisionError(
      `sha256 mismatch for "${item.name}": manifest pinned ${item.sha256}, artifact is ${digest}`,
      "sha256_mismatch",
    );
  }
  assertDecompressionBounded(buf);

  const archiveDir = mkdtempSync(path.join(tmpdir(), "provision-archive-"));
  // Staging lives INSIDE skillsDir so the final rename is same-filesystem (atomic),
  // and dot-prefixed so skill loaders scanning the directory skip it.
  mkdirSync(opts.skillsDir, { recursive: true });
  const candidate = path.join(
    opts.skillsDir,
    `.provision-candidate-${randomBytes(16).toString("hex")}`,
  );
  mkdirSync(candidate, { mode: 0o700 });
  let staging: string;
  let stagingRecoveryFileHashes: Record<string, string> | undefined;
  if (opts.upgradeRecoveryId !== undefined) {
    if (!RECOVERY_ID_PATTERN.test(opts.upgradeRecoveryId) || opts.managedFiles === undefined) {
      throw new ProvisionError("Invalid upgrade recovery identity", "invalid_item");
    }
    staging = path.join(opts.skillsDir, `${UPGRADE_RECOVERY_PREFIX}${opts.upgradeRecoveryId}`);
    mkdirSync(staging, { mode: 0o700 });
    writeFileSync(path.join(staging, UPGRADE_RECOVERY_METADATA), JSON.stringify({
      version: 1,
      skill: item.name,
      createdAt: new Date().toISOString(),
      recoveryId: opts.upgradeRecoveryId,
    }));
  } else {
    staging = mkdtempSync(path.join(opts.skillsDir, UPGRADE_RECOVERY_PREFIX));
  }
  let preserveStaging = false;
  let preserveCandidate = false;
  try {
    const archivePath = path.join(archiveDir, "artifact.tgz");
    writeFileSync(archivePath, buf);
    const stripWrapper = assertArchiveSafe(archivePath);

    try {
      execFileSync("tar", [
	"-xzf",
	archivePath,
	"-C",
	candidate,
	...(stripWrapper ? ["--strip-components=1"] : []),
      ]);
    } catch {
      throw new ProvisionError("Extraction failed", "archive_rejected");
    }

    // A root `./` entry can overwrite the candidate's mode. Restore access
    // before inspecting the direct sibling that will be atomically exposed.
    normalizeExtractedModes(candidate);
    const result = auditTree(candidate);
    if (result.files.length === 0) {
      throw new ProvisionError("Archive contains no files", "archive_rejected");
    }

    const target = path.join(opts.skillsDir, item.name);
    const firstInstall = opts.managedFiles === undefined;
    if (firstInstall && targetExists(target)) {
      throw new ProvisionError(
	`Refusing to replace "${item.name}" because the target appeared during installation`,
	"untracked_content",
      );
    }
    if (!firstInstall && hasUntrackedContent(
      target,
      new Set(opts.managedFiles),
      opts.managedDirectories !== undefined ? new Set(opts.managedDirectories) : undefined,
    )) {
      throw new ProvisionError(
	`Refusing to replace "${item.name}" because it contains untracked files`,
	"untracked_content",
      );
    }
    // Persist ownership before either the old or new target moves. First
    // installs recheck after this write and undo the preclaim if exposure fails;
    // upgrades retain their stable+pending recovery journal on swap failures.
    if (firstInstall && opts.firstInstallMarker) {
      writeFileSync(firstInstallMarkerPath(candidate, opts.firstInstallMarker), opts.firstInstallMarker, {
	flag: "wx",
	mode: 0o600,
      });
    }
    const rollbackCommit = opts.beforeCommit?.(result);
    if (firstInstall) {
      if (targetExists(target)) {
	rollbackCommit?.();
	throw new ProvisionError(
	  `Refusing to replace "${item.name}" because the target appeared during installation`,
	  "untracked_content",
	);
      }
      try {
	opts.beforeCandidateMove?.(target);
	if (!moveDirectoryNoReplace(
	  candidate,
	  target,
	  () => opts.beforeCandidateRename?.(target),
	)) {
	  preserveCandidate = true;
	  throw new ProvisionError(
	    `Refusing to replace "${item.name}" because the target appeared during installation; candidate preserved at "${candidate}"`,
	    "untracked_content",
	  );
	}
      } catch (err) {
	preserveCandidate = targetExists(candidate);
	rollbackCommit?.();
	throw err;
      }
      opts.afterFirstInstallMove?.(target);
      return result;
    }
    const previous = path.join(staging, "previous");
    let hadPrevious = false;
    try {
      renameSync(target, previous);
      hadPrevious = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    opts.afterPreviousMove?.();
    if (hadPrevious && hasUntrackedContent(
      previous,
      new Set(opts.managedFiles!),
      opts.managedDirectories !== undefined ? new Set(opts.managedDirectories) : undefined,
    )) {
      try {
	renameSync(previous, target);
      } catch (err) {
	if (!["EEXIST", "ENOTEMPTY"].includes((err as NodeJS.ErrnoException).code ?? "")) {
	  throw err;
	}
	preserveStaging = true;
	throw new ProvisionError(
	  `Refusing to replace "${item.name}" because content was added during installation; prior contents preserved at "${previous}"`,
	  "untracked_content",
	);
      }
      hadPrevious = false;
      throw new ProvisionError(
	`Refusing to replace "${item.name}" because content was added during installation`,
	"untracked_content",
      );
    }
    if (hadPrevious) opts.afterPreviousAudit?.(previous);
    try {
      opts.beforeCandidateMove?.(target);

      if (!moveDirectoryNoReplace(
	candidate,
	target,
	() => opts.beforeCandidateRename?.(target),
      )) {
	preserveCandidate = true;
	if (hadPrevious) {
	  preserveStaging = true;
	  throw new ProvisionError(
	    `Upgrade failed because the target was recreated; prior contents preserved at "${previous}" and candidate at "${candidate}"`,
	    "untracked_content",
	  );
	}
	throw new ProvisionError(
	  `Refusing to replace "${item.name}" because the target appeared during installation; candidate preserved at "${candidate}"`,
	  "untracked_content",
	);
      }
    } catch (err) {
      if (err instanceof ProvisionError && err.code === "untracked_content") throw err;
      if (hadPrevious) {
	preserveStaging = true;
      }
      preserveCandidate = targetExists(candidate);
      throw err;
    }
    if (hadPrevious) {
      // A process with an open descriptor to the moved directory can still add
      // content after the audit above. Delete only recorded old content, never
      // the whole tree, so anything racing cleanup remains recoverable.
      preserveStaging = true;
      const previousCleanup = removeManagedTree(previous, {
	files: opts.managedFiles!,
	directories: opts.managedDirectories,
	fileHashes: opts.managedFileHashes,
	afterFileHash: (relative) => opts.afterCleanupHash?.(previous, relative),
	// An inode can still be writable through a descriptor opened before its
	// rename. Retaining the isolated link is the only portable way to ensure a
	// later write is recoverable; the hidden staging tree is therefore kept.
	preserveIsolatedFiles: true,
      });
      if (!previousCleanup.clean) {
	throw new ProvisionError(
	  `Upgrade completed, but content added during installation was preserved at "${previous}"`,
	  "untracked_content",
	);
      }
      preserveStaging = previousCleanup.recoveryPath !== undefined;
      if (previousCleanup.recoveryPath && previousCleanup.recoveryFileHashes) {
	const recoveryRoot = path.relative(staging, previousCleanup.recoveryPath)
	  .split(path.sep).join("/");
	stagingRecoveryFileHashes = Object.fromEntries(
	  Object.entries(previousCleanup.recoveryFileHashes).map(([relative, hash]) => [
	    `${recoveryRoot}/${relative}`,
	    hash,
	  ]),
	);
      }
    }
    return result;
  } finally {
    try {
      try {
	if (!preserveCandidate) rmSync(candidate, { recursive: true, force: true });
      } finally {
	if (!preserveStaging) {
	  rmSync(staging, { recursive: true, force: true });
	} else if (stagingRecoveryFileHashes) {
	  sealRecovery(staging, UPGRADE_RECOVERY_METADATA, stagingRecoveryFileHashes);
	}
      }
    } finally {
      rmSync(archiveDir, { recursive: true, force: true });
    }
  }
}

/**
 * Publish a sibling directory without replacing an entry created by another
 * process. Windows rename already refuses an existing directory; POSIX uses
 * renameat2(RENAME_NOREPLACE) or renameatx_np(RENAME_EXCL) through a Node-API
 * helper because no check-then-rename sequence can close this race.
 */
function moveDirectoryNoReplace(
  source: string,
  target: string,
  beforeRename?: () => void,
): boolean {
  if (process.platform === "win32") {
    beforeRename?.();
    try {
      renameSync(source, target);
      return true;
    } catch (err) {
      if (targetExists(target)) return false;
      throw err;
    }
  }
  beforeRename?.();
  return renameDirectoryNoReplace(source, target);
}

function targetExists(target: string): boolean {
  try {
    lstatSync(target);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

function hasUntrackedContent(
  root: string,
  managedFiles: Set<string>,
  managedDirectories?: Set<string>,
): boolean {
  try {
    if (!lstatSync(root).isDirectory()) return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
  const walk = (dir: string): boolean => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      const stat = lstatSync(full);
      if (stat.isDirectory()) {
	const relative = path.relative(root, full).split(path.sep).join("/");
	if (managedDirectories && !managedDirectories.has(relative)) return true;
	if (walk(full)) return true;
	continue;
      }
      const relative = path.relative(root, full).split(path.sep).join("/");
      if (!stat.isFile() || !managedFiles.has(relative)) return true;
    }
    return false;
  };
  return walk(root);
}

function existsAsDirectory(target: string): boolean {
  try {
    return lstatSync(target).isDirectory();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

function managedPath(root: string, relative: string): string | null {
  const parts = managedPathParts(relative);
  if (!parts) return null;
  return path.join(root, ...parts);
}

function removeManagedTree(
  root: string,
  opts: {
    files: string[];
    directories?: string[];
    fileHashes?: Record<string, string | string[]>;
    afterFileHash?: (relative: string) => void;
    /** Keep isolated inodes linked so writes through already-open descriptors survive. */
    preserveIsolatedFiles?: boolean;
    /** Place retained inode links outside root so an uninstall can remove its visible target. */
    quarantineParent?: string;
    /** Metadata for bounded removal recovery directories. */
    quarantineSkill?: string;
    /** Exact lockfile-owned identity for this recovery directory. */
    recoveryId?: string;
  },
): {
  clean: boolean;
  recoveryPath?: string;
  /** Hashes captured before any post-quarantine descriptor write can occur. */
  recoveryFileHashes?: Record<string, string>;
} {
  if (!existsAsDirectory(root)) return { clean: !targetExists(root) };

  const removed: string[] = [];
  let quarantine: string | undefined;
  const recoveryFileHashes: Record<string, string> = {};
  let unverifiedRecovery = false;
  for (const [index, relative] of opts.files.entries()) {
    const file = managedPath(root, relative);
    if (!file) continue;
    const parts = managedPathParts(relative)!;
    let safe = true;
    let current = root;
    for (const part of parts.slice(0, -1)) {
      current = path.join(current, part);
      try {
	if (!lstatSync(current).isDirectory()) safe = false;
      } catch (err) {
	if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	safe = false;
      }
      if (!safe) break;
    }
    if (!safe) continue;
    try {
      const stat = lstatSync(file);
      if (!stat.isFile()) continue;
      if (!quarantine) {
	if (opts.quarantineParent && opts.recoveryId) {
	  quarantine = path.join(opts.quarantineParent, `${REMOVAL_RECOVERY_PREFIX}${opts.recoveryId}`);
	  mkdirSync(quarantine, { mode: 0o700 });
	} else {
	  quarantine = mkdtempSync(path.join(root, ".provision-cleanup-"));
	}
	if (opts.quarantineParent && opts.quarantineSkill) {
	  writeFileSync(path.join(quarantine, REMOVAL_RECOVERY_METADATA), JSON.stringify({
	    version: 1,
	    skill: opts.quarantineSkill,
	    createdAt: new Date().toISOString(),
	    recoveryId: opts.recoveryId,
	  }));
	}
      }
      const isolated = path.join(quarantine, String(index));
      renameSync(file, isolated);
      const expected = opts.fileHashes?.[relative];
      let verifiedHash: string | undefined;
      if (expected) {
	const actual = createHash("sha256").update(readFileSync(isolated)).digest("hex");
	const accepted = Array.isArray(expected) ? expected : [expected];
	if (!accepted.includes(actual)) {
	  let restored = true;
	  try {
	    renameSync(isolated, file);
	  } catch (err) {
	    if (!["EEXIST", "ENOTEMPTY", "ENOENT"].includes(
	      (err as NodeJS.ErrnoException).code ?? "",
	    )) throw err;
	    restored = false;
	  }
	  if (!restored) unverifiedRecovery = true;
	  continue;
	}
	verifiedHash = actual;
      }
      opts.afterFileHash?.(relative);
      if (!opts.preserveIsolatedFiles) {
	rmSync(isolated, { force: true });
      } else if (verifiedHash) {
	recoveryFileHashes[path.relative(quarantine, isolated).split(path.sep).join("/")] = verifiedHash;
      } else {
	unverifiedRecovery = true;
      }
      removed.push(relative);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  let recoveryPath: string | undefined;
  if (quarantine) {
    try {
      rmdirSync(quarantine);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTEMPTY") throw err;
      if (code === "ENOTEMPTY") recoveryPath = quarantine;
    }
  }
  const directories = new Set<string>();
  for (const relative of opts.directories ?? []) {
    const directory = managedPath(root, relative);
    if (directory) directories.add(directory);
  }
  for (const relative of removed) {
    let current = path.dirname(managedPath(root, relative)!);
    while (current !== root && current.startsWith(`${root}${path.sep}`)) {
      directories.add(current);
      current = path.dirname(current);
    }
  }
  for (const directory of [...directories].sort((a, b) => b.split(path.sep).length - a.split(path.sep).length)) {
    try {
      rmdirSync(directory);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTEMPTY") throw err;
    }
  }
  try {
    rmdirSync(root);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY") throw err;
  }
  const rootRemoved = !targetExists(root);
  const clean = rootRemoved || (recoveryPath !== undefined
    && readdirSync(root).every((entry) => path.join(root, entry) === recoveryPath));
  return {
    clean,
    recoveryPath,
    ...(recoveryPath && !unverifiedRecovery && Object.keys(recoveryFileHashes).length > 0
      ? { recoveryFileHashes }
      : {}),
  };
}

function inspectRecoveryTree(
  root: string,
  metadataName: string,
): { files: Record<string, string>; directories: string[] } | null {
  const files: Record<string, string> = {};
  const directories: string[] = [];
  try {
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory)) {
	const full = path.join(directory, entry);
	const relative = path.relative(root, full).split(path.sep).join("/");
	if (relative === metadataName) continue;
	const stat = lstatSync(full);
	if (stat.isDirectory()) {
	  directories.push(relative);
	  walk(full);
	} else if (stat.isFile()) {
	  files[relative] = createHash("sha256").update(readFileSync(full)).digest("hex");
	} else {
	  throw new Error("Unexpected recovery entry type");
	}
      }
    };
    walk(root);
    directories.sort();
    return { files, directories };
  } catch {
    return null;
  }
}

function sealRecovery(
  directory: string,
  metadataName: string,
  trustedFileHashes: Record<string, string>,
): void {
  try {
    const metadataFile = path.join(directory, metadataName);
    const metadata = JSON.parse(readFileSync(metadataFile, "utf8")) as Record<string, unknown>;
    const inspected = inspectRecoveryTree(directory, metadataName);
    if (!inspected) return;
    const actualFiles = Object.keys(inspected.files).sort();
    const trustedFiles = Object.keys(trustedFileHashes).sort();
    if (actualFiles.length !== trustedFiles.length
	|| actualFiles.some((relative, index) => relative !== trustedFiles[index])) return;
    writeFileSync(metadataFile, JSON.stringify({
      ...metadata,
      version: 2,
      retainedFiles: trustedFileHashes,
      retainedDirectories: inspected.directories,
    }));
  } catch {
    // An unsealed recovery is retained for explicit operator cleanup.
  }
}

/** Remove only recorded regular files, leaving modified or added user content. */
export function removeSkill(
  name: string,
  opts: {
    skillsDir: string;
    files: string[];
    directories?: string[];
    fileHashes?: Record<string, string | string[]>;
    /** New identity preclaimed in the lockfile before this removal begins. */
    recoveryId?: string;
  },
): { recoveryPath?: string } {
  if (!NAME_PATTERN.test(name)) {
    throw new ProvisionError(`Invalid skill name "${name}"`, "invalid_item");
  }
  const recoveryId = opts.recoveryId ?? randomBytes(16).toString("hex");
  if (!RECOVERY_ID_PATTERN.test(recoveryId)) {
    throw new ProvisionError("Invalid recovery identity", "invalid_item");
  }
  const result = removeManagedTree(path.join(opts.skillsDir, name), {
    ...opts,
    // An already-open descriptor can mutate the isolated inode after its hash
    // check. Keep the link in a hidden sibling recovery directory while still
    // removing the visible skill target.
    preserveIsolatedFiles: true,
    quarantineParent: opts.skillsDir,
    quarantineSkill: name,
    recoveryId,
  });
  if (result.recoveryPath && result.recoveryFileHashes) {
    sealRecovery(result.recoveryPath, REMOVAL_RECOVERY_METADATA, result.recoveryFileHashes);
  }
  return { recoveryPath: result.recoveryPath };
}
