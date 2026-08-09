import assert from "node:assert/strict";
import {
  closeSync,
  constants,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
  removeAt,
  removeWindowsPublishedCandidate,
  renameAtNoReplace,
} from "./rename-no-replace.js";
import { ProvisionError } from "./types.js";

describe("Windows config file operations", () => {
  let root: string;
  let parent: string;
  let parentFd: number;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "provision-windows-ops-"));
    parent = path.join(root, "config");
    mkdirSync(parent);
    parentFd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY);
  });

  afterEach(() => {
    closeSync(parentFd);
    rmSync(root, { recursive: true, force: true });
  });

  test("publishes a complete file without replacing an existing destination", () => {
    writeFileSync(path.join(parent, "candidate"), "secret");
    assert.equal(renameAtNoReplace(parentFd, parent, "candidate", "config.json", "win32"), true);
    assert.equal(readFileSync(path.join(parent, "config.json"), "utf8"), "secret");

    writeFileSync(path.join(parent, "candidate"), "replacement");
    assert.equal(renameAtNoReplace(parentFd, parent, "candidate", "config.json", "win32"), false);
    assert.equal(readFileSync(path.join(parent, "config.json"), "utf8"), "secret");
    assert.equal(readFileSync(path.join(parent, "candidate"), "utf8"), "replacement");
  });

  test("removes one managed basename and reports an absent file", () => {
    writeFileSync(path.join(parent, "config.json"), "secret");
    assert.equal(removeAt(parentFd, parent, "config.json", false, "win32"), true);
    assert.equal(removeAt(parentFd, parent, "config.json", false, "win32"), false);
  });

  test("removes a leftover candidate only when it links to the published file", () => {
    const candidate = path.join(parent, "candidate");
    const published = path.join(parent, "config.json");
    writeFileSync(candidate, "secret");
    linkSync(candidate, published);
    const identity = lstatSync(published, { bigint: true });

    assert.equal(removeWindowsPublishedCandidate(
      parentFd,
      parent,
      "candidate",
      "config.json",
      { dev: identity.dev.toString(), ino: identity.ino.toString() },
      "win32",
    ), true);
    assert.equal(existsSync(candidate), false);
    assert.equal(readFileSync(published, "utf8"), "secret");
  });

  test("preserves a candidate whose identity does not match the published file", () => {
    const candidate = path.join(parent, "candidate");
    const published = path.join(parent, "config.json");
    writeFileSync(candidate, "user-owned");
    writeFileSync(published, "secret");
    const identity = lstatSync(published, { bigint: true });

    assert.equal(removeWindowsPublishedCandidate(
      parentFd,
      parent,
      "candidate",
      "config.json",
      { dev: identity.dev.toString(), ino: identity.ino.toString() },
      "win32",
    ), false);
    assert.equal(readFileSync(candidate, "utf8"), "user-owned");
    assert.equal(readFileSync(published, "utf8"), "secret");
  });

  test("refuses a path that no longer identifies the opened directory", () => {
    const displaced = path.join(root, "displaced");
    renameSync(parent, displaced);
    mkdirSync(parent);
    writeFileSync(path.join(parent, "config.json"), "user-owned");

    assert.throws(
      () => removeAt(parentFd, parent, "config.json", false, "win32"),
      (err: ProvisionError) => err.code === "untracked_content",
    );
    assert.equal(readFileSync(path.join(parent, "config.json"), "utf8"), "user-owned");
  });
});
