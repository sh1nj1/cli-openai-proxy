import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { createServer, type Server } from "http";
import { tmpdir } from "os";
import path from "path";
import { gzipSync } from "zlib";
import { resetCapturedProxySecrets } from "../config.js";
import {
  approveItem,
  deleteItem,
  getStatus,
  handleAuthorizedSession,
  initProvisioning,
  provisionEnabled,
  registerManifestUrl,
  resetProvisioning,
  shutdownProvisioning,
  syncNow,
} from "./sync.js";
import { ProvisionError } from "./types.js";
import { firstInstallMarkerPath } from "./installer.js";

/** Single-file tar.gz, enough for sync-level tests (installer has its own suite). */
function skillArchive(content: string): Buffer {
  const body = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write("SKILL.md", 0, 100, "utf-8");
  header.write("0000644", 100, 8, "ascii");
  header.write("0000000", 108, 8, "ascii");
  header.write("0000000", 116, 8, "ascii");
  header.write(body.length.toString(8).padStart(11, "0"), 124, 12, "ascii");
  header.write("00000000000", 136, 12, "ascii");
  header.write("        ", 148, 8, "ascii");
  header.write("0", 156, 1, "ascii");
  header.write("ustar", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  body.copy(padded);
  return gzipSync(Buffer.concat([header, padded, Buffer.alloc(1024)]));
}

const sha = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

const SAVED_VARS = [
  "PROVISION_SYNC",
  "PROVISION_AUTOAPPLY",
  "PROVISION_MANIFEST_URL",
  "PROVISION_ALLOWLIST",
  "PROVISION_STATE_DIR",
  "PROVISION_SKILLS_DIR",
  "PROVISION_REFETCH_MS",
] as const;

describe("provision sync", () => {
  let server: Server;
  let baseUrl: string;
  let responses: Map<string, Buffer | object>;
  let responseGates: Map<string, Promise<void>>;
  let stateDir: string;
  let skillsDir: string;
  const saved = new Map<string, string | undefined>();

  let redirects: Map<string, string>;

  before(async () => {
    responses = new Map();
    responseGates = new Map();
    redirects = new Map();
    server = createServer(async (req, res) => {
      const location = redirects.get(req.url ?? "");
      if (location) {
        res.statusCode = 302;
        res.setHeader("location", location);
        res.end();
        return;
      }
      const body = responses.get(req.url ?? "");
      if (body === undefined) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      const gate = responseGates.get(req.url ?? "");
      if (gate) await gate;
      if (Buffer.isBuffer(body)) res.end(body);
      else {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(body));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    resetCapturedProxySecrets();
    for (const name of SAVED_VARS) {
      saved.set(name, process.env[name]);
      delete process.env[name];
    }
    stateDir = mkdtempSync(path.join(tmpdir(), "provision-sync-state-"));
    skillsDir = mkdtempSync(path.join(tmpdir(), "provision-sync-skills-"));
    process.env.PROVISION_STATE_DIR = stateDir;
    process.env.PROVISION_SKILLS_DIR = skillsDir;
    process.env.PROVISION_SYNC = "1";
    responses.clear();
    responseGates.clear();
    redirects.clear();
    initProvisioning();
  });

  afterEach(async () => {
    await shutdownProvisioning();
    resetCapturedProxySecrets();
    for (const name of SAVED_VARS) {
      const value = saved.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(skillsDir, { recursive: true, force: true });
  });

  function serveManifest(items: object[]): string {
    responses.set("/provision.json", { schema: "agent-provisioning/v1", items });
    return `${baseUrl}/provision.json`;
  }

  function serveSkill(pathName: string, content: string): { url: string; sha256: string } {
    const archive = skillArchive(content);
    responses.set(pathName, archive);
    return { url: `${baseUrl}${pathName}`, sha256: sha(archive) };
  }

  const codeOf = async (fn: () => Promise<unknown>): Promise<string> => {
    try {
      await fn();
    } catch (err) {
      if (err instanceof ProvisionError) return err.code;
      throw err;
    }
    return "(no error)";
  };

  const statusOf = (view: { data: Array<{ type: string; name: string; status: string }> }, name: string) =>
    view.data.find((item) => item.name === name)?.status;

  function writeLostExposureJournal(name: string): { key: string; target: string } {
    const key = `skill/${name}`;
    const target = path.join(skillsDir, name);
    mkdirSync(target);
    writeFileSync(path.join(stateDir, "provision.lock.json"), JSON.stringify({
      version: 1,
      approved: [key],
      revoked: [],
      installed: {
	[key]: {
	  sha256: "a".repeat(64),
	  files: ["OLD.md"],
	  directories: [],
	  fileHashes: { "OLD.md": sha(Buffer.from("old contents")) },
	  installedAt: new Date().toISOString(),
	  pending: {
	    sha256: "b".repeat(64),
	    files: ["NEW.md"],
	    directories: [],
	    fileHashes: { "NEW.md": sha(Buffer.from("new contents")) },
	    installedAt: new Date().toISOString(),
	  },
	},
      },
    }));
    initProvisioning();
    return { key, target };
  }

  test("PROVISION_SYNC unset means the feature is off end to end", async () => {
    delete process.env.PROVISION_SYNC;
    initProvisioning();
    assert.equal(provisionEnabled(), false);
    assert.equal(await codeOf(() => syncNow()), "provisioning_disabled");
    await handleAuthorizedSession("https://collavre.com/x.json");
    assert.equal(getStatus().manifest_url, null);
  });

  test("in the default approve mode a first-seen item stops at pending_approval", async () => {
    const skill = serveSkill("/pr-monitor.tgz", "watch the PR");
    registerManifestUrl(serveManifest([{ type: "skill", name: "pr-monitor", ...skill }]));

    const view = await syncNow();
    assert.equal(statusOf(view, "pr-monitor"), "pending_approval");
    assert.equal(existsSync(path.join(skillsDir, "pr-monitor")), false);
  });

  test("approving a pending item installs it and future upgrades apply on their own", async () => {
    const skill = serveSkill("/pr-monitor.tgz", "v1");
    registerManifestUrl(serveManifest([{ type: "skill", name: "pr-monitor", ...skill }]));
    await syncNow();

    const approved = await approveItem("skill", "pr-monitor");
    assert.equal(statusOf(approved, "pr-monitor"), "installed");
    assert.equal(existsSync(path.join(skillsDir, "pr-monitor", "SKILL.md")), true);

    const upgraded = serveSkill("/pr-monitor-2.tgz", "v2");
    registerManifestUrl(serveManifest([{ type: "skill", name: "pr-monitor", ...upgraded }]));
    const view = await syncNow();
    assert.equal(statusOf(view, "pr-monitor"), "installed");
  });

  test("approval queued during an active sync survives its stale snapshot and installs", async () => {
    const first = serveSkill("/slow-v1.tgz", "v1");
    registerManifestUrl(serveManifest([{ type: "skill", name: "slow", ...first }]));
    await syncNow();
    await approveItem("skill", "slow");

    const upgrade = serveSkill("/slow-v2.tgz", "v2");
    const target = serveSkill("/target.tgz", "target");
    registerManifestUrl(serveManifest([
      { type: "skill", name: "slow", ...upgrade },
      { type: "skill", name: "target", ...target },
    ]));
    let release!: () => void;
    responseGates.set("/slow-v2.tgz", new Promise<void>((resolve) => { release = resolve; }));

    const active = syncNow();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const approval = approveItem("skill", "target");
    release();
    await active;
    const view = await approval;

    assert.equal(statusOf(view, "target"), "installed");
    assert.equal(existsSync(path.join(skillsDir, "target", "SKILL.md")), true);
  });

  test("PROVISION_AUTOAPPLY=auto installs without the approval stop", async () => {
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const skill = serveSkill("/pr-monitor.tgz", "hello");
    registerManifestUrl(serveManifest([{ type: "skill", name: "pr-monitor", ...skill }]));

    const view = await syncNow();
    assert.equal(statusOf(view, "pr-monitor"), "installed");
    assert.equal(existsSync(path.join(skillsDir, "pr-monitor", "SKILL.md")), true);
  });

  test("an item that leaves the manifest is removed — but only lockfile-managed ones", async () => {
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const skill = serveSkill("/a.tgz", "a");
    registerManifestUrl(serveManifest([{ type: "skill", name: "aaa", ...skill }]));
    await syncNow();
    assert.equal(existsSync(path.join(skillsDir, "aaa")), true);

    registerManifestUrl(serveManifest([]));
    const view = await syncNow();
    assert.equal(statusOf(view, "aaa"), "removed");
    assert.equal(existsSync(path.join(skillsDir, "aaa")), false);
  });

  test("removal cleans archive-owned empty directories so the item can be re-added", async () => {
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const skill = serveSkill("/empty-dir.tgz", "managed");
    const desired = [{ type: "skill", name: "empty-dir", ...skill }];
    registerManifestUrl(serveManifest(desired));
    await syncNow();
    mkdirSync(path.join(skillsDir, "empty-dir", "examples", "empty"), { recursive: true });
    const lockfile = path.join(stateDir, "provision.lock.json");
    const state = JSON.parse(readFileSync(lockfile, "utf8"));
    state.installed["skill/empty-dir"].directories = ["examples", "examples/empty"];
    writeFileSync(lockfile, JSON.stringify(state));
    assert.equal(existsSync(path.join(skillsDir, "empty-dir", "examples", "empty")), true);

    registerManifestUrl(serveManifest([]));
    assert.equal(statusOf(await syncNow(), "empty-dir"), "removed");
    assert.equal(existsSync(path.join(skillsDir, "empty-dir")), false);

    registerManifestUrl(serveManifest(desired));
    assert.equal(statusOf(await syncNow(), "empty-dir"), "installed");
  });

  test("removal preserves files added beneath a managed skill by the user", async () => {
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const skill = serveSkill("/owned.tgz", "managed");
    registerManifestUrl(serveManifest([{ type: "skill", name: "owned", ...skill }]));
    await syncNow();
    writeFileSync(path.join(skillsDir, "owned", "user-notes.md"), "keep me");

    registerManifestUrl(serveManifest([]));
    const view = await syncNow();

    assert.equal(statusOf(view, "owned"), "removed");
    assert.equal(existsSync(path.join(skillsDir, "owned", "SKILL.md")), false);
    assert.equal(readFileSync(path.join(skillsDir, "owned", "user-notes.md"), "utf8"), "keep me");
  });

  test("an upgrade refuses to overwrite files added beneath a managed skill", async () => {
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const first = serveSkill("/upgrade-v1.tgz", "v1");
    registerManifestUrl(serveManifest([{ type: "skill", name: "upgrade", ...first }]));
    await syncNow();
    writeFileSync(path.join(skillsDir, "upgrade", "user-notes.md"), "keep me");

    const second = serveSkill("/upgrade-v2.tgz", "v2");
    registerManifestUrl(serveManifest([{ type: "skill", name: "upgrade", ...second }]));
    const view = await syncNow();

    assert.equal(statusOf(view, "upgrade"), "failed");
    assert.match(view.data.find((item) => item.name === "upgrade")?.error ?? "", /untracked/i);
    assert.equal(readFileSync(path.join(skillsDir, "upgrade", "SKILL.md"), "utf8"), "v1");
    assert.equal(readFileSync(path.join(skillsDir, "upgrade", "user-notes.md"), "utf8"), "keep me");
  });

  test("an upgrade refuses to erase an untracked empty directory", async () => {
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const first = serveSkill("/empty-user-dir-v1.tgz", "v1");
    registerManifestUrl(serveManifest([{ type: "skill", name: "empty-user-dir", ...first }]));
    await syncNow();
    const userDirectory = path.join(skillsDir, "empty-user-dir", "user-empty");
    mkdirSync(userDirectory);

    const second = serveSkill("/empty-user-dir-v2.tgz", "v2");
    registerManifestUrl(serveManifest([{ type: "skill", name: "empty-user-dir", ...second }]));
    const view = await syncNow();

    assert.equal(statusOf(view, "empty-user-dir"), "failed");
    assert.match(view.data.find((item) => item.name === "empty-user-dir")?.error ?? "", /untracked/i);
    assert.equal(existsSync(userDirectory), true);
  });

  test("an unknown item type reports unsupported and is otherwise ignored", async () => {
    registerManifestUrl(serveManifest([{ type: "mcp", name: "future" }]));
    const view = await syncNow();
    assert.equal(statusOf(view, "future"), "unsupported");
  });

  test("an artifact on a foreign host fails that item, not the whole sync", async () => {
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const good = serveSkill("/good.tgz", "good");
    registerManifestUrl(serveManifest([
      { type: "skill", name: "good", ...good },
      { type: "skill", name: "foreign", url: "https://evil.example/x.tgz", sha256: "0".repeat(64) },
    ]));
    const view = await syncNow();
    assert.equal(statusOf(view, "good"), "installed");
    assert.equal(statusOf(view, "foreign"), "failed");
    assert.match(view.data.find((item) => item.name === "foreign")?.error ?? "", /PROVISION_ALLOWLIST/);
  });

  test("a manifest that redirects to a foreign host is refused", async () => {
    redirects.set("/moved.json", "https://evil.example/provision.json");
    registerManifestUrl(`${baseUrl}/moved.json`);
    assert.equal(await codeOf(() => syncNow()), "url_not_allowed");
  });

  test("an artifact that redirects to a foreign host fails that item", async () => {
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const real = serveSkill("/real.tgz", "content");
    redirects.set("/hop.tgz", "https://evil.example/x.tgz");
    registerManifestUrl(serveManifest([
      { type: "skill", name: "hopper", url: `${baseUrl}/hop.tgz`, sha256: real.sha256 },
    ]));
    const view = await syncNow();
    assert.equal(statusOf(view, "hopper"), "failed");
    assert.match(view.data.find((item) => item.name === "hopper")?.error ?? "", /host/i);
  });

  test("a name collision with an untracked directory fails the item and preserves it", async () => {
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    mkdirSync(path.join(skillsDir, "handmade"));
    writeFileSync(path.join(skillsDir, "handmade", "SKILL.md"), "mine, not yours");

    const skill = serveSkill("/handmade.tgz", "from the registry");
    registerManifestUrl(serveManifest([{ type: "skill", name: "handmade", ...skill }]));
    const view = await syncNow();

    assert.equal(statusOf(view, "handmade"), "failed");
    assert.match(view.data.find((item) => item.name === "handmade")?.error ?? "", /untracked/i);
    assert.equal(
      readFileSync(path.join(skillsDir, "handmade", "SKILL.md"), "utf-8"),
      "mine, not yours",
    );
  });

  test("an unreachable manifest is manifest_fetch_failed", async () => {
    registerManifestUrl(`${baseUrl}/missing.json`);
    assert.equal(await codeOf(() => syncNow()), "manifest_fetch_failed");
  });

  test("a manifest body is capped while streaming", async () => {
    responses.set("/huge.json", Buffer.alloc(2 * 1024 * 1024, 0x20));
    registerManifestUrl(`${baseUrl}/huge.json`);
    assert.equal(await codeOf(() => syncNow()), "manifest_fetch_failed");
    assert.match(getStatus().last_error ?? "", /exceeds/i);
  });

  test("a first install is not exposed when its ownership record cannot be persisted", async () => {
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const blocker = path.join(stateDir, "not-a-directory");
    writeFileSync(blocker, "block nested state writes");
    process.env.PROVISION_STATE_DIR = path.join(blocker, "child");
    const skill = serveSkill("/ownership.tgz", "owned only after lockfile write");
    registerManifestUrl(serveManifest([{ type: "skill", name: "ownership", ...skill }]));

    await assert.rejects(syncNow());
    assert.equal(existsSync(path.join(skillsDir, "ownership")), false);
  });

  test("a restarted first-install preclaim never owns an ambiguous target", async () => {
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const target = path.join(skillsDir, "interrupted-first-install");
    mkdirSync(target);
    writeFileSync(path.join(target, "SKILL.md"), "same path, user-owned contents");
    const skill = serveSkill("/interrupted-first-install.tgz", "registry contents");
    writeFileSync(path.join(stateDir, "provision.lock.json"), JSON.stringify({
      version: 1,
      approved: [],
      revoked: [],
      installed: {
	"skill/interrupted-first-install": {
	  sha256: skill.sha256,
	  files: ["SKILL.md"],
	  fileHashes: { "SKILL.md": sha(Buffer.from("registry contents")) },
	  installedAt: new Date().toISOString(),
	  uncommitted: true,
	  installMarker: "a".repeat(32),
	},
      },
    }));
    registerManifestUrl(serveManifest([{
      type: "skill",
      name: "interrupted-first-install",
      ...skill,
    }]));

    const view = await syncNow();

    assert.equal(statusOf(view, "interrupted-first-install"), "failed");
    assert.equal(
      readFileSync(path.join(target, "SKILL.md"), "utf8"),
      "same path, user-owned contents",
    );
    const state = JSON.parse(readFileSync(path.join(stateDir, "provision.lock.json"), "utf8"));
    assert.equal(state.installed["skill/interrupted-first-install"], undefined);
  });

  test("DELETE discards a pre-exposure claim before inspecting its target", async () => {
    const name = "delete-preclaim";
    const marker = "b".repeat(32);
    const target = path.join(skillsDir, name);
    mkdirSync(target);
    writeFileSync(path.join(target, "SKILL.md"), "candidate contents");
    writeFileSync(path.join(stateDir, "provision.lock.json"), JSON.stringify({
      version: 1,
      approved: [],
      revoked: [],
      installed: {
	[`skill/${name}`]: {
	  sha256: "c".repeat(64),
	  files: ["SKILL.md"],
	  fileHashes: { "SKILL.md": sha(Buffer.from("candidate contents")) },
	  installedAt: new Date().toISOString(),
	  uncommitted: true,
	  installMarker: marker,
	},
      },
    }));

    assert.deepEqual(await deleteItem("skill", name), { removed: false });
    assert.equal(readFileSync(path.join(target, "SKILL.md"), "utf8"), "candidate contents");
    const state = JSON.parse(readFileSync(path.join(stateDir, "provision.lock.json"), "utf8"));
    assert.equal(state.installed[`skill/${name}`], undefined);
  });

  test("DELETE recovers an exposed first install before removing it", async () => {
    const name = "delete-exposed";
    const marker = "d".repeat(32);
    const target = path.join(skillsDir, name);
    mkdirSync(target);
    writeFileSync(path.join(target, "SKILL.md"), "installed contents");
    writeFileSync(firstInstallMarkerPath(target, marker), marker);
    writeFileSync(path.join(stateDir, "provision.lock.json"), JSON.stringify({
      version: 1,
      approved: [],
      revoked: [],
      installed: {
	[`skill/${name}`]: {
	  sha256: "e".repeat(64),
	  files: ["SKILL.md"],
	  fileHashes: { "SKILL.md": sha(Buffer.from("installed contents")) },
	  installedAt: new Date().toISOString(),
	  uncommitted: true,
	  installMarker: marker,
	},
      },
    }));

    assert.deepEqual(await deleteItem("skill", name), { removed: true });
    assert.equal(existsSync(target), false);
    const state = JSON.parse(readFileSync(path.join(stateDir, "provision.lock.json"), "utf8"));
    assert.equal(state.installed[`skill/${name}`], undefined);
  });

  test("a modified committed install marker remains owned through upgrade and removal", async () => {
    process.env.PROVISION_AUTOAPPLY = "auto";
    const name = "modified-install-marker";
    const marker = "f".repeat(32);
    const markerName = `.provision-install-${marker}`;
    const target = path.join(skillsDir, name);
    mkdirSync(target);
    writeFileSync(path.join(target, "SKILL.md"), "v1");
    writeFileSync(path.join(target, markerName), "modified after ownership commit");
    const v1 = serveSkill("/modified-install-marker-v1.tgz", "v1");
    writeFileSync(path.join(stateDir, "provision.lock.json"), JSON.stringify({
      version: 1,
      approved: [`skill/${name}`],
      revoked: [],
      installed: {
	[`skill/${name}`]: {
	  sha256: v1.sha256,
	  files: ["SKILL.md"],
	  directories: [],
	  fileHashes: { "SKILL.md": sha(Buffer.from("v1")) },
	  installedAt: new Date().toISOString(),
	  installMarker: marker,
	},
      },
    }));
    initProvisioning();
    registerManifestUrl(serveManifest([{ type: "skill", name, ...v1 }]));

    assert.equal(statusOf(await syncNow(), name), "installed");
    let state = JSON.parse(readFileSync(path.join(stateDir, "provision.lock.json"), "utf8"));
    assert.equal(state.installed[`skill/${name}`].installMarker, undefined);
    assert.ok(state.installed[`skill/${name}`].files.includes(markerName));
    assert.equal(
      state.installed[`skill/${name}`].fileHashes[markerName],
      sha(Buffer.from("modified after ownership commit")),
    );

    const v2 = serveSkill("/modified-install-marker-v2.tgz", "v2");
    registerManifestUrl(serveManifest([{ type: "skill", name, ...v2 }]));
    assert.equal(statusOf(await syncNow(), name), "installed");
    assert.equal(readFileSync(path.join(target, "SKILL.md"), "utf8"), "v2");
    assert.equal(existsSync(path.join(target, markerName)), false);

    assert.deepEqual(await deleteItem("skill", name), { removed: true });
    assert.equal(existsSync(target), false);
    state = JSON.parse(readFileSync(path.join(stateDir, "provision.lock.json"), "utf8"));
    assert.equal(state.installed[`skill/${name}`], undefined);
  });

  test("a rejected first-install journal is not finalized as stable ownership", async () => {
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning({
      afterFirstInstallMove: (target) => {
	writeFileSync(path.join(target, "SKILL.md"), "changed after exposure");
      },
    });
    const skill = serveSkill("/changed-after-exposure.tgz", "candidate contents");
    registerManifestUrl(serveManifest([{
      type: "skill",
      name: "changed-after-exposure",
      ...skill,
    }]));

    const view = await syncNow();

    assert.equal(statusOf(view, "changed-after-exposure"), "failed");
    assert.equal(
      readFileSync(path.join(skillsDir, "changed-after-exposure", "SKILL.md"), "utf8"),
      "changed after exposure",
    );
    const state = JSON.parse(readFileSync(path.join(stateDir, "provision.lock.json"), "utf8"));
    assert.equal(state.installed["skill/changed-after-exposure"], undefined);
  });

  test("a committed upgrade is recovered from a pending ownership transaction", async () => {
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const target = path.join(skillsDir, "recover-upgrade");
    mkdirSync(target);
    writeFileSync(path.join(target, "NEW.md"), "new contents");
    const candidateSha = "b".repeat(64);
    writeFileSync(path.join(stateDir, "provision.lock.json"), JSON.stringify({
      version: 1,
      approved: ["skill/recover-upgrade"],
      revoked: [],
      installed: {
	"skill/recover-upgrade": {
	  sha256: "a".repeat(64),
	  files: ["OLD.md"],
	  directories: [],
	  fileHashes: { "OLD.md": sha(Buffer.from("old contents")) },
	  installedAt: new Date().toISOString(),
	  pending: {
	    sha256: candidateSha,
	    files: ["NEW.md"],
	    directories: [],
	    fileHashes: { "NEW.md": sha(Buffer.from("new contents")) },
	    installedAt: new Date().toISOString(),
	  },
	},
      },
    }));
    initProvisioning();
    registerManifestUrl(serveManifest([{
      type: "skill",
      name: "recover-upgrade",
      url: `${baseUrl}/must-not-download.tgz`,
      sha256: candidateSha,
    }]));

    const view = await syncNow();

    assert.equal(statusOf(view, "recover-upgrade"), "installed");
    assert.equal(readFileSync(path.join(target, "NEW.md"), "utf8"), "new contents");
    const state = JSON.parse(readFileSync(path.join(stateDir, "provision.lock.json"), "utf8"));
    assert.equal(state.installed["skill/recover-upgrade"].sha256, candidateSha);
    assert.equal(state.installed["skill/recover-upgrade"].pending, undefined);
  });

  test("an upgrade candidate subset does not impersonate the stable tree during recovery", async () => {
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const target = path.join(skillsDir, "recover-subset-upgrade");
    mkdirSync(target);
    writeFileSync(path.join(target, "SKILL.md"), "shared contents");
    writeFileSync(path.join(target, "OLD.md"), "old contents");
    const candidate = serveSkill("/recover-subset-upgrade.tgz", "shared contents");
    writeFileSync(path.join(stateDir, "provision.lock.json"), JSON.stringify({
      version: 1,
      approved: ["skill/recover-subset-upgrade"],
      revoked: [],
      installed: {
	"skill/recover-subset-upgrade": {
	  sha256: "a".repeat(64),
	  files: ["SKILL.md", "OLD.md"],
	  directories: [],
	  fileHashes: {
	    "SKILL.md": sha(Buffer.from("shared contents")),
	    "OLD.md": sha(Buffer.from("old contents")),
	  },
	  installedAt: new Date().toISOString(),
	  pending: {
	    sha256: candidate.sha256,
	    files: ["SKILL.md"],
	    directories: [],
	    fileHashes: { "SKILL.md": sha(Buffer.from("shared contents")) },
	    installedAt: new Date().toISOString(),
	  },
	},
      },
    }));
    initProvisioning();
    registerManifestUrl(serveManifest([{
      type: "skill",
      name: "recover-subset-upgrade",
      ...candidate,
    }]));

    const view = await syncNow();

    assert.equal(statusOf(view, "recover-subset-upgrade"), "installed");
    assert.equal(readFileSync(path.join(target, "SKILL.md"), "utf8"), "shared contents");
    assert.equal(existsSync(path.join(target, "OLD.md")), false);
    const state = JSON.parse(readFileSync(path.join(stateDir, "provision.lock.json"), "utf8"));
    assert.equal(state.installed["skill/recover-subset-upgrade"].sha256, candidate.sha256);
    assert.deepEqual(state.installed["skill/recover-subset-upgrade"].files, ["SKILL.md"]);
    assert.equal(state.installed["skill/recover-subset-upgrade"].pending, undefined);
  });

  test("an unresolved upgrade journal blocks re-upgrade without dropping pending ownership", async () => {
    process.env.PROVISION_AUTOAPPLY = "auto";
    const name = "ambiguous-upgrade";
    const key = `skill/${name}`;
    const target = path.join(skillsDir, name);
    mkdirSync(target);
    writeFileSync(path.join(target, "OLD.md"), "old contents");
    writeFileSync(path.join(target, "NEW.md"), "new contents");
    const replacement = serveSkill("/ambiguous-upgrade.tgz", "replacement contents");
    const journal = {
      sha256: "a".repeat(64),
      files: ["OLD.md"],
      directories: [],
      fileHashes: { "OLD.md": sha(Buffer.from("old contents")) },
      installedAt: new Date().toISOString(),
      pending: {
	sha256: "b".repeat(64),
	files: ["NEW.md"],
	directories: [],
	fileHashes: { "NEW.md": sha(Buffer.from("new contents")) },
	installedAt: new Date().toISOString(),
      },
    };
    writeFileSync(path.join(stateDir, "provision.lock.json"), JSON.stringify({
      version: 1,
      approved: [key],
      revoked: [],
      installed: { [key]: journal },
    }));
    initProvisioning();
    registerManifestUrl(serveManifest([{ type: "skill", name, ...replacement }]));

    const view = await syncNow();

    assert.equal(statusOf(view, name), "failed");
    assert.match(view.data.find((item) => item.name === name)?.error ?? "", /journal is resolved/i);
    const state = JSON.parse(readFileSync(path.join(stateDir, "provision.lock.json"), "utf8"));
    assert.deepEqual(state.installed[key], journal);
    assert.deepEqual(await deleteItem("skill", name), { removed: true });
    assert.equal(existsSync(target), false);
  });

  test("removal after an interrupted upgrade recognizes candidate-owned files", async () => {
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const target = path.join(skillsDir, "remove-pending");
    mkdirSync(target);
    writeFileSync(path.join(target, "NEW.md"), "new contents");
    writeFileSync(path.join(stateDir, "provision.lock.json"), JSON.stringify({
      version: 1,
      approved: ["skill/remove-pending"],
      revoked: [],
      installed: {
	"skill/remove-pending": {
	  sha256: "a".repeat(64),
	  files: ["OLD.md"],
	  fileHashes: { "OLD.md": sha(Buffer.from("old contents")) },
	  installedAt: new Date().toISOString(),
	  pending: {
	    sha256: "b".repeat(64),
	    files: ["NEW.md"],
	    fileHashes: { "NEW.md": sha(Buffer.from("new contents")) },
	    installedAt: new Date().toISOString(),
	  },
	},
      },
    }));
    initProvisioning();
    registerManifestUrl(serveManifest([]));

    const view = await syncNow();

    assert.equal(statusOf(view, "remove-pending"), "removed");
    assert.equal(existsSync(target), false);
  });

  test("DELETE preserves an empty target that won an interrupted upgrade exposure race", async () => {
    const name = "remove-lost-exposure";
    const { key, target } = writeLostExposureJournal(name);

    assert.deepEqual(await deleteItem("skill", name), { removed: true });
    assert.equal(lstatSync(target).isDirectory(), true);
    assert.deepEqual(readdirSync(target), []);
    const state = JSON.parse(readFileSync(path.join(stateDir, "provision.lock.json"), "utf8"));
    assert.equal(state.installed[key], undefined);
  });

  test("manifest removal preserves an empty target that won an upgrade exposure race", async () => {
    const name = "sync-remove-lost-exposure";
    const { key, target } = writeLostExposureJournal(name);
    registerManifestUrl(serveManifest([]));

    const view = await syncNow();

    assert.equal(statusOf(view, name), "removed");
    assert.equal(lstatSync(target).isDirectory(), true);
    assert.deepEqual(readdirSync(target), []);
    const state = JSON.parse(readFileSync(path.join(stateDir, "provision.lock.json"), "utf8"));
    assert.equal(state.installed[key], undefined);
  });

  test("DELETE preserves a replacement directory swapped in after removal validation", async () => {
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const name = "delete-root-swap";
    const skill = serveSkill("/delete-root-swap.tgz", "managed");
    registerManifestUrl(serveManifest([{ type: "skill", name, ...skill }]));
    await syncNow();
    const target = path.join(skillsDir, name);
    const displaced = path.join(skillsDir, `${name}-displaced`);
    initProvisioning({
      afterRemovalAudit: () => {
	renameSync(target, displaced);
	mkdirSync(target);
      },
    });

    assert.deepEqual(await deleteItem("skill", name), { removed: true });

    assert.equal(lstatSync(target).isDirectory(), true);
    assert.deepEqual(readdirSync(target), []);
    assert.equal(readFileSync(path.join(displaced, "SKILL.md"), "utf8"), "managed");
  });

  test("manifest removal preserves a replacement swapped in after validation", async () => {
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const name = "manifest-root-swap";
    const skill = serveSkill("/manifest-root-swap.tgz", "managed");
    registerManifestUrl(serveManifest([{ type: "skill", name, ...skill }]));
    await syncNow();
    const target = path.join(skillsDir, name);
    const displaced = path.join(skillsDir, `${name}-displaced`);
    initProvisioning({
      afterRemovalAudit: () => {
	renameSync(target, displaced);
	mkdirSync(target);
      },
    });
    registerManifestUrl(serveManifest([]));

    const view = await syncNow();

    assert.equal(statusOf(view, name), "removed");
    assert.equal(lstatSync(target).isDirectory(), true);
    assert.deepEqual(readdirSync(target), []);
    assert.equal(readFileSync(path.join(displaced, "SKILL.md"), "utf8"), "managed");
  });

  test("removal accepts either hash for a path shared by upgrade journal snapshots", async () => {
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const target = path.join(skillsDir, "remove-shared-pending");
    mkdirSync(target);
    writeFileSync(path.join(target, "SKILL.md"), "new contents");
    writeFileSync(path.join(stateDir, "provision.lock.json"), JSON.stringify({
      version: 1,
      approved: ["skill/remove-shared-pending"],
      revoked: [],
      installed: {
	"skill/remove-shared-pending": {
	  sha256: "a".repeat(64),
	  files: ["SKILL.md"],
	  fileHashes: { "SKILL.md": sha(Buffer.from("old contents")) },
	  installedAt: new Date().toISOString(),
	  pending: {
	    sha256: "b".repeat(64),
	    files: ["SKILL.md"],
	    fileHashes: { "SKILL.md": sha(Buffer.from("new contents")) },
	    installedAt: new Date().toISOString(),
	  },
	},
      },
    }));
    initProvisioning();
    registerManifestUrl(serveManifest([]));

    const view = await syncNow();

    assert.equal(statusOf(view, "remove-shared-pending"), "removed");
    assert.equal(existsSync(target), false);
  });

  test("upgrade staging recoveries are lockfile-owned and retained", async () => {
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const spoofedId = "f".repeat(32);
    const spoofed = path.join(skillsDir, `.provision-staging-${spoofedId}`);
    mkdirSync(spoofed);
    writeFileSync(path.join(spoofed, "keep.txt"), "user-owned");
    writeFileSync(path.join(spoofed, ".upgrade-recovery.json"), JSON.stringify({
      version: 1,
      skill: "bounded-upgrade",
      createdAt: "2020-01-01T00:00:00.000Z",
      recoveryId: spoofedId,
    }));

    for (let version = 1; version <= 6; version += 1) {
      const skill = serveSkill(`/bounded-upgrade-${version}.tgz`, `v${version}`);
      registerManifestUrl(serveManifest([{
	type: "skill",
	name: "bounded-upgrade",
	...skill,
      }]));
      assert.equal(statusOf(await syncNow(), "bounded-upgrade"), "installed");
    }

    const state = JSON.parse(readFileSync(path.join(stateDir, "provision.lock.json"), "utf8"));
    assert.equal(state.upgradeRecoveries.length, 5);
    assert.deepEqual(
      readdirSync(skillsDir)
	.filter((entry) => entry.startsWith(".provision-staging-")
	  && entry !== `.provision-staging-${spoofedId}`)
	.sort(),
      state.upgradeRecoveries.map((id: string) => `.provision-staging-${id}`).sort(),
    );
    assert.equal(readFileSync(path.join(spoofed, "keep.txt"), "utf8"), "user-owned");
  });

  test("deleting an item uninstalls it and revokes its approval", async () => {
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const skill = serveSkill("/a.tgz", "a");
    registerManifestUrl(serveManifest([{ type: "skill", name: "aaa", ...skill }]));
    await syncNow();

    process.env.PROVISION_AUTOAPPLY = "approve";
    initProvisioning();
    registerManifestUrl(serveManifest([{ type: "skill", name: "aaa", ...skill }]));
    assert.deepEqual(await deleteItem("skill", "aaa"), { removed: true });
    assert.equal(existsSync(path.join(skillsDir, "aaa")), false);

    const view = await syncNow();
    assert.equal(statusOf(view, "aaa"), "pending_approval");
  });

  test("DELETE remains revoked in auto mode until the item leaves the manifest", async () => {
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const skill = serveSkill("/a.tgz", "a");
    registerManifestUrl(serveManifest([{ type: "skill", name: "aaa", ...skill }]));
    await syncNow();

    assert.deepEqual(await deleteItem("skill", "aaa"), { removed: true });
    assert.equal(existsSync(path.join(skillsDir, "aaa")), false);
    assert.equal(statusOf(await syncNow(), "aaa"), "pending_approval");
    assert.equal(existsSync(path.join(skillsDir, "aaa")), false);

    registerManifestUrl(serveManifest([]));
    await syncNow();
    registerManifestUrl(serveManifest([{ type: "skill", name: "aaa", ...skill }]));
    assert.equal(statusOf(await syncNow(), "aaa"), "installed");
  });

  test("DELETE waits for an active sync and cannot be undone by its stale state", async () => {
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const skill = serveSkill("/slow.tgz", "slow");
    registerManifestUrl(serveManifest([{ type: "skill", name: "slow", ...skill }]));
    let release!: () => void;
    responseGates.set("/slow.tgz", new Promise<void>((resolve) => { release = resolve; }));

    const syncing = syncNow();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const deleting = deleteItem("skill", "slow");
    release();
    await syncing;
    assert.deepEqual(await deleting, { removed: true });
    assert.equal(existsSync(path.join(skillsDir, "slow")), false);
    assert.equal(statusOf(await syncNow(), "slow"), "pending_approval");
  });

  test("same-hash sync repairs missing and modified installed files", async () => {
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const skill = serveSkill("/drift.tgz", "expected");
    registerManifestUrl(serveManifest([{ type: "skill", name: "drift", ...skill }]));
    await syncNow();
    const file = path.join(skillsDir, "drift", "SKILL.md");

    writeFileSync(file, "tampered");
    await syncNow();
    assert.equal(readFileSync(file, "utf8"), "expected");

    rmSync(file);
    await syncNow();
    assert.equal(readFileSync(file, "utf8"), "expected");
  });

  test("a manifest URL change during sync queues and awaits a follow-up sync", async () => {
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const first = serveSkill("/first.tgz", "first");
    const second = serveSkill("/second.tgz", "second");
    responses.set("/first.json", { schema: "agent-provisioning/v1", items: [{ type: "skill", name: "first", ...first }] });
    responses.set("/second.json", { schema: "agent-provisioning/v1", items: [{ type: "skill", name: "second", ...second }] });
    let release!: () => void;
    responseGates.set("/first.tgz", new Promise<void>((resolve) => { release = resolve; }));

    registerManifestUrl(`${baseUrl}/first.json`);
    const firstSync = syncNow();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const switched = handleAuthorizedSession(`${baseUrl}/second.json`);
    release();
    await Promise.all([firstSync, switched]);

    assert.equal(getStatus().manifest_url, `${baseUrl}/second.json`);
    assert.equal(existsSync(path.join(skillsDir, "first")), false);
    assert.equal(existsSync(path.join(skillsDir, "second", "SKILL.md")), true);
  });

  test("shutdown waits for an active sync before clearing module state", async () => {
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const skill = serveSkill("/shutdown.tgz", "installed before shutdown completes");
    registerManifestUrl(serveManifest([{ type: "skill", name: "shutdown", ...skill }]));
    let release!: () => void;
    responseGates.set("/shutdown.tgz", new Promise<void>((resolve) => { release = resolve; }));

    const syncing = syncNow();
    await new Promise((resolve) => setTimeout(resolve, 20));
    let stopped = false;
    const shutdown = shutdownProvisioning().then(() => { stopped = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(stopped, false, "reset must stay attached to the active generation");

    release();
    await Promise.all([syncing, shutdown]);
    assert.equal(stopped, true);
    assert.equal(getStatus().enabled, false);
  });

  test("approving an item the manifest never named is unknown_item", async () => {
    registerManifestUrl(serveManifest([]));
    await syncNow();
    assert.equal(await codeOf(() => approveItem("skill", "ghost")), "unknown_item");
  });

  test("a successful auth session registers the manifest url and syncs", async () => {
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const skill = serveSkill("/pr-monitor.tgz", "hi");
    const manifestUrl = serveManifest([{ type: "skill", name: "pr-monitor", ...skill }]);

    await handleAuthorizedSession(manifestUrl);
    assert.equal(getStatus().manifest_url, manifestUrl);
    assert.equal(existsSync(path.join(skillsDir, "pr-monitor", "SKILL.md")), true);
  });

  test("a sync failure after an authorized session is recorded, not thrown", async () => {
    await handleAuthorizedSession(`${baseUrl}/nope.json`);
    assert.match(getStatus().last_error ?? "", /HTTP 404|fetch/i);
  });

  test("PROVISION_MANIFEST_URL performs an initial sync even when refetch is disabled", async () => {
    process.env.PROVISION_AUTOAPPLY = "auto";
    process.env.PROVISION_REFETCH_MS = "0";
    const skill = serveSkill("/startup.tgz", "startup");
    process.env.PROVISION_MANIFEST_URL = serveManifest([{ type: "skill", name: "startup", ...skill }]);
    initProvisioning();
    assert.equal(getStatus().manifest_url, `${baseUrl}/provision.json`);
    await syncNow();
    assert.equal(existsSync(path.join(skillsDir, "startup", "SKILL.md")), true);
  });

  test("PROVISION_MANIFEST_URL is removed from the gateway environment after capture", () => {
    process.env.PROVISION_REFETCH_MS = "0";
    responses.set("/provision.json?token=secret", { schema: "agent-provisioning/v1", items: [] });
    const fixedManifestUrl = `${baseUrl}/provision.json?token=secret`;
    process.env.PROVISION_MANIFEST_URL = fixedManifestUrl;

    initProvisioning();

    assert.equal(getStatus().manifest_url, fixedManifestUrl);
    assert.equal(
      "PROVISION_MANIFEST_URL" in process.env,
      false,
      "a same-uid completion must not recover manifest credentials from the gateway environment",
    );
  });

  test("with no sync yet, status lists what the lockfile says is installed", async () => {
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const skill = serveSkill("/a.tgz", "a");
    registerManifestUrl(serveManifest([{ type: "skill", name: "aaa", ...skill }]));
    await syncNow();

    resetProvisioning();
    initProvisioning();
    assert.equal(statusOf(getStatus(), "aaa"), "installed");
  });

  test("startup status omits an uncommitted first-install preclaim", () => {
    const key = "skill/startup-preclaim";
    writeFileSync(path.join(stateDir, "provision.lock.json"), JSON.stringify({
      version: 1,
      approved: [],
      revoked: [],
      installed: {
	[key]: {
	  sha256: "a".repeat(64),
	  files: ["SKILL.md"],
	  directories: [],
	  fileHashes: { "SKILL.md": sha(Buffer.from("never exposed")) },
	  installedAt: new Date().toISOString(),
	  uncommitted: true,
	  installMarker: "b".repeat(32),
	},
      },
    }));

    initProvisioning();

    assert.equal(statusOf(getStatus(), "startup-preclaim"), undefined);
    const state = JSON.parse(readFileSync(path.join(stateDir, "provision.lock.json"), "utf8"));
    assert.equal(state.installed[key].uncommitted, true);
  });

  test("startup status omits an unresolved upgrade journal", () => {
    const key = "skill/startup-upgrade";
    writeFileSync(path.join(stateDir, "provision.lock.json"), JSON.stringify({
      version: 1,
      approved: [key],
      revoked: [],
      installed: {
	[key]: {
	  sha256: "a".repeat(64),
	  files: ["SKILL.md"],
	  directories: [],
	  fileHashes: { "SKILL.md": sha(Buffer.from("stable")) },
	  installedAt: new Date().toISOString(),
	  pending: {
	    sha256: "b".repeat(64),
	    files: ["SKILL.md"],
	    directories: [],
	    fileHashes: { "SKILL.md": sha(Buffer.from("candidate")) },
	    installedAt: new Date().toISOString(),
	  },
	},
      },
    }));

    initProvisioning();

    assert.equal(statusOf(getStatus(), "startup-upgrade"), undefined);
    const state = JSON.parse(readFileSync(path.join(stateDir, "provision.lock.json"), "utf8"));
    assert.equal(state.installed[key].pending.sha256, "b".repeat(64));
  });
});
