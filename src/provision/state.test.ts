import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { loadState, saveState, stateFilePath } from "./state.js";

describe("provision state", () => {
  let dir: string;
  let savedStateDir: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "provision-state-"));
    savedStateDir = process.env.PROVISION_STATE_DIR;
    process.env.PROVISION_STATE_DIR = dir;
  });

  afterEach(() => {
    if (savedStateDir === undefined) delete process.env.PROVISION_STATE_DIR;
    else process.env.PROVISION_STATE_DIR = savedStateDir;
    rmSync(dir, { recursive: true, force: true });
  });

  test("a missing lockfile loads as the empty state", () => {
    assert.deepEqual(loadState(), { version: 1, approved: [], installed: {} });
  });

  test("saved state round-trips", () => {
    const state = {
      version: 1 as const,
      approved: ["skill/pr-monitor"],
      installed: {
        "skill/pr-monitor": {
          sha256: "a".repeat(64),
          files: ["SKILL.md"],
          installedAt: "2026-08-02T00:00:00.000Z",
        },
      },
    };
    saveState(state);
    assert.deepEqual(loadState(), state);
  });

  // A truncated write (crash mid-save) must not brick provisioning forever.
  test("a corrupt lockfile loads as empty rather than throwing", () => {
    mkdirSync(path.dirname(stateFilePath()), { recursive: true });
    writeFileSync(stateFilePath(), "{ not json");
    assert.deepEqual(loadState(), { version: 1, approved: [], installed: {} });
  });

  test("saveState writes atomically (no partial file left beside the lockfile)", () => {
    saveState({ version: 1, approved: [], installed: {} });
    const contents = readFileSync(stateFilePath(), "utf-8");
    assert.deepEqual(JSON.parse(contents), { version: 1, approved: [], installed: {} });
  });
});
