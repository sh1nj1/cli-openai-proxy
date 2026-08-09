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
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
  AnchoredPublicationAmbiguousError,
  removeAt,
  removeAtIdentity,
  removeWindowsPublishedCandidate,
  renameAtNoReplace,
  renameAtReplace,
  symlinkAt,
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

  test("accepts publication completed before helper termination", () => {
    const candidate = path.join(parent, "candidate");
    const published = path.join(parent, "config.json");
    writeFileSync(candidate, "secret");
    const candidateFd = openSync(candidate, constants.O_RDONLY);
    try {
      assert.equal(renameAtNoReplace(
	parentFd,
	parent,
	"candidate",
	"config.json",
	"win32",
	candidateFd,
	(_parentFd, parentPath, _script, [source, destination]) => {
	  linkSync(path.join(parentPath, source!), path.join(parentPath, destination!));
	  rmSync(path.join(parentPath, source!));
	  return { status: null };
	},
      ), true);
    } finally {
      closeSync(candidateFd);
    }

    assert.equal(existsSync(candidate), false);
    assert.equal(readFileSync(published, "utf8"), "secret");
  });

  test("accepts an EEXIST race that published the opened candidate inode", () => {
    const candidate = path.join(parent, "candidate");
    const published = path.join(parent, "config.json");
    writeFileSync(candidate, "secret");
    const candidateFd = openSync(candidate, constants.O_RDONLY);
    try {
      assert.equal(renameAtNoReplace(
	parentFd,
	parent,
	"candidate",
	"config.json",
	"win32",
	candidateFd,
	(_parentFd, parentPath, _script, [source, destination]) => {
	  linkSync(path.join(parentPath, source!), path.join(parentPath, destination!));
	  return { status: 17 };
	},
      ), true);
    } finally {
      closeSync(candidateFd);
    }

    assert.equal(existsSync(candidate), false);
    assert.equal(readFileSync(published, "utf8"), "secret");
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

describe("atomic config replacement", () => {
  let root: string;
  let parent: string;
  let parentFd: number;
  let candidateFd: number;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "provision-replace-ops-"));
    parent = path.join(root, "config");
    mkdirSync(parent);
    writeFileSync(path.join(parent, "candidate"), "new-secret");
    writeFileSync(path.join(parent, "config.json"), "old-secret");
    parentFd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY);
    candidateFd = openSync(path.join(parent, "candidate"), constants.O_RDONLY);
  });

  afterEach(() => {
    closeSync(candidateFd);
    closeSync(parentFd);
    rmSync(root, { recursive: true, force: true });
  });

  test("accepts a replace committed before helper termination", () => {
    renameAtReplace(
      parentFd,
      parent,
      "candidate",
      "config.json",
      candidateFd,
      (_parentFd, parentPath, _script, [source, destination]) => {
	renameSync(path.join(parentPath, source!), path.join(parentPath, destination!));
	return { status: null };
      },
    );

    assert.equal(readFileSync(path.join(parent, "config.json"), "utf8"), "new-secret");
    assert.equal(existsSync(path.join(parent, "candidate")), false);
  });

  test("rejects helper failure when the destination is still the old inode", () => {
    assert.throws(
      () => renameAtReplace(
	parentFd,
	parent,
	"candidate",
	"config.json",
	candidateFd,
	() => ({ status: null }),
      ),
      (err: ProvisionError) => err.code === "atomic_rename_unavailable",
    );

    assert.equal(readFileSync(path.join(parent, "candidate"), "utf8"), "new-secret");
    assert.equal(readFileSync(path.join(parent, "config.json"), "utf8"), "old-secret");
  });
});

describe("anchored skill link operations", () => {
  let root: string;
  let parent: string;
  let parentFd: number;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "provision-skill-link-ops-"));
    parent = path.join(root, "links");
    mkdirSync(parent);
    parentFd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY);
  });

  afterEach(() => {
    closeSync(parentFd);
    rmSync(root, { recursive: true, force: true });
  });

  test("recovers a symlink published before helper termination", () => {
    const target = path.join(root, "target");
    mkdirSync(target);
    const identity = symlinkAt(
      parentFd,
      parent,
      target,
      "demo",
      process.platform === "win32" ? "junction" : "dir",
      (_parentFd, parentPath, _script, [publishedTarget, basename, type]) => {
	symlinkSync(publishedTarget!, path.join(parentPath, basename!), type as "dir" | "junction");
	return { status: null, stdout: "" };
      },
    );

    assert.notEqual(identity, undefined);
    assert.equal(path.resolve(parent, readlinkSync(path.join(parent, "demo"))), target);
    const published = lstatSync(path.join(parent, "demo"), { bigint: true });
    assert.equal(identity!.dev, published.dev.toString());
    assert.equal(identity!.ino, published.ino.toString());
  });

  test("reports an ambiguous publication when its parent path changes after helper exit", () => {
    const target = path.join(root, "target");
    const displaced = path.join(root, "displaced-links");
    mkdirSync(target);

    assert.throws(
      () => symlinkAt(
	parentFd,
	parent,
	target,
	"demo",
	process.platform === "win32" ? "junction" : "dir",
	(_parentFd, parentPath, _script, [publishedTarget, basename, type]) => {
	  symlinkSync(publishedTarget!, path.join(parentPath, basename!), type as "dir" | "junction");
	  renameSync(parentPath, displaced);
	  mkdirSync(parentPath);
	  return { status: null, stdout: "" };
	},
      ),
      (err: Error) => err instanceof AnchoredPublicationAmbiguousError,
    );
    assert.equal(
	path.resolve(displaced, readlinkSync(path.join(displaced, "demo"))),
	target,
    );
  });

  test("quarantines before identity-checked removal", {
    skip: process.platform === "win32",
  }, () => {
    const directory = path.join(parent, "owned");
    mkdirSync(directory);
    const identity = lstatSync(directory, { bigint: true });

    assert.equal(removeAtIdentity(parentFd, parent, "owned", true, {
      dev: identity.dev.toString(),
      ino: (identity.ino + 1n).toString(),
    }), false);
    assert.equal(lstatSync(directory).isDirectory(), true);
    assert.equal(removeAtIdentity(parentFd, parent, "owned", true, {
      dev: identity.dev.toString(),
      ino: identity.ino.toString(),
    }), true);
    assert.equal(existsSync(directory), false);
  });

  test("recovers cleanup when quarantine rename completes before helper termination", () => {
    const directory = path.join(parent, "owned");
    mkdirSync(directory);
    const stat = lstatSync(directory, { bigint: true });

    assert.equal(removeAtIdentity(
      parentFd,
      parent,
      "owned",
      true,
      { dev: stat.dev.toString(), ino: stat.ino.toString() },
      (_parentFd, parentPath, source, destination) => {
	renameSync(path.join(parentPath, source), path.join(parentPath, destination));
	throw new Error("helper terminated after rename");
      },
    ), true);
    assert.equal(existsSync(directory), false);
  });

  test("fails closed when an anchored no-replace quarantine is unavailable", () => {
    const directory = path.join(parent, "owned");
    mkdirSync(directory);
    const stat = lstatSync(directory, { bigint: true });

    assert.throws(
      () => removeAtIdentity(
	parentFd,
	parent,
	"owned",
	true,
	{ dev: stat.dev.toString(), ino: stat.ino.toString() },
	() => {
	  throw new ProvisionError(
	    "Anchored no-replace entry rename is unavailable",
	    "atomic_rename_unavailable",
	  );
	},
      ),
      (err: ProvisionError) => err.code === "atomic_rename_unavailable",
    );
    const preserved = lstatSync(directory, { bigint: true });
    assert.equal(preserved.dev, stat.dev);
    assert.equal(preserved.ino, stat.ino);
  });

  test("does not overwrite a raced original while restoring a mismatched quarantine", () => {
    const directory = path.join(parent, "owned");
    mkdirSync(directory);
    const stat = lstatSync(directory, { bigint: true });
    let quarantine = "";
    let calls = 0;

    assert.equal(removeAtIdentity(
      parentFd,
      parent,
      "owned",
      true,
      { dev: stat.dev.toString(), ino: stat.ino.toString() },
      (_parentFd, parentPath, source, destination) => {
	calls += 1;
	if (calls === 1) {
	  quarantine = path.join(parentPath, destination);
	  renameSync(path.join(parentPath, source), quarantine);
	  rmSync(quarantine, { recursive: true });
	  writeFileSync(quarantine, "user-owned");
	  mkdirSync(path.join(parentPath, source));
	  return true;
	}
	assert.equal(source, path.basename(quarantine));
	assert.equal(destination, "owned");
	return false;
      },
    ), false);
    assert.equal(calls, 2);
    assert.equal(lstatSync(directory).isDirectory(), true);
    assert.equal(lstatSync(quarantine).isFile(), true);
  });
});
