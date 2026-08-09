import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { getSystemErrorName } from "node:util";
import { ProvisionError } from "./types.js";

interface NativeRenameBinding {
  metadata(): unknown;
  renameNoReplace(parentFd: number, source: string, destination: string): unknown;
  removeAt(parentFd: number, basename: string, directory: boolean): unknown;
}

const HELPER_VERSION = "0.5.0-beta.1";
const nativeRequire = createRequire(import.meta.url);
const packageTargets = new Map<string, string>([
  ["darwin:arm64:none", "@skill-steward/rename-noreplace-darwin-arm64"],
  ["darwin:x64:none", "@skill-steward/rename-noreplace-darwin-x64"],
  ["linux:arm64:gnu", "@skill-steward/rename-noreplace-linux-arm64-gnu"],
  ["linux:arm64:musl", "@skill-steward/rename-noreplace-linux-arm64-musl"],
  ["linux:x64:gnu", "@skill-steward/rename-noreplace-linux-x64-gnu"],
  ["linux:x64:musl", "@skill-steward/rename-noreplace-linux-x64-musl"],
]);
let cachedBinding: NativeRenameBinding | undefined;

function runtimeLibc(): "none" | "gnu" | "musl" {
  if (process.platform !== "linux") return "none";
  const report = process.report.getReport() as { header: { glibcVersionRuntime?: string } };
  return report.header.glibcVersionRuntime === undefined ? "musl" : "gnu";
}

function loadBinding(): NativeRenameBinding {
  if (cachedBinding) return cachedBinding;
  const target = `${process.platform}:${process.arch}:${runtimeLibc()}`;
  const packageName = packageTargets.get(target);
  if (!packageName) {
    throw new ProvisionError(
      `Atomic no-replace rename is unavailable on ${process.platform}/${process.arch}`,
      "atomic_rename_unavailable",
    );
  }

  let manifest: unknown;
  let candidate: unknown;
  try {
    manifest = nativeRequire(`${packageName}/package.json`);
    candidate = nativeRequire(packageName);
  } catch (err) {
    throw new ProvisionError(
      `Atomic no-replace rename helper is unavailable: ${(err as Error).message}`,
      "atomic_rename_unavailable",
    );
  }
  if (
    manifest === null
    || typeof manifest !== "object"
    || (manifest as { name?: unknown }).name !== packageName
    || (manifest as { version?: unknown }).version !== HELPER_VERSION
    || candidate === null
    || typeof candidate !== "object"
    || typeof (candidate as Partial<NativeRenameBinding>).metadata !== "function"
    || typeof (candidate as Partial<NativeRenameBinding>).renameNoReplace !== "function"
    || typeof (candidate as Partial<NativeRenameBinding>).removeAt !== "function"
  ) {
    throw new ProvisionError(
      "Atomic no-replace rename helper failed validation",
      "atomic_rename_unavailable",
    );
  }

  const binding = candidate as NativeRenameBinding;
  const expectedMetadata = `skill-steward.owned-tree-native.v3:${HELPER_VERSION}:${target}`;
  if (binding.metadata() !== expectedMetadata) {
    throw new ProvisionError(
      "Atomic no-replace rename helper does not match this runtime",
      "atomic_rename_unavailable",
    );
  }
  cachedBinding = binding;
  return binding;
}

function resultCode(result: unknown, operation: string): number {
  if (!Number.isInteger(result) || (result as number) < 0) {
    throw new ProvisionError(
      `Atomic ${operation} helper returned an invalid result`,
      "atomic_rename_unavailable",
    );
  }
  return result as number;
}

function assertSiblingBasenames(...names: string[]): void {
  if (names.some((name) => path.basename(name) !== name || name === "." || name === "..")) {
    throw new ProvisionError("FD-relative operation requires sibling basenames", "invalid_item");
  }
}

function sameSiblingIdentity(
  parentPath: string,
  first: string,
  second: string,
  expectedFd?: number,
): boolean {
  try {
    const left = lstatSync(path.join(parentPath, first), { bigint: true });
    const right = lstatSync(path.join(parentPath, second), { bigint: true });
    const expected = expectedFd === undefined ? left : fstatSync(expectedFd, { bigint: true });
    return left.isFile()
      && right.isFile()
      && expected.isFile()
      && left.dev === right.dev
      && left.ino === right.ino
      && left.dev === expected.dev
      && left.ino === expected.ino;
  } catch {
    return false;
  }
}

const VERIFIED_DIRECTORY_PREFIX = [
  'const fs = require("node:fs")',
  "const opened = fs.fstatSync(3, { bigint: true })",
  'const cwd = fs.statSync(".", { bigint: true })',
  "if (!opened.isDirectory() || opened.dev !== cwd.dev || opened.ino !== cwd.ino) process.exit(65)",
];

const WINDOWS_NOREPLACE_SCRIPT = [
  ...VERIFIED_DIRECTORY_PREFIX,
  "try { fs.linkSync(process.argv[1], process.argv[2]) } "
    + 'catch (err) { if (err && err.code === "EEXIST") process.exit(17); throw err }',
  "fs.unlinkSync(process.argv[1])",
].join(";");

const WINDOWS_REMOVE_SCRIPT = [
  ...VERIFIED_DIRECTORY_PREFIX,
  "try { process.argv[2] === \"1\" ? fs.rmdirSync(process.argv[1]) : fs.unlinkSync(process.argv[1]) } "
    + 'catch (err) { if (err && err.code === "ENOENT") process.exit(2); throw err }',
].join(";");

const MKDIR_AT_SCRIPT = [
  ...VERIFIED_DIRECTORY_PREFIX,
  'try { fs.mkdirSync(process.argv[1], { mode: 0o700 }) } catch (err) { '
    + 'if (err && err.code === "EEXIST") process.exit(17); throw err }',
  "const created = fs.lstatSync(process.argv[1], { bigint: true })",
  "if (!created.isDirectory()) process.exit(66)",
  "process.stdout.write(JSON.stringify({ dev: created.dev.toString(), ino: created.ino.toString() }))",
].join(";");

const SYMLINK_AT_SCRIPT = [
  ...VERIFIED_DIRECTORY_PREFIX,
  'try { fs.symlinkSync(process.argv[1], process.argv[2], process.argv[3]) } catch (err) { '
    + 'if (err && err.code === "EEXIST") process.exit(17); throw err }',
  "const created = fs.lstatSync(process.argv[2], { bigint: true })",
  "if (!created.isSymbolicLink() || fs.readlinkSync(process.argv[2]) !== process.argv[1]) process.exit(66)",
  "process.stdout.write(JSON.stringify({ dev: created.dev.toString(), ino: created.ino.toString() }))",
].join(";");

const INSPECT_AT_IDENTITY_SCRIPT = [
  ...VERIFIED_DIRECTORY_PREFIX,
  "let candidate",
  "try { candidate = fs.lstatSync(process.argv[1], { bigint: true }) } "
    + 'catch (err) { if (err && err.code === "ENOENT") process.exit(2); throw err }',
  "if (candidate.dev.toString() !== process.argv[3] "
    + "|| candidate.ino.toString() !== process.argv[4] "
    + "|| (process.argv[2] === '1') !== candidate.isDirectory()) process.exit(66)",
].join(";");

const INSPECT_SYMLINK_AT_SCRIPT = [
  ...VERIFIED_DIRECTORY_PREFIX,
  "let candidate",
  "try { candidate = fs.lstatSync(process.argv[2], { bigint: true }) } "
    + 'catch (err) { if (err && err.code === "ENOENT") process.exit(2); throw err }',
  "if (!candidate.isSymbolicLink() || fs.readlinkSync(process.argv[2]) !== process.argv[1]) process.exit(66)",
  "process.stdout.write(JSON.stringify({ dev: candidate.dev.toString(), ino: candidate.ino.toString() }))",
].join(";");

const WINDOWS_REMOVE_PUBLISHED_LINK_SCRIPT = [
  ...VERIFIED_DIRECTORY_PREFIX,
  "const expectedDev = process.argv[3]",
  "const expectedIno = process.argv[4]",
  "const published = fs.lstatSync(process.argv[2], { bigint: true })",
  "if (!published.isFile() || published.dev.toString() !== expectedDev "
    + "|| published.ino.toString() !== expectedIno) process.exit(66)",
  "let candidate",
  "try { candidate = fs.lstatSync(process.argv[1], { bigint: true }) } "
    + 'catch (err) { if (err && err.code === "ENOENT") process.exit(2); throw err }',
  "if (!candidate.isFile() || candidate.dev !== published.dev "
    + "|| candidate.ino !== published.ino || published.nlink < 2n) process.exit(66)",
  "fs.unlinkSync(process.argv[1])",
  "const remaining = fs.lstatSync(process.argv[2], { bigint: true })",
  "if (!remaining.isFile() || remaining.dev.toString() !== expectedDev "
    + "|| remaining.ino.toString() !== expectedIno) process.exit(66)",
].join(";");

function spawnVerifiedChild(
  parentFd: number,
  parentPath: string,
  script: string,
  args: string[],
) {
  return spawnSync(process.execPath, ["-e", script, ...args], {
    cwd: parentPath,
    stdio: ["ignore", "ignore", "ignore", parentFd],
  });
}

function spawnVerifiedChildWithOutput(
  parentFd: number,
  parentPath: string,
  script: string,
  args: string[],
) {
  return spawnSync(process.execPath, ["-e", script, ...args], {
    cwd: parentPath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore", parentFd],
  });
}

type VerifiedOutputChildResult = Pick<
  ReturnType<typeof spawnVerifiedChildWithOutput>,
  "status" | "stdout"
>;
type VerifiedOutputChildRunner = (
  parentFd: number,
  parentPath: string,
  script: string,
  args: string[],
) => VerifiedOutputChildResult;

export interface AnchoredEntryIdentity {
  dev: string;
  ino: string;
}

/** The helper may have published below the opened parent, but cannot prove its result. */
export class AnchoredPublicationAmbiguousError extends ProvisionError {
  constructor(message: string) {
    super(message, "atomic_rename_unavailable");
    this.name = "AnchoredPublicationAmbiguousError";
  }
}

function parseAnchoredIdentity(output: string | Buffer | null): AnchoredEntryIdentity {
  try {
    const parsed = JSON.parse(output?.toString() ?? "") as Partial<AnchoredEntryIdentity>;
    if (typeof parsed.dev === "string" && /^\d+$/.test(parsed.dev)
      && typeof parsed.ino === "string" && /^\d+$/.test(parsed.ino)) {
      return { dev: parsed.dev, ino: parsed.ino };
    }
  } catch {
    // Normalize malformed helper output below.
  }
  throw new ProvisionError("Anchored filesystem helper returned invalid identity", "atomic_rename_unavailable");
}

/** Create one directory basename relative to a cwd verified against an open parent FD. */
export function mkdirAt(
  parentFd: number,
  parentPath: string,
  basename: string,
): AnchoredEntryIdentity | undefined {
  assertSiblingBasenames(basename);
  const child = spawnVerifiedChildWithOutput(parentFd, parentPath, MKDIR_AT_SCRIPT, [basename]);
  if (child.status === 0) return parseAnchoredIdentity(child.stdout);
  if (child.status === 17) return undefined;
  if (child.status === 65) {
    throw new ProvisionError("Directory parent changed during creation", "untracked_content");
  }
  throw new ProvisionError("Anchored directory creation failed", "atomic_rename_unavailable");
}

/** Create one symlink basename relative to a cwd verified against an open parent FD. */
export function symlinkAt(
  parentFd: number,
  parentPath: string,
  target: string,
  basename: string,
  type: "dir" | "junction",
  runVerifiedChild: VerifiedOutputChildRunner = spawnVerifiedChildWithOutput,
): AnchoredEntryIdentity | undefined {
  assertSiblingBasenames(basename);
  const child = runVerifiedChild(
    parentFd,
    parentPath,
    SYMLINK_AT_SCRIPT,
    [target, basename, type],
  );
  if (child.status === 0) return parseAnchoredIdentity(child.stdout);
  if (child.status === 17) return undefined;
  if (child.status === 65) {
    throw new ProvisionError("Skill link parent changed during publication", "untracked_content");
  }
  const inspected = spawnVerifiedChildWithOutput(
    parentFd,
    parentPath,
    INSPECT_SYMLINK_AT_SCRIPT,
    [target, basename],
  );
  if (inspected.status === 0) return parseAnchoredIdentity(inspected.stdout);
  if (inspected.status === 2) {
    throw new ProvisionError("Anchored skill link publication failed", "atomic_rename_unavailable");
  }
  if (inspected.status === 65) {
    throw new AnchoredPublicationAmbiguousError(
      "Skill link parent changed while an ambiguous publication was recovered",
    );
  }
  throw new AnchoredPublicationAmbiguousError(
    "Anchored skill link publication may have completed without recoverable identity",
  );
}

/** Remove one anchored entry only when its current identity is still the recorded inode. */
export function removeAtIdentity(
  parentFd: number,
  parentPath: string,
  basename: string,
  directory: boolean,
  expected: AnchoredEntryIdentity,
  renameOperation: typeof renameEntryAtNoReplace = renameEntryAtNoReplace,
): boolean {
  assertSiblingBasenames(basename);
  const quarantine = `.provision-retained-${randomBytes(16).toString("hex")}`;
  let moved: boolean;
  try {
    moved = renameOperation(parentFd, parentPath, basename, quarantine);
  } catch (err) {
    if (entryAtMatchesIdentity(parentFd, parentPath, quarantine, directory, expected)) {
      moved = true;
    } else {
      throw err;
    }
  }
  if (!moved) return false;
  if (!entryAtMatchesIdentity(parentFd, parentPath, quarantine, directory, expected)) {
    renameOperation(parentFd, parentPath, quarantine, basename);
    return false;
  }
  try {
    return removeAt(parentFd, parentPath, quarantine, directory);
  } catch (err) {
    let restored = false;
    try {
      restored = renameOperation(parentFd, parentPath, quarantine, basename);
    } catch (restoreError) {
      throw new ProvisionError(
	`Anchored cleanup failed and its quarantine could not be restored: ${
	  restoreError instanceof Error ? restoreError.message : String(restoreError)
	}`,
	"atomic_rename_unavailable",
      );
    }
    if (!restored) {
      throw new ProvisionError(
	"Anchored cleanup failed and its quarantine destination was occupied",
	"untracked_content",
      );
    }
    throw err;
  }
}

function entryAtMatchesIdentity(
  parentFd: number,
  parentPath: string,
  basename: string,
  directory: boolean,
  expected: AnchoredEntryIdentity,
): boolean {
  const child = spawnVerifiedChild(
    parentFd,
    parentPath,
    INSPECT_AT_IDENTITY_SCRIPT,
    [basename, directory ? "1" : "0", expected.dev, expected.ino],
  );
  if (child.status === 0) return true;
  if (child.status === 2 || child.status === 66) return false;
  if (child.status === 65) {
    throw new ProvisionError("Identity inspection parent changed", "untracked_content");
  }
  throw new ProvisionError("Anchored identity inspection failed", "atomic_rename_unavailable");
}

function renameEntryAtNoReplace(
  parentFd: number,
  parentPath: string,
  source: string,
  destination: string,
): boolean {
  if (process.platform !== "win32") {
    return renameAtNoReplace(parentFd, parentPath, source, destination);
  }
  throw new ProvisionError(
    "Anchored no-replace entry rename is unavailable on Windows",
    "atomic_rename_unavailable",
  );
}

type VerifiedChildResult = Pick<ReturnType<typeof spawnSync>, "status">;
type VerifiedChildRunner = (
  parentFd: number,
  parentPath: string,
  script: string,
  args: string[],
) => VerifiedChildResult;

function destinationMatchesDescriptor(
  parentPath: string,
  destination: string,
  sourceFd: number,
): boolean {
  try {
    const published = lstatSync(path.join(parentPath, destination), { bigint: true });
    const source = fstatSync(sourceFd, { bigint: true });
    return published.isFile()
      && source.isFile()
      && published.dev === source.dev
      && published.ino === source.ino;
  } catch {
    return false;
  }
}

/** Atomically rename paths relative to an already-open directory descriptor. */
export function renameAtNoReplace(
  parentFd: number,
  parentPath: string,
  source: string,
  destination: string,
  runtimePlatform: NodeJS.Platform = process.platform,
  sourceFd?: number,
  runVerifiedChild: VerifiedChildRunner = spawnVerifiedChild,
): boolean {
  assertSiblingBasenames(source, destination);
  if (runtimePlatform === "win32") {
    const child = runVerifiedChild(parentFd, parentPath, WINDOWS_NOREPLACE_SCRIPT, [
      source,
      destination,
    ]);
    if (child.status === 0) return true;
    if (child.status === 65) {
      throw new ProvisionError("Rename target changed during publication", "untracked_content");
    }
    // A terminated helper may have created the destination hard link before
    // removing the candidate. Treat that exact identity as published so the
    // caller never truncates the now-visible credential during cleanup.
    if (sameSiblingIdentity(parentPath, source, destination, sourceFd)) {
      try {
	const expected = sourceFd === undefined
	  ? lstatSync(path.join(parentPath, destination), { bigint: true })
	  : fstatSync(sourceFd, { bigint: true });
	removeWindowsPublishedCandidate(parentFd, parentPath, source, destination, {
	  dev: expected.dev.toString(),
	  ino: expected.ino.toString(),
	}, runtimePlatform);
      } catch {
	// The random candidate may remain, but the published credential stays intact.
      }
      return true;
    }
    if (child.status === 17) return false;
    // The helper can also be terminated after removing the source link. The
    // open candidate descriptor still proves that the destination is the
    // published inode, so caller cleanup must not truncate it.
    if (sourceFd !== undefined
      && destinationMatchesDescriptor(parentPath, destination, sourceFd)) return true;
    throw new ProvisionError("Atomic no-replace rename helper failed", "atomic_rename_unavailable");
  }

  const result = resultCode(
    loadBinding().renameNoReplace(parentFd, source, destination),
    "no-replace rename",
  );
  if (result === 0) return true;
  const code = getSystemErrorName(-result);
  if (code === "EEXIST" || code === "ENOTEMPTY") return false;
  throw Object.assign(new Error(`Atomic no-replace rename failed with ${code}`), { code });
}

/** Remove one basename relative to an open directory descriptor. */
export function removeAt(
  parentFd: number,
  parentPath: string,
  basename: string,
  directory = false,
  runtimePlatform: NodeJS.Platform = process.platform,
): boolean {
  assertSiblingBasenames(basename);
  if (runtimePlatform === "win32") {
    const child = spawnVerifiedChild(parentFd, parentPath, WINDOWS_REMOVE_SCRIPT, [
      basename,
      directory ? "1" : "0",
    ]);
    if (child.status === 0) return true;
    if (child.status === 2) return false;
    if (child.status === 65) {
      throw new ProvisionError("Removal target changed during cleanup", "untracked_content");
    }
    throw new ProvisionError("Atomic remove helper failed", "atomic_rename_unavailable");
  }
  const result = resultCode(loadBinding().removeAt(parentFd, basename, directory), "remove-at");
  if (result === 0) return true;
  const code = getSystemErrorName(-result);
  if (code === "ENOENT") return false;
  throw Object.assign(new Error(`FD-relative removal failed with ${code}`), { code });
}

/** Remove only a Windows candidate that is a second link to the recorded published file. */
export function removeWindowsPublishedCandidate(
  parentFd: number,
  parentPath: string,
  candidate: string,
  published: string,
  expected: { dev: string; ino: string },
  runtimePlatform: NodeJS.Platform = process.platform,
): boolean {
  assertSiblingBasenames(candidate, published);
  if (runtimePlatform !== "win32") {
    throw new ProvisionError(
      "Windows hard-link cleanup is unavailable on this platform",
      "atomic_rename_unavailable",
    );
  }
  const child = spawnVerifiedChild(
    parentFd,
    parentPath,
    WINDOWS_REMOVE_PUBLISHED_LINK_SCRIPT,
    [candidate, published, expected.dev, expected.ino],
  );
  if (child.status === 0 || child.status === 2) return true;
  if (child.status === 66) return false;
  if (child.status === 65) {
    throw new ProvisionError("Removal target changed during cleanup", "untracked_content");
  }
  throw new ProvisionError("Atomic remove helper failed", "atomic_rename_unavailable");
}

const REPLACE_SCRIPT = [
  ...VERIFIED_DIRECTORY_PREFIX,
  "fs.renameSync(process.argv[1], process.argv[2])",
].join(";");

/** Atomically replace one sibling through a cwd verified against the open parent FD. */
export function renameAtReplace(
  parentFd: number,
  parentPath: string,
  source: string,
  destination: string,
  sourceFd: number,
  runVerifiedChild: VerifiedChildRunner = spawnVerifiedChild,
): void {
  assertSiblingBasenames(source, destination);
  const child = runVerifiedChild(parentFd, parentPath, REPLACE_SCRIPT, [source, destination]);
  if (child.status === 0) return;
  // The helper can be terminated after rename(2) commits but before Node exits.
  // The still-open candidate descriptor proves whether the destination now is
  // that exact inode, so the caller must not erase the published credential.
  if (destinationMatchesDescriptor(parentPath, destination, sourceFd)) return;
  if (child.status === 65) {
    throw new ProvisionError("Rename target changed during publication", "untracked_content");
  }
  throw new ProvisionError("Atomic replace helper failed", "atomic_rename_unavailable");
}

/** Atomically rename sibling directories without replacing an existing target. */
export function renameDirectoryNoReplace(source: string, target: string): boolean {
  const parent = path.dirname(target);
  if (path.dirname(source) !== parent) {
    throw new ProvisionError(
      "Atomic no-replace rename requires sibling paths",
      "atomic_rename_unavailable",
    );
  }

  const parentFd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    return renameAtNoReplace(
      parentFd,
      parent,
      path.basename(source),
      path.basename(target),
    );
  } finally {
    closeSync(parentFd);
  }
}
