import { spawnSync } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
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

/** Atomically rename paths relative to an already-open directory descriptor. */
export function renameAtNoReplace(
  parentFd: number,
  source: string,
  destination: string,
): boolean {
  if (process.platform === "win32") {
    throw new ProvisionError(
      "Windows uses the platform rename implementation directly",
      "atomic_rename_unavailable",
    );
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
export function removeAt(parentFd: number, basename: string, directory = false): boolean {
  if (path.basename(basename) !== basename || basename === "." || basename === "..") {
    throw new ProvisionError("FD-relative removal requires one basename", "invalid_item");
  }
  const result = resultCode(loadBinding().removeAt(parentFd, basename, directory), "remove-at");
  if (result === 0) return true;
  const code = getSystemErrorName(-result);
  if (code === "ENOENT") return false;
  throw Object.assign(new Error(`FD-relative removal failed with ${code}`), { code });
}

const REPLACE_SCRIPT = [
  'const fs = require("node:fs")',
  "const opened = fs.fstatSync(3, { bigint: true })",
  'const cwd = fs.statSync(".", { bigint: true })',
  "if (!opened.isDirectory() || opened.dev !== cwd.dev || opened.ino !== cwd.ino) process.exit(65)",
  "fs.renameSync(process.argv[1], process.argv[2])",
].join(";");

/** Atomically replace one sibling through a cwd verified against the open parent FD. */
export function renameAtReplace(
  parentFd: number,
  parentPath: string,
  source: string,
  destination: string,
): void {
  if ([source, destination].some((name) =>
    path.basename(name) !== name || name === "." || name === "..")) {
    throw new ProvisionError("FD-relative rename requires sibling basenames", "invalid_item");
  }
  const child = spawnSync(process.execPath, ["-e", REPLACE_SCRIPT, source, destination], {
    cwd: parentPath,
    stdio: ["ignore", "ignore", "ignore", parentFd],
  });
  if (child.status === 0) return;
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
    return renameAtNoReplace(parentFd, path.basename(source), path.basename(target));
  } finally {
    closeSync(parentFd);
  }
}
