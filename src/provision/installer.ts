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
import { createHash } from "crypto";
import {
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

/** Same charset the manifest enforces; re-checked here so no other caller can widen it. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

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
function assertArchiveSafe(archivePath: string): void {
  let verbose: string;
  let names: string;
  try {
    const opts = { encoding: "utf-8" as const, maxBuffer: MAX_ARCHIVE_BYTES };
    verbose = execFileSync("tar", ["-tvzf", archivePath], opts);
    names = execFileSync("tar", ["-tzf", archivePath], opts);
  } catch {
    throw new ProvisionError("Artifact is not a readable tar.gz", "archive_rejected");
  }
  for (const line of verbose.split("\n").filter(Boolean)) {
    if (line[0] === "l" || line[0] === "h") {
      throw new ProvisionError("Archive contains a link entry", "archive_rejected");
    }
  }
  for (const name of names.split("\n").filter(Boolean)) {
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

export async function installSkill(
  item: { name: string; url: string; sha256: string },
  opts: {
    skillsDir: string;
    checkUrl?: (url: string) => void;
    /** Persist ownership before exposure; return an undo for a failed first-install rename. */
    beforeCommit?: (result: InstallResult) => void | (() => void);
    /** Existing managed paths; an upgrade must not erase additions outside this set. */
    managedFiles?: string[];
    /** Existing managed directories; omitted for legacy lockfiles that did not track them. */
    managedDirectories?: string[];
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
  const staging = mkdtempSync(path.join(opts.skillsDir, ".provision-staging-"));
  try {
    const archivePath = path.join(archiveDir, "artifact.tgz");
    writeFileSync(archivePath, buf);
    assertArchiveSafe(archivePath);

    const extractDir = path.join(staging, "extract");
    mkdirSync(extractDir);
    try {
      execFileSync("tar", ["-xzf", archivePath, "-C", extractDir]);
    } catch {
      throw new ProvisionError("Extraction failed", "archive_rejected");
    }

    // Accept both layouts: files at the archive root, or everything under one
    // top-level directory (the common `name-version/` tarball convention).
    let root = extractDir;
    const entries = readdirSync(extractDir);
    if (entries.length === 1 && lstatSync(path.join(extractDir, entries[0]!)).isDirectory()) {
      root = path.join(extractDir, entries[0]!);
    }

    const result = auditTree(root);
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
	renameSync(root, target);
      } catch (err) {
	rollbackCommit?.();
	if (["EEXIST", "ENOTEMPTY"].includes((err as NodeJS.ErrnoException).code ?? "")) {
	  throw new ProvisionError(
	    `Refusing to replace "${item.name}" because the target appeared during installation`,
	    "untracked_content",
	  );
	}
	throw err;
      }
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
    if (hadPrevious && hasUntrackedContent(
      previous,
      new Set(opts.managedFiles!),
      opts.managedDirectories !== undefined ? new Set(opts.managedDirectories) : undefined,
    )) {
      renameSync(previous, target);
      hadPrevious = false;
      throw new ProvisionError(
	`Refusing to replace "${item.name}" because content was added during installation`,
	"untracked_content",
      );
    }
    try {
      renameSync(root, target);
    } catch (err) {
      if (hadPrevious) renameSync(previous, target);
      throw err;
    }
    return result;
  } finally {
    rmSync(staging, { recursive: true, force: true });
    rmSync(archiveDir, { recursive: true, force: true });
  }
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

/** Remove only recorded regular files, leaving modified or added user content. */
export function removeSkill(
  name: string,
  opts: {
    skillsDir: string;
    files: string[];
    directories?: string[];
    fileHashes?: Record<string, string>;
  },
): void {
  if (!NAME_PATTERN.test(name)) {
    throw new ProvisionError(`Invalid skill name "${name}"`, "invalid_item");
  }
  const root = path.join(opts.skillsDir, name);
  if (!existsAsDirectory(root)) return;

  const removable: Array<{ file: string; relative: string }> = [];
  for (const relative of opts.files) {
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
      const expected = opts.fileHashes?.[relative];
      if (expected) {
	const actual = createHash("sha256").update(readFileSync(file)).digest("hex");
	if (actual !== expected) continue;
      }
      removable.push({ file, relative });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  for (const { file } of removable) rmSync(file, { force: true });
  const directories = new Set<string>();
  for (const relative of opts.directories ?? []) {
    const directory = managedPath(root, relative);
    if (directory) directories.add(directory);
  }
  for (const { relative } of removable) {
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
}
