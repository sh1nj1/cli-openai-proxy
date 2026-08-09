import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, statSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { MAX_MANAGED_PATH_LENGTH } from "./path-policy.js";
import {
  loadRegisteredManifestUrl,
  loadState,
  registeredManifestFilePath,
  saveRegisteredManifestUrl,
  saveState,
  stateFilePath,
  loadOrCreateLocalManifestKey,
} from "./state.js";

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
    assert.deepEqual(loadState(), { version: 1, approved: [], revoked: [], installed: {} });
  });

  test("an auth-delivered manifest URL is encrypted for its auth-admin key", () => {
    const url = "https://registry.test/provision.json?token=secret";
    saveRegisteredManifestUrl(url, "admin-secret");

    assert.equal(readFileSync(registeredManifestFilePath(), "utf8").includes("token=secret"), false);
    assert.equal(loadRegisteredManifestUrl(["wrong-key"]), null);
    assert.equal(loadRegisteredManifestUrl(["another-key", "admin-secret"]), url);
  });

  test("a corrupt registered manifest file loads as absent", () => {
    writeFileSync(registeredManifestFilePath(), "{ not json");
    assert.equal(loadRegisteredManifestUrl(["admin-secret"]), null);
  });

  test("saved state round-trips", () => {
    const state = {
      version: 1 as const,
      approved: ["skill/pr-monitor"],
      revoked: [],
      removalRecoveries: ["f".repeat(32)],
      upgradeRecoveries: ["e".repeat(32)],
      installed: {
        "skill/pr-monitor": {
          sha256: "a".repeat(64),
	  source: {
	    type: "git" as const,
	    ref: "main",
	    rev: "b".repeat(40),
	    path: "skills/pr-monitor",
	  },
          files: ["SKILL.md"],
	  directories: ["examples", "examples/empty"],
          installedAt: "2026-08-02T00:00:00.000Z",
	  removalRecoveryId: "f".repeat(32),
        },
      },
    };
    saveState(state);
    assert.deepEqual(loadState(), state);
  });

  test("round-trips canonical adopt grants and drops malformed entries", () => {
    saveState({
      version: 1,
      approved: [],
      revoked: [],
      adopted: ["config/collavre", "Config/Collavre", "not-a-key", "a/b/c"],
      installed: {},
    });
    assert.deepEqual(loadState().adopted, ["config/collavre"]);
  });

  test("a pre-branch git source treats its pinned revision as both ref and commit", () => {
    mkdirSync(path.dirname(stateFilePath()), { recursive: true });
    writeFileSync(stateFilePath(), JSON.stringify({
      version: 1,
      approved: ["skill/demo"],
      revoked: [],
      installed: {
	"skill/demo": {
	  sha256: "a".repeat(64),
	  source: { type: "git", rev: "b".repeat(40), path: "skills/demo" },
	  files: ["SKILL.md"],
	  installedAt: "2026-08-02T00:00:00.000Z",
	},
      },
    }));

    assert.deepEqual(loadState().installed["skill/demo"]?.source, {
      type: "git",
      ref: "b".repeat(40),
      rev: "b".repeat(40),
      path: "skills/demo",
    });
  });

  test("legacy consent keys are canonicalized while installed path spelling is retained", () => {
    mkdirSync(path.dirname(stateFilePath()), { recursive: true });
    writeFileSync(stateFilePath(), JSON.stringify({
      version: 1,
      approved: ["skill/Demo", "skill/demo"],
      revoked: ["skill/Old"],
      installed: {
	"skill/Demo": {
	  sha256: "a".repeat(64),
	  files: ["SKILL.md"],
	  installedAt: "2026-08-02T00:00:00.000Z",
	},
      },
    }));

    assert.deepEqual(loadState(), {
      version: 1,
      approved: ["skill/demo"],
      revoked: ["skill/old"],
      installed: {
	"skill/Demo": {
	  sha256: "a".repeat(64),
	  files: ["SKILL.md"],
	  installedAt: "2026-08-02T00:00:00.000Z",
	},
      },
    });
  });

  test("an uncommitted first-install journal round-trips", () => {
    const state = {
      version: 1 as const,
      approved: [],
      revoked: [],
      installed: {
	"skill/demo": {
	  sha256: "a".repeat(64),
	  files: ["SKILL.md"],
	  fileHashes: { "SKILL.md": "b".repeat(64) },
	  installedAt: "2026-08-02T00:00:00.000Z",
	  uncommitted: true as const,
	  candidateIdentity: { dev: "123", ino: "456" },
	  configCandidate: {
	    name: `.provision-config-candidate-${"e".repeat(32)}`,
	    dev: "789",
	    ino: "1011",
	  },
	  installMarker: "c".repeat(32),
	  rejectionRecoveryId: "d".repeat(32),
	},
      },
    };

    saveState(state);
    assert.deepEqual(loadState(), state);
  });

  test("a managed path at the archive limit round-trips", () => {
    const prefix = "a/";
    const file = `${prefix}${"b".repeat(MAX_MANAGED_PATH_LENGTH - prefix.length)}`;
    const state = {
      version: 1 as const,
      approved: [],
      revoked: [],
      installed: {
	"skill/demo": {
	  sha256: "a".repeat(64),
	  files: [file],
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
    assert.deepEqual(loadState(), { version: 1, approved: [], revoked: [], installed: {} });
  });

  test("valid JSON with malformed installed records is discarded safely", () => {
    mkdirSync(path.dirname(stateFilePath()), { recursive: true });
    writeFileSync(stateFilePath(), JSON.stringify({
      version: 1,
      approved: ["skill/good", 42],
      revoked: ["skill/nope", null],
      installed: {
	"skill/null-record": null,
	"skill/bad-hash": { sha256: "no", files: [], installedAt: "today" },
	"skill/bad-directory": {
	  sha256: "a".repeat(64),
	  files: ["SKILL.md"],
	  directories: ["../outside"],
	  installedAt: new Date().toISOString(),
	},
	"skill/nul-path": {
	  sha256: "a".repeat(64),
	  files: ["SKILL.md\0"],
	  installedAt: new Date().toISOString(),
	},
	"../escape": { sha256: "a".repeat(64), files: ["../outside"], installedAt: new Date().toISOString() },
	"skill/good": {
	  sha256: "b".repeat(64),
	  files: ["SKILL.md"],
	  fileHashes: { "SKILL.md": "c".repeat(64) },
	  installedAt: "2026-08-02T00:00:00.000Z",
	},
      },
    }));

    assert.deepEqual(loadState(), {
      version: 1,
      approved: ["skill/good"],
      revoked: ["skill/nope"],
      installed: {
	"skill/good": {
	  sha256: "b".repeat(64),
	  files: ["SKILL.md"],
	  fileHashes: { "SKILL.md": "c".repeat(64) },
	  installedAt: "2026-08-02T00:00:00.000Z",
	},
      },
    });
  });

  test("saveState writes atomically (no partial file left beside the lockfile)", () => {
    saveState({ version: 1, approved: [], revoked: [], installed: {} });
    const contents = readFileSync(stateFilePath(), "utf-8");
    assert.deepEqual(JSON.parse(contents), { version: 1, approved: [], revoked: [], installed: {} });
  });

  test("loadOrCreateLocalManifestKey creates a 0600 key file and is stable across calls", () => {
    const first = loadOrCreateLocalManifestKey();
    const second = loadOrCreateLocalManifestKey();
    assert.equal(first, second);
    assert.match(first, /^[A-Za-z0-9_-]{40,}$/);
    const mode = statSync(path.join(dir, "manifest.key")).mode & 0o777;
    if (process.platform !== "win32") assert.equal(mode, 0o600);
  });

  test("loadOrCreateLocalManifestKey atomically replaces an existing malformed key", () => {
    const file = path.join(dir, "manifest.key");
    writeFileSync(file, "malformed\n", { mode: 0o600 });
    const recovered = loadOrCreateLocalManifestKey();
    assert.match(recovered, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(readFileSync(file, "utf8"), `${recovered}\n`);
    assert.equal(loadOrCreateLocalManifestKey(), recovered);
  });

  test("manifest URL round-trips with the local key", () => {
    const key = loadOrCreateLocalManifestKey();
    saveRegisteredManifestUrl("https://example.com/provision.json?sig=abc", key);
    assert.equal(
      loadRegisteredManifestUrl([key]),
      "https://example.com/provision.json?sig=abc",
    );
  });
});
