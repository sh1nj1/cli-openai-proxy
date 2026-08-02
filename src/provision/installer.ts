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
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";
import { gunzipSync } from "zlib";
import { fetchWithPolicy } from "./manifest.js";
import { ProvisionError } from "./types.js";

export interface InstallResult {
  /** Installed file paths relative to the skill's directory. */
  files: string[];
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
  const chunks: Buffer[] = [];
  let total = 0;
  const body = response.body;
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  try {
    for (;;) {
      let step: { done: boolean; value?: Uint8Array };
      try {
        step = await reader.read();
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new ProvisionError(`Download failed: ${reason}`, "download_failed");
      }
      if (step.done || !step.value) break;
      total += step.value.byteLength;
      if (total > MAX_ARCHIVE_BYTES) {
        throw new ProvisionError(`Archive exceeds ${MAX_ARCHIVE_BYTES} bytes`, "archive_rejected");
      }
      chunks.push(Buffer.from(step.value));
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
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
    if (path.isAbsolute(name) || name.split("/").includes("..")) {
      throw new ProvisionError(`Archive entry escapes its root: ${name}`, "archive_rejected");
    }
  }
}

/** Walk the extracted tree, enforcing the audit, returning relative file paths. */
function auditTree(root: string): string[] {
  const files: string[] = [];
  let total = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) {
        throw new ProvisionError("Extracted tree contains a symlink", "archive_rejected");
      }
      if (stat.isDirectory()) {
        walk(full);
        continue;
      }
      if (!stat.isFile()) {
        throw new ProvisionError(`Not a regular file: ${entry}`, "archive_rejected");
      }
      const relative = path.relative(root, full).split(path.sep).join("/");
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
    }
  };
  walk(root);
  return files;
}

export async function installSkill(
  item: { name: string; url: string; sha256: string },
  opts: { skillsDir: string; checkUrl?: (url: string) => void },
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

    const files = auditTree(root);
    if (files.length === 0) {
      throw new ProvisionError("Archive contains no files", "archive_rejected");
    }

    const target = path.join(opts.skillsDir, item.name);
    const previous = path.join(staging, "previous");
    let hadPrevious = false;
    try {
      renameSync(target, previous);
      hadPrevious = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    try {
      renameSync(root, target);
    } catch (err) {
      if (hadPrevious) renameSync(previous, target);
      throw err;
    }
    return { files };
  } finally {
    rmSync(staging, { recursive: true, force: true });
    rmSync(archiveDir, { recursive: true, force: true });
  }
}

export function removeSkill(name: string, opts: { skillsDir: string }): void {
  if (!NAME_PATTERN.test(name)) {
    throw new ProvisionError(`Invalid skill name "${name}"`, "invalid_item");
  }
  rmSync(path.join(opts.skillsDir, name), { recursive: true, force: true });
}
