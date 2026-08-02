import { test } from "node:test";
import assert from "node:assert/strict";
import path from "path";
import { managedPathParts, MAX_MANAGED_PATH_LENGTH } from "./path-policy.js";

test("managed paths enforce the lockfile length boundary", () => {
  const prefix = "a/";
  const atLimit = `${prefix}${"b".repeat(MAX_MANAGED_PATH_LENGTH - prefix.length)}`;
  assert.notEqual(managedPathParts(atLimit), null);
  assert.equal(managedPathParts(`${atLimit}c`), null);
});

test("managed paths preserve literal Unix backslashes", { skip: path.sep === "\\" }, () => {
  assert.deepEqual(managedPathParts("docs\\notes.md"), ["docs\\notes.md"]);
  assert.deepEqual(managedPathParts("C:\\notes.md"), ["C:\\notes.md"]);
});

test("managed paths reject traversal and platform-absolute paths", () => {
  assert.equal(managedPathParts("../outside"), null);
  assert.equal(managedPathParts("nested/../outside"), null);
  assert.equal(managedPathParts(path.resolve("absolute")), null);
});

test("managed paths reject NUL bytes", () => {
  assert.equal(managedPathParts("SKILL.md\0"), null);
  assert.equal(managedPathParts("nested/\0/file.md"), null);
});
