import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "child_process";
import { createHash } from "crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
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
import { registeredManifestFilePath } from "./state.js";

/** Single-file tar.gz, enough for sync-level tests (installer has its own suite). */
function skillArchive(content: string, fileName = "SKILL.md"): Buffer {
  const body = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(fileName, 0, 100, "utf-8");
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

async function serveMutableGitRepository(): Promise<{
  url: string;
  revision: string;
  update: (contents: string) => string;
  close: () => Promise<void>;
}> {
  const root = mkdtempSync(path.join(tmpdir(), "provision-sync-git-"));
  const source = path.join(root, "source");
  const bare = path.join(root, "skill.git");
  mkdirSync(source);
  execFileSync("git", ["init", "--quiet"], { cwd: source });
  const commit = (contents: string, message: string): string => {
    writeFileSync(path.join(source, "SKILL.md"), contents);
    execFileSync("git", ["add", "SKILL.md"], { cwd: source });
    execFileSync("git", [
      "-c", "user.name=Provision Test",
      "-c", "user.email=provision@example.invalid",
      "commit", "--quiet", "-m", message,
    ], { cwd: source });
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim();
  };
  let revision = commit("branch v1", "v1");
  execFileSync("git", ["branch", "-M", "main"], { cwd: source });
  execFileSync("git", ["clone", "--quiet", "--bare", source, bare]);

  const repositoryServer = createServer((req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const backend = spawn("git", ["http-backend"], {
      env: {
	...process.env,
	GIT_PROJECT_ROOT: root,
	GIT_HTTP_EXPORT_ALL: "1",
	PATH_INFO: requestUrl.pathname,
	QUERY_STRING: requestUrl.search.slice(1),
	REQUEST_METHOD: req.method ?? "GET",
	CONTENT_TYPE: req.headers["content-type"] ?? "",
	CONTENT_LENGTH: req.headers["content-length"] ?? "",
      },
      stdio: ["pipe", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    backend.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    backend.on("close", () => {
      const response = Buffer.concat(chunks);
      const boundary = response.indexOf("\r\n\r\n");
      if (boundary < 0) {
	res.statusCode = 500;
	res.end();
	return;
      }
      for (const header of response.subarray(0, boundary).toString("utf8").split("\r\n")) {
	const separator = header.indexOf(":");
	if (separator < 0) continue;
	const name = header.slice(0, separator);
	const value = header.slice(separator + 1).trim();
	if (name.toLowerCase() === "status") res.statusCode = Number.parseInt(value, 10);
	else res.setHeader(name, value);
      }
      res.end(response.subarray(boundary + 4));
    });
    req.pipe(backend.stdin);
  });
  await new Promise<void>((resolve) => repositoryServer.listen(0, "127.0.0.1", resolve));
  const address = repositoryServer.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}/skill.git`,
    revision,
    update: (contents: string) => {
      revision = commit(contents, "update");
      execFileSync("git", ["push", "--quiet", bare, "main"], { cwd: source });
      return revision;
    },
    close: async () => {
      repositoryServer.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => repositoryServer.close((err) => err ? reject(err) : resolve()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const SAVED_VARS = [
  "PROVISION_SYNC",
  "PROVISION_AUTOAPPLY",
  "PROVISION_MANIFEST_URL",
  "PROVISION_ALLOWLIST",
  "PROVISION_STATE_DIR",
  "PROVISION_SKILLS_DIR",
  "PROVISION_SKILL_LINK_DIRS",
  "PROVISION_CONFIG_DIR",
  "PROVISION_REFETCH_MS",
  "AUTH_ADMIN_KEYS",
  "HOME",
] as const;

describe("provision sync", () => {
  let server: Server;
  let baseUrl: string;
  let responses: Map<string, Buffer | object>;
  let responseGates: Map<string, Promise<void>>;
  let stateDir: string;
  let skillsDir: string;
  let configDir: string;
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
    configDir = mkdtempSync(path.join(tmpdir(), "provision-sync-config-"));
    process.env.PROVISION_STATE_DIR = stateDir;
    process.env.PROVISION_SKILLS_DIR = skillsDir;
    process.env.PROVISION_SKILL_LINK_DIRS = "";
    process.env.PROVISION_CONFIG_DIR = configDir;
    process.env.PROVISION_SYNC = "1";
    process.env.AUTH_ADMIN_KEYS = "test-admin-secret";
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
    rmSync(configDir, { recursive: true, force: true });
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

  function configItem(token: string, artifactPath = "/config.tar.gz") {
    const body = JSON.stringify({ url: "https://collavre.example.com", token });
    const archive = skillArchive(body, "config.json");
    responses.set(artifactPath, archive);
    return {
      body,
      item: {
	type: "config",
	name: "collavre",
	url: `${baseUrl}${artifactPath}`,
	sha256: sha(archive),
      },
    };
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

  test("a pending git item reports its revision and subpath without exposing the URL", async () => {
    registerManifestUrl(serveManifest([{
      type: "skill",
      name: "git-skill",
      git: {
	url: `${baseUrl}/public-skill.git`,
	rev: "a".repeat(40),
	path: "skills/demo",
      },
    }]));

    const view = await syncNow();
    assert.deepEqual(view.data[0], {
      type: "skill",
      name: "git-skill",
      status: "pending_approval",
      git: { rev: "a".repeat(40), path: "skills/demo" },
    });
  });

  test("a branch is locked to its resolved commit and upgrades only when it moves", async () => {
    const repository = await serveMutableGitRepository();
    try {
      process.env.PROVISION_AUTOAPPLY = "auto";
      initProvisioning();
      registerManifestUrl(serveManifest([{
	type: "skill",
	name: "branch-skill",
	git: { url: repository.url, rev: "main" },
      }]));

      const first = await syncNow();
      assert.equal(statusOf(first, "branch-skill"), "installed");
      assert.equal(first.data[0]!.git?.resolved_rev, repository.revision);
      assert.equal(readFileSync(path.join(skillsDir, "branch-skill", "SKILL.md"), "utf8"), "branch v1");
      const firstInode = lstatSync(path.join(skillsDir, "branch-skill"), { bigint: true }).ino;

      const unchanged = await syncNow();
      assert.equal(unchanged.data[0]!.git?.resolved_rev, repository.revision);
      assert.equal(lstatSync(path.join(skillsDir, "branch-skill"), { bigint: true }).ino, firstInode);

      const nextRevision = repository.update("branch v2");
      const upgraded = await syncNow();
      assert.equal(upgraded.data[0]!.git?.resolved_rev, nextRevision);
      assert.equal(readFileSync(path.join(skillsDir, "branch-skill", "SKILL.md"), "utf8"), "branch v2");
      const state = JSON.parse(readFileSync(path.join(stateDir, "provision.lock.json"), "utf8"));
      assert.deepEqual(state.installed["skill/branch-skill"].source, {
	type: "git",
	ref: "main",
	rev: nextRevision,
      });
    } finally {
      await repository.close();
    }
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

  test("fans one canonical skill out through managed discovery links", async () => {
    const linkDir = path.join(stateDir, "claude-skills");
    process.env.PROVISION_SKILL_LINK_DIRS = linkDir;
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const skill = serveSkill("/linked.tgz", "linked skill");
    registerManifestUrl(serveManifest([{ type: "skill", name: "linked", ...skill }]));

    const installed = await syncNow();
    const link = path.join(linkDir, "linked");
    const target = path.join(skillsDir, "linked");
    assert.equal(statusOf(installed, "linked"), "installed");
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(path.resolve(path.dirname(link), readlinkSync(link)), target);
    const state = JSON.parse(readFileSync(path.join(stateDir, "provision.lock.json"), "utf8"));
    assert.equal(state.installed["skill/linked"].skillLinks[0].path, link);

    const linkIdentity = lstatSync(link, { bigint: true }).ino;
    const upgradedSkill = serveSkill("/linked-v2.tgz", "linked skill v2");
    registerManifestUrl(serveManifest([{ type: "skill", name: "linked", ...upgradedSkill }]));
    const upgraded = await syncNow();
    assert.equal(statusOf(upgraded, "linked"), "installed");
    assert.equal(lstatSync(link, { bigint: true }).ino, linkIdentity);
    assert.equal(readFileSync(path.join(target, "SKILL.md"), "utf8"), "linked skill v2");

    responses.set("/provision.json", { schema: "agent-provisioning/v1", items: [] });
    const removed = await syncNow();
    assert.equal(statusOf(removed, "linked"), "removed");
    assert.equal(existsSync(link), false);
    assert.equal(existsSync(target), false);
  });

  test("recovers a discovery link published after its ownership intent was saved", async () => {
    const linkDir = path.join(stateDir, "claude-skills");
    process.env.PROVISION_SKILL_LINK_DIRS = linkDir;
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const skill = serveSkill("/interrupted-link.tgz", "managed");
    registerManifestUrl(serveManifest([{ type: "skill", name: "linked", ...skill }]));
    await syncNow();

    const statePath = path.join(stateDir, "provision.lock.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const link = path.join(linkDir, "linked");
    const target = path.join(skillsDir, "linked");
    delete state.installed["skill/linked"].skillLinks;
    state.installed["skill/linked"].skillLinkPublication = { path: link, target };
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

    const recovered = await syncNow();
    assert.equal(statusOf(recovered, "linked"), "installed");
    const recoveredState = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(recoveredState.installed["skill/linked"].skillLinkPublication, undefined);
    assert.equal(recoveredState.installed["skill/linked"].skillLinks[0].path, link);
    assert.equal(
      recoveredState.installed["skill/linked"].skillLinks[0].ino,
      lstatSync(link, { bigint: true }).ino.toString(),
    );
  });

  test("removes a discovery link left at the ownership-publication crash point", async () => {
    const linkDir = path.join(stateDir, "claude-skills");
    process.env.PROVISION_SKILL_LINK_DIRS = linkDir;
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const skill = serveSkill("/interrupted-link-removal.tgz", "managed");
    registerManifestUrl(serveManifest([{ type: "skill", name: "linked", ...skill }]));
    await syncNow();

    const statePath = path.join(stateDir, "provision.lock.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const link = path.join(linkDir, "linked");
    const target = path.join(skillsDir, "linked");
    delete state.installed["skill/linked"].skillLinks;
    state.installed["skill/linked"].skillLinkPublication = { path: link, target };
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
    responses.set("/provision.json", { schema: "agent-provisioning/v1", items: [] });

    const removed = await syncNow();
    assert.equal(statusOf(removed, "linked"), "removed");
    assert.equal(existsSync(link), false);
    assert.equal(existsSync(target), false);
  });

  test("migrates the previous Claude default into the shared Codex source", async () => {
    const testHome = path.join(stateDir, "home");
    const legacySkillsDir = path.join(testHome, ".claude", "skills");
    process.env.HOME = testHome;
    process.env.PROVISION_SKILLS_DIR = legacySkillsDir;
    process.env.PROVISION_SKILL_LINK_DIRS = "";
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const skill = serveSkill("/legacy-default.tgz", "legacy managed skill");
    registerManifestUrl(serveManifest([{ type: "skill", name: "legacy", ...skill }]));
    await syncNow();
    assert.equal(existsSync(path.join(legacySkillsDir, "legacy", "SKILL.md")), true);
    const statePath = path.join(stateDir, "provision.lock.json");
    const legacyState = JSON.parse(readFileSync(statePath, "utf8"));
    delete legacyState.installed["skill/legacy"].installRoot;
    writeFileSync(statePath, `${JSON.stringify(legacyState, null, 2)}\n`);

    process.env.PROVISION_SKILLS_DIR = path.join(testHome, ".agents", "skills");
    delete process.env.PROVISION_SKILL_LINK_DIRS;
    initProvisioning();
    registerManifestUrl(`${baseUrl}/provision.json`);
    const migrated = await syncNow();
    const canonical = path.join(testHome, ".agents", "skills", "legacy");
    const link = path.join(legacySkillsDir, "legacy");
    assert.equal(statusOf(migrated, "legacy"), "installed");
    assert.equal(readFileSync(path.join(canonical, "SKILL.md"), "utf8"), "legacy managed skill");
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(path.resolve(path.dirname(link), readlinkSync(link)), canonical);
    assert.equal(
      readdirSync(legacySkillsDir).some((entry) => entry.startsWith(".provision-removed-")),
      true,
    );
  });

  test("keeps the legacy skill live when its migration artifact fails", async () => {
    const testHome = path.join(stateDir, "failed-migration-home");
    const legacySkillsDir = path.join(testHome, ".claude", "skills");
    process.env.HOME = testHome;
    process.env.PROVISION_SKILLS_DIR = legacySkillsDir;
    process.env.PROVISION_SKILL_LINK_DIRS = "";
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const skill = serveSkill("/legacy-before-failed-migration.tgz", "live legacy skill");
    registerManifestUrl(serveManifest([{ type: "skill", name: "legacy", ...skill }]));
    await syncNow();

    const statePath = path.join(stateDir, "provision.lock.json");
    const legacyState = JSON.parse(readFileSync(statePath, "utf8"));
    delete legacyState.installed["skill/legacy"].installRoot;
    writeFileSync(statePath, `${JSON.stringify(legacyState, null, 2)}\n`);

    delete process.env.PROVISION_SKILLS_DIR;
    delete process.env.PROVISION_SKILL_LINK_DIRS;
    initProvisioning();
    registerManifestUrl(serveManifest([{
      type: "skill",
      name: "legacy",
      url: `${baseUrl}/missing-migration-artifact.tgz`,
      sha256: "a".repeat(64),
    }]));

    const failed = await syncNow();
    const legacyTarget = path.join(legacySkillsDir, "legacy");
    assert.equal(statusOf(failed, "legacy"), "failed");
    assert.match(failed.data[0]!.error!, /Download failed: HTTP 404/);
    assert.equal(readFileSync(path.join(legacyTarget, "SKILL.md"), "utf8"), "live legacy skill");
    assert.equal(lstatSync(legacyTarget).isSymbolicLink(), false);
    assert.equal(existsSync(path.join(testHome, ".agents", "skills", "legacy")), false);
    assert.equal(
      readdirSync(legacySkillsDir).some((entry) => entry.startsWith(".provision-removed-")),
      false,
    );
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(state.installed["skill/legacy"].installRoot, legacySkillsDir);
    assert.equal(state.installed["skill/legacy"].removalRecoveryId, undefined);
  });

  test("restores the legacy skill when canonical publication loses a race", async () => {
    const testHome = path.join(stateDir, "migration-race-home");
    const legacySkillsDir = path.join(testHome, ".claude", "skills");
    process.env.HOME = testHome;
    process.env.PROVISION_SKILLS_DIR = legacySkillsDir;
    process.env.PROVISION_SKILL_LINK_DIRS = "";
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const original = serveSkill("/legacy-before-race.tgz", "live legacy skill");
    registerManifestUrl(serveManifest([{ type: "skill", name: "legacy", ...original }]));
    await syncNow();

    const statePath = path.join(stateDir, "provision.lock.json");
    const legacyState = JSON.parse(readFileSync(statePath, "utf8"));
    delete legacyState.installed["skill/legacy"].installRoot;
    writeFileSync(statePath, `${JSON.stringify(legacyState, null, 2)}\n`);

    delete process.env.PROVISION_SKILLS_DIR;
    delete process.env.PROVISION_SKILL_LINK_DIRS;
    const canonical = path.join(testHome, ".agents", "skills", "legacy");
    initProvisioning({
      beforeSkillCandidateMove: (target) => {
	assert.equal(target, canonical);
	mkdirSync(target);
	writeFileSync(path.join(target, "USER.md"), "race winner");
      },
    });
    const replacement = serveSkill("/legacy-race-replacement.tgz", "replacement");
    registerManifestUrl(serveManifest([{ type: "skill", name: "legacy", ...replacement }]));

    const failed = await syncNow();
    const legacyTarget = path.join(legacySkillsDir, "legacy");
    assert.equal(statusOf(failed, "legacy"), "failed");
    assert.match(failed.data[0]!.error!, /target appeared during installation/);
    assert.equal(readFileSync(path.join(legacyTarget, "SKILL.md"), "utf8"), "live legacy skill");
    assert.equal(lstatSync(legacyTarget).isSymbolicLink(), false);
    assert.equal(readFileSync(path.join(canonical, "USER.md"), "utf8"), "race winner");
    assert.equal(
      readdirSync(legacySkillsDir).some((entry) => entry.startsWith(".provision-removed-")),
      false,
    );
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(state.installed["skill/legacy"].installRoot, legacySkillsDir);
    assert.equal(state.installed["skill/legacy"].legacySkillMigration, undefined);
    assert.equal(state.installed["skill/legacy"].removalRecoveryId, undefined);
  });

  test("restores legacy ownership after a crash before canonical publication", async () => {
    const testHome = path.join(stateDir, "migration-crash-home");
    const legacySkillsDir = path.join(testHome, ".claude", "skills");
    process.env.HOME = testHome;
    process.env.PROVISION_SKILLS_DIR = legacySkillsDir;
    process.env.PROVISION_SKILL_LINK_DIRS = "";
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const original = serveSkill("/legacy-before-crash.tgz", "live legacy skill");
    registerManifestUrl(serveManifest([{ type: "skill", name: "legacy", ...original }]));
    await syncNow();

    const statePath = path.join(stateDir, "provision.lock.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const legacyRecord = state.installed["skill/legacy"];
    delete legacyRecord.installRoot;
    const recoveryId = "a".repeat(32);
    const legacyTarget = path.join(legacySkillsDir, "legacy");
    const recovery = path.join(legacySkillsDir, `.provision-removed-${recoveryId}`);
    renameSync(legacyTarget, recovery);
    const recoveryStat = lstatSync(recovery, { bigint: true });
    const canonicalRoot = path.join(testHome, ".agents", "skills");
    state.installed["skill/legacy"] = {
      sha256: "b".repeat(64),
      files: ["SKILL.md"],
      directories: [],
      fileHashes: { "SKILL.md": sha(Buffer.from("replacement")) },
      installedAt: new Date().toISOString(),
      installRoot: canonicalRoot,
      uncommitted: true,
      candidateIdentity: {
	dev: recoveryStat.dev.toString(),
	ino: recoveryStat.ino.toString(),
      },
      pending: legacyRecord,
      legacySkillMigration: {
	installedKey: "skill/legacy",
	installRoot: legacySkillsDir,
	recoveryIdentity: {
	  dev: recoveryStat.dev.toString(),
	  ino: recoveryStat.ino.toString(),
	},
      },
      removalRecoveryId: recoveryId,
    };
    state.removalRecoveries = [recoveryId];
    state.removalRecoveryRoots = { [recoveryId]: legacySkillsDir };
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

    delete process.env.PROVISION_SKILLS_DIR;
    delete process.env.PROVISION_SKILL_LINK_DIRS;
    initProvisioning();
    registerManifestUrl(serveManifest([{
      type: "skill",
      name: "legacy",
      url: `${baseUrl}/missing-after-migration-crash.tgz`,
      sha256: "c".repeat(64),
    }]));

    const failed = await syncNow();
    assert.equal(statusOf(failed, "legacy"), "failed");
    assert.equal(readFileSync(path.join(legacyTarget, "SKILL.md"), "utf8"), "live legacy skill");
    assert.equal(existsSync(recovery), false);
    const restored = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(restored.installed["skill/legacy"].installRoot, legacySkillsDir);
    assert.equal(restored.installed["skill/legacy"].legacySkillMigration, undefined);
    assert.deepEqual(restored.removalRecoveries, []);
  });

  test("migrates a legacy root whose interrupted upgrade published the pending snapshot", async () => {
    const testHome = path.join(stateDir, "pending-migration-home");
    const legacySkillsDir = path.join(testHome, ".claude", "skills");
    process.env.HOME = testHome;
    process.env.PROVISION_SKILLS_DIR = legacySkillsDir;
    process.env.PROVISION_SKILL_LINK_DIRS = "";
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const stable = serveSkill("/legacy-pending-v1.tgz", "stable contents");
    registerManifestUrl(serveManifest([{ type: "skill", name: "legacy-pending", ...stable }]));
    await syncNow();

    const statePath = path.join(stateDir, "provision.lock.json");
    const legacyState = JSON.parse(readFileSync(statePath, "utf8"));
    const record = legacyState.installed["skill/legacy-pending"];
    const pending = serveSkill("/legacy-pending-v2.tgz", "pending contents");
    delete record.installRoot;
    record.pending = {
	sha256: pending.sha256,
	files: ["SKILL.md"],
	directories: [],
	fileHashes: { "SKILL.md": sha(Buffer.from("pending contents")) },
	installedAt: new Date().toISOString(),
    };
    writeFileSync(
      path.join(legacySkillsDir, "legacy-pending", "SKILL.md"),
      "pending contents",
    );
    writeFileSync(statePath, `${JSON.stringify(legacyState, null, 2)}\n`);

    delete process.env.PROVISION_SKILLS_DIR;
    delete process.env.PROVISION_SKILL_LINK_DIRS;
    initProvisioning();
    registerManifestUrl(serveManifest([{ type: "skill", name: "legacy-pending", ...pending }]));

    const migrated = await syncNow();
    const canonical = path.join(testHome, ".agents", "skills", "legacy-pending");
    assert.equal(statusOf(migrated, "legacy-pending"), "installed");
    assert.equal(readFileSync(path.join(canonical, "SKILL.md"), "utf8"), "pending contents");
    assert.equal(lstatSync(path.join(legacySkillsDir, "legacy-pending")).isSymbolicLink(), true);
    const migratedState = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(migratedState.installed["skill/legacy-pending"].pending, undefined);
    assert.equal(
      migratedState.installed["skill/legacy-pending"].installRoot,
      path.join(testHome, ".agents", "skills"),
    );
  });

  test("preserves case-fold-colliding records during legacy root migration", async () => {
    const testHome = path.join(stateDir, "case-fold-migration-home");
    const legacySkillsDir = path.join(testHome, ".claude", "skills");
    const records = {
	"skill/demo": "managed contents",
	"skill/Demo": "managed contents",
    };
    const installed: Record<string, object> = {};
    for (const [key, contents] of Object.entries(records)) {
	const name = key.slice(key.indexOf("/") + 1);
	const target = path.join(legacySkillsDir, name);
	mkdirSync(target, { recursive: true });
	writeFileSync(path.join(target, "SKILL.md"), contents);
	installed[key] = {
	  sha256: "a".repeat(64),
	  files: ["SKILL.md"],
	  directories: [],
	  fileHashes: { "SKILL.md": sha(Buffer.from(contents)) },
	  installedAt: new Date().toISOString(),
	};
    }
    writeFileSync(path.join(stateDir, "provision.lock.json"), JSON.stringify({
	version: 1,
	approved: [],
	revoked: [],
	installed,
    }));
    process.env.HOME = testHome;
    delete process.env.PROVISION_SKILLS_DIR;
    delete process.env.PROVISION_SKILL_LINK_DIRS;
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const replacement = serveSkill("/case-fold-root-migration.tgz", "canonical replacement");
    registerManifestUrl(serveManifest([{ type: "skill", name: "demo", ...replacement }]));

    const refused = await syncNow();

    assert.equal(statusOf(refused, "demo"), "failed");
    assert.match(refused.data[0]!.error!, /multiple installed records case-fold to the same key/);
    assert.equal(
	readFileSync(path.join(legacySkillsDir, "demo", "SKILL.md"), "utf8"),
	"managed contents",
    );
    assert.equal(
	readFileSync(path.join(legacySkillsDir, "Demo", "SKILL.md"), "utf8"),
	"managed contents",
    );
    assert.equal(existsSync(path.join(testHome, ".agents", "skills", "demo")), false);
    assert.equal(
	readdirSync(legacySkillsDir).some((entry) => entry.startsWith(".provision-removed-")),
	false,
    );
    const state = JSON.parse(readFileSync(path.join(stateDir, "provision.lock.json"), "utf8"));
    assert.deepEqual(Object.keys(state.installed).sort(), ["skill/Demo", "skill/demo"]);
  });

  test("reconciles a legacy first-install journal at its original root", async () => {
    const testHome = path.join(stateDir, "journal-home");
    const legacySkillsDir = path.join(testHome, ".claude", "skills");
    const name = "legacy-journal";
    const marker = "a".repeat(32);
    const rejectionRecoveryId = "b".repeat(32);
    const legacyTarget = path.join(legacySkillsDir, name);
    mkdirSync(legacyTarget, { recursive: true });
    writeFileSync(path.join(legacyTarget, "SKILL.md"), "legacy candidate");
    writeFileSync(firstInstallMarkerPath(legacyTarget, marker), marker);
    const targetStat = lstatSync(legacyTarget, { bigint: true });
    writeFileSync(path.join(stateDir, "provision.lock.json"), JSON.stringify({
      version: 1,
      approved: [],
      revoked: [],
      upgradeRecoveries: [rejectionRecoveryId],
      installed: {
	[`skill/${name}`]: {
	  sha256: "c".repeat(64),
	  files: ["SKILL.md"],
	  directories: [],
	  fileHashes: { "SKILL.md": sha(Buffer.from("legacy candidate")) },
	  installedAt: new Date().toISOString(),
	  uncommitted: true,
	  candidateIdentity: { dev: targetStat.dev.toString(), ino: targetStat.ino.toString() },
	  installMarker: marker,
	  rejectionRecoveryId,
	},
      },
    }));
    process.env.HOME = testHome;
    delete process.env.PROVISION_SKILLS_DIR;
    delete process.env.PROVISION_SKILL_LINK_DIRS;
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const replacement = serveSkill("/legacy-journal-v2.tgz", "canonical replacement");
    registerManifestUrl(serveManifest([{ type: "skill", name, ...replacement }]));

    const migrated = await syncNow();
    const canonical = path.join(testHome, ".agents", "skills", name);
    assert.equal(statusOf(migrated, name), "installed");
    assert.equal(readFileSync(path.join(canonical, "SKILL.md"), "utf8"), "canonical replacement");
    assert.equal(lstatSync(legacyTarget).isSymbolicLink(), true);
    const recovery = readdirSync(legacySkillsDir)
      .find((entry) => entry.startsWith(".provision-removed-"));
    assert.notEqual(recovery, undefined);
    assert.equal(
      readFileSync(path.join(legacySkillsDir, recovery!, "SKILL.md"), "utf8"),
      "legacy candidate",
    );
  });

  test("recovers an interrupted legacy-root isolation from its preclaim", async () => {
    const testHome = path.join(stateDir, "recovery-home");
    const legacySkillsDir = path.join(testHome, ".claude", "skills");
    process.env.HOME = testHome;
    process.env.PROVISION_SKILLS_DIR = legacySkillsDir;
    process.env.PROVISION_SKILL_LINK_DIRS = "";
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const skill = serveSkill("/legacy-recovery.tgz", "legacy managed skill");
    const manifestUrl = serveManifest([{ type: "skill", name: "legacy", ...skill }]);
    registerManifestUrl(manifestUrl);
    await syncNow();
    const statePath = path.join(stateDir, "provision.lock.json");
    const legacyState = JSON.parse(readFileSync(statePath, "utf8"));
    delete legacyState.installed["skill/legacy"].installRoot;
    writeFileSync(statePath, `${JSON.stringify(legacyState, null, 2)}\n`);

    delete process.env.PROVISION_SKILLS_DIR;
    delete process.env.PROVISION_SKILL_LINK_DIRS;
    initProvisioning({
      afterRemovalIsolation: () => {
	throw new Error("simulated legacy-root isolation interruption");
      },
    });
    registerManifestUrl(manifestUrl);
    const interrupted = await syncNow();
    assert.equal(statusOf(interrupted, "legacy"), "failed");
    assert.match(interrupted.data[0]!.error!, /isolation interruption/);
    const interruptedState = JSON.parse(readFileSync(statePath, "utf8"));
    const recoveryId = interruptedState.installed["skill/legacy"].removalRecoveryId;
    assert.match(recoveryId, /^[a-f0-9]{32}$/);
    assert.deepEqual(interruptedState.removalRecoveries, [recoveryId]);
    assert.equal(interruptedState.removalRecoveryRoots[recoveryId], legacySkillsDir);
    const recovery = path.join(legacySkillsDir, `.provision-removed-${recoveryId}`);
    assert.equal(readFileSync(path.join(recovery, "SKILL.md"), "utf8"), "legacy managed skill");

    initProvisioning();
    registerManifestUrl(manifestUrl);
    assert.equal(statusOf(await syncNow(), "legacy"), "installed");
    const recoveredState = JSON.parse(readFileSync(statePath, "utf8"));
    assert.deepEqual(recoveredState.removalRecoveries, [recoveryId]);
    assert.equal(recoveredState.removalRecoveryRoots[recoveryId], legacySkillsDir);
    assert.equal(recoveredState.installed["skill/legacy"].removalRecoveryId, undefined);
    assert.equal(
      recoveredState.installed["skill/legacy"].installRoot,
      path.join(testHome, ".agents", "skills"),
    );
    assert.equal(readFileSync(path.join(recovery, "SKILL.md"), "utf8"), "legacy managed skill");
  });

  test("refuses a canonical collision while migrating the previous Claude default", async () => {
    const testHome = path.join(stateDir, "home");
    const legacySkillsDir = path.join(testHome, ".claude", "skills");
    const canonicalSkillsDir = path.join(testHome, ".agents", "skills");
    process.env.HOME = testHome;
    process.env.PROVISION_SKILLS_DIR = legacySkillsDir;
    process.env.PROVISION_SKILL_LINK_DIRS = "";
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const skill = serveSkill("/legacy-collision.tgz", "same contents");
    registerManifestUrl(serveManifest([{ type: "skill", name: "legacy", ...skill }]));
    await syncNow();
    const statePath = path.join(stateDir, "provision.lock.json");
    const legacyState = JSON.parse(readFileSync(statePath, "utf8"));
    delete legacyState.installed["skill/legacy"].installRoot;
    writeFileSync(statePath, `${JSON.stringify(legacyState, null, 2)}\n`);

    const canonical = path.join(canonicalSkillsDir, "legacy");
    mkdirSync(canonical, { recursive: true });
    writeFileSync(path.join(canonical, "SKILL.md"), "same contents");
    process.env.PROVISION_SKILLS_DIR = "   ";
    delete process.env.PROVISION_SKILL_LINK_DIRS;
    initProvisioning();
    registerManifestUrl(`${baseUrl}/provision.json`);

    const refused = await syncNow();
    assert.equal(statusOf(refused, "legacy"), "failed");
    assert.match(refused.data[0]!.error!, /untracked canonical target/);
    assert.equal(readFileSync(path.join(canonical, "SKILL.md"), "utf8"), "same contents");
    assert.equal(
      readFileSync(path.join(legacySkillsDir, "legacy", "SKILL.md"), "utf8"),
      "same contents",
    );
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(state.installed["skill/legacy"].installRoot, legacySkillsDir);

    await deleteItem("skill", "legacy");
    assert.equal(readFileSync(path.join(canonical, "SKILL.md"), "utf8"), "same contents");
    assert.equal(existsSync(path.join(legacySkillsDir, "legacy")), false);
  });

  test("never infers legacy ownership from a matching Claude skill", async () => {
    const testHome = path.join(stateDir, "matching-claude-home");
    const claudeSkill = path.join(testHome, ".claude", "skills", "matching");
    process.env.HOME = testHome;
    delete process.env.PROVISION_SKILLS_DIR;
    delete process.env.PROVISION_SKILL_LINK_DIRS;
    process.env.PROVISION_AUTOAPPLY = "auto";
    mkdirSync(claudeSkill, { recursive: true });
    writeFileSync(path.join(claudeSkill, "SKILL.md"), "identical contents");
    initProvisioning();
    const skill = serveSkill("/matching-claude.tgz", "identical contents");
    registerManifestUrl(serveManifest([{ type: "skill", name: "matching", ...skill }]));

    const refused = await syncNow();
    assert.equal(statusOf(refused, "matching"), "failed");
    assert.match(refused.data[0]!.error!, /untracked content at skill link/);
    assert.equal(lstatSync(claudeSkill).isDirectory(), true);
    assert.equal(readFileSync(path.join(claudeSkill, "SKILL.md"), "utf8"), "identical contents");
  });

  test("refuses an untracked discovery-path collision", async () => {
    const linkDir = path.join(stateDir, "claude-skills");
    const collision = path.join(linkDir, "linked");
    mkdirSync(collision, { recursive: true });
    writeFileSync(path.join(collision, "SKILL.md"), "user owned");
    process.env.PROVISION_SKILL_LINK_DIRS = linkDir;
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const skill = serveSkill("/linked-collision.tgz", "managed");
    registerManifestUrl(serveManifest([{ type: "skill", name: "linked", ...skill }]));

    const status = await syncNow();
    assert.equal(statusOf(status, "linked"), "failed");
    assert.match(status.data[0]!.error!, /untracked content at skill link/);
    assert.equal(readFileSync(path.join(collision, "SKILL.md"), "utf8"), "user owned");
  });

  test("preserves a changed managed link and refuses skill removal", async () => {
    const linkDir = path.join(stateDir, "claude-skills");
    process.env.PROVISION_SKILL_LINK_DIRS = linkDir;
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const skill = serveSkill("/changed-link.tgz", "managed");
    registerManifestUrl(serveManifest([{ type: "skill", name: "linked", ...skill }]));
    await syncNow();

    const link = path.join(linkDir, "linked");
    const replacement = path.join(stateDir, "replacement");
    mkdirSync(replacement);
    unlinkSync(link);
    symlinkSync(replacement, link, process.platform === "win32" ? "junction" : "dir");
    responses.set("/provision.json", { schema: "agent-provisioning/v1", items: [] });

    const status = await syncNow();
    assert.equal(statusOf(status, "linked"), "failed");
    assert.match(status.data[0]!.error!, /changed skill link/);
    assert.equal(path.resolve(path.dirname(link), readlinkSync(link)), replacement);
    assert.equal(existsSync(path.join(skillsDir, "linked")), true);
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

  test("approval queued behind a same-URL refresh rechecks manifest membership", async () => {
    const target = serveSkill("/removed-before-approval.tgz", "target");
    const manifestUrl = serveManifest([
      { type: "skill", name: "removed-before-approval", ...target },
    ]);
    registerManifestUrl(manifestUrl);
    await syncNow();

    responses.set("/provision.json", { schema: "agent-provisioning/v1", items: [] });
    let release!: () => void;
    responseGates.set("/provision.json", new Promise<void>((resolve) => { release = resolve; }));
    const refresh = syncNow();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const approval = codeOf(() => approveItem("skill", "removed-before-approval"));
    release();

    await refresh;
    assert.equal(await approval, "unknown_item");
    const state = JSON.parse(readFileSync(path.join(stateDir, "provision.lock.json"), "utf8"));
    assert.equal(state.approved.includes("skill/removed-before-approval"), false);
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

  test("an intact target clears an interrupted removal preclaim on idempotent sync", async () => {
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const name = "intact-removal-preclaim";
    const skill = serveSkill("/intact-removal-preclaim.tgz", "managed");
    const manifestUrl = serveManifest([{ type: "skill", name, ...skill }]);
    registerManifestUrl(manifestUrl);
    await syncNow();

    initProvisioning({
      afterRemovalAudit: () => {
	throw new Error("simulated interruption before isolation");
      },
    });
    await assert.rejects(deleteItem("skill", name), /simulated interruption/);
    const lockfile = path.join(stateDir, "provision.lock.json");
    const interrupted = JSON.parse(readFileSync(lockfile, "utf8"));
    assert.match(interrupted.installed[`skill/${name}`].removalRecoveryId, /^[a-f0-9]{32}$/);

    initProvisioning();
    assert.equal(statusOf(getStatus(), name), undefined);
    registerManifestUrl(manifestUrl);
    assert.equal(statusOf(await syncNow(), name), "installed");
    const reconciled = JSON.parse(readFileSync(lockfile, "utf8"));
    assert.equal(reconciled.installed[`skill/${name}`].removalRecoveryId, undefined);
    assert.deepEqual(reconciled.removalRecoveries, []);

    initProvisioning();
    assert.equal(statusOf(getStatus(), name), "installed");
  });

  test("a legacy uppercase lockfile item migrates to lowercase in one sync", async () => {
    const legacyName = "Demo";
    const canonicalName = "demo";
    const legacyContents = "legacy contents";
    const legacyTarget = path.join(skillsDir, legacyName);
    mkdirSync(legacyTarget);
    writeFileSync(path.join(legacyTarget, "SKILL.md"), legacyContents);
    writeFileSync(path.join(stateDir, "provision.lock.json"), JSON.stringify({
      version: 1,
      approved: [],
      revoked: [],
      installed: {
	"skill/Demo": {
	  sha256: "a".repeat(64),
	  files: ["SKILL.md"],
	  directories: [],
	  fileHashes: { "SKILL.md": sha(Buffer.from(legacyContents)) },
	  installedAt: new Date().toISOString(),
	},
      },
    }));
    initProvisioning();
    const replacement = serveSkill("/lowercase-migration.tgz", "canonical contents");
    registerManifestUrl(serveManifest([{
      type: "skill",
      name: canonicalName,
      ...replacement,
    }]));

    const view = await syncNow();

    assert.equal(statusOf(view, canonicalName), "installed");
    assert.equal(readFileSync(path.join(skillsDir, canonicalName, "SKILL.md"), "utf8"), "canonical contents");
    const state = JSON.parse(readFileSync(path.join(stateDir, "provision.lock.json"), "utf8"));
    assert.equal(state.installed["skill/Demo"], undefined);
    assert.equal(state.installed["skill/demo"].sha256, replacement.sha256);
    assert.deepEqual(state.approved, ["skill/demo"]);
    const recovery = readdirSync(skillsDir)
      .find((entry) => entry.startsWith(".provision-removed-"));
    assert.notEqual(recovery, undefined);
    assert.equal(readFileSync(path.join(skillsDir, recovery!, "SKILL.md"), "utf8"), legacyContents);
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

  test("removal preserves an incomplete managed tree in recovery", async () => {
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const skill = serveSkill("/owned.tgz", "managed");
    registerManifestUrl(serveManifest([{ type: "skill", name: "owned", ...skill }]));
    await syncNow();
    writeFileSync(path.join(skillsDir, "owned", "user-notes.md"), "keep me");

    registerManifestUrl(serveManifest([]));
    const view = await syncNow();

    assert.equal(statusOf(view, "owned"), "removed");
    assert.equal(existsSync(path.join(skillsDir, "owned")), false);
    const recovery = readdirSync(skillsDir)
      .find((entry) => entry.startsWith(".provision-removed-"));
    assert.notEqual(recovery, undefined);
    assert.equal(readFileSync(path.join(skillsDir, recovery!, "SKILL.md"), "utf8"), "managed");
    assert.equal(readFileSync(path.join(skillsDir, recovery!, "user-notes.md"), "utf8"), "keep me");
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

  test("a git repository on another host requires an explicit allowlist", async () => {
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    registerManifestUrl(serveManifest([{
      type: "skill",
      name: "foreign-git",
      git: {
	url: "https://github.com/example/skill.git",
	rev: "a".repeat(40),
      },
    }]));

    const view = await syncNow();

    assert.equal(statusOf(view, "foreign-git"), "failed");
    assert.match(view.data[0]!.error ?? "", /differs from the manifest host/i);
    assert.equal(existsSync(path.join(skillsDir, "foreign-git")), false);
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

  test("a restarted first-install preclaim preserves a distinct target with a replayed marker", async () => {
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const name = "interrupted-first-install";
    const marker = "a".repeat(32);
    const recoveryId = "b".repeat(32);
    const candidate = path.join(skillsDir, ".provision-candidate-interrupted");
    mkdirSync(candidate);
    const candidateStat = lstatSync(candidate, { bigint: true });
    const target = path.join(skillsDir, name);
    mkdirSync(target);
    writeFileSync(path.join(target, "SKILL.md"), "same path, user-owned contents");
    writeFileSync(firstInstallMarkerPath(target, marker), marker);
    const skill = serveSkill("/interrupted-first-install.tgz", "registry contents");
    writeFileSync(path.join(stateDir, "provision.lock.json"), JSON.stringify({
      version: 1,
      approved: [],
      revoked: [],
      upgradeRecoveries: [recoveryId],
      installed: {
	[`skill/${name}`]: {
	  sha256: skill.sha256,
	  files: ["SKILL.md"],
	  fileHashes: { "SKILL.md": sha(Buffer.from("registry contents")) },
	  installedAt: new Date().toISOString(),
	  uncommitted: true,
	  candidateIdentity: { dev: candidateStat.dev.toString(), ino: candidateStat.ino.toString() },
	  installMarker: marker,
	  rejectionRecoveryId: recoveryId,
	},
      },
    }));
    registerManifestUrl(serveManifest([{
      type: "skill",
      name,
      ...skill,
    }]));

    const view = await syncNow();

    assert.equal(statusOf(view, name), "failed");
    assert.equal(
      readFileSync(path.join(target, "SKILL.md"), "utf8"),
      "same path, user-owned contents",
    );
    assert.equal(
      readFileSync(firstInstallMarkerPath(target, marker), "utf8"),
      marker,
    );
    assert.equal(existsSync(path.join(skillsDir, `.provision-rejected-${recoveryId}`)), false);
    const state = JSON.parse(readFileSync(path.join(stateDir, "provision.lock.json"), "utf8"));
    assert.equal(state.installed[`skill/${name}`], undefined);
  });

  test("restart reconciliation never commits or quarantines a target swapped after identity lookup", async () => {
    process.env.PROVISION_AUTOAPPLY = "auto";
    const marker = "c".repeat(32);
    const names = ["reconcile-swap-exact", "reconcile-swap-modified"];
    const originals = new Map<string, string>();
    initProvisioning({
      afterFirstInstallReconciliationIdentityCheck: (target) => {
	const name = path.basename(target);
	if (!names.includes(name)) return;
	const original = path.join(skillsDir, `.original-${name}`);
	renameSync(target, original);
	originals.set(name, original);
	mkdirSync(target);
	writeFileSync(
	  path.join(target, "SKILL.md"),
	  name.endsWith("exact") ? "registry contents" : "replacement contents",
	);
	writeFileSync(firstInstallMarkerPath(target, marker), marker);
      },
    });
    const installed: Record<string, unknown> = {};
    const items = names.map((name, index) => {
      const target = path.join(skillsDir, name);
      mkdirSync(target);
      writeFileSync(path.join(target, "SKILL.md"), "registry contents");
      writeFileSync(firstInstallMarkerPath(target, marker), marker);
      const targetStat = lstatSync(target, { bigint: true });
      const skill = serveSkill(`/${name}.tgz`, "registry contents");
      installed[`skill/${name}`] = {
	sha256: skill.sha256,
	files: ["SKILL.md"],
	directories: [],
	fileHashes: { "SKILL.md": sha(Buffer.from("registry contents")) },
	installedAt: new Date().toISOString(),
	uncommitted: true,
	candidateIdentity: { dev: targetStat.dev.toString(), ino: targetStat.ino.toString() },
	installMarker: marker,
	rejectionRecoveryId: String(index + 1).repeat(32),
      };
      return { type: "skill", name, ...skill };
    });
    writeFileSync(path.join(stateDir, "provision.lock.json"), JSON.stringify({
      version: 1,
      approved: [],
      revoked: [],
      upgradeRecoveries: ["1".repeat(32), "2".repeat(32)],
      installed,
    }));
    registerManifestUrl(serveManifest(items));

    const view = await syncNow();

    for (const name of names) {
      assert.equal(statusOf(view, name), "failed");
      assert.equal(existsSync(path.join(skillsDir, name)), true, "replacement stays canonical");
      assert.equal(existsSync(originals.get(name)!), true, "original candidate remains preserved");
    }
    assert.equal(
      readFileSync(path.join(skillsDir, "reconcile-swap-exact", "SKILL.md"), "utf8"),
      "registry contents",
    );
    assert.equal(
      readFileSync(path.join(skillsDir, "reconcile-swap-modified", "SKILL.md"), "utf8"),
      "replacement contents",
    );
    assert.equal(existsSync(path.join(skillsDir, `.provision-rejected-${"1".repeat(32)}`)), false);
    assert.equal(existsSync(path.join(skillsDir, `.provision-rejected-${"2".repeat(32)}`)), false);
    const state = JSON.parse(readFileSync(path.join(stateDir, "provision.lock.json"), "utf8"));
    assert.equal(state.installed["skill/reconcile-swap-exact"], undefined);
    assert.equal(state.installed["skill/reconcile-swap-modified"], undefined);
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
    const targetStat = lstatSync(target, { bigint: true });
    writeFileSync(path.join(stateDir, "provision.lock.json"), JSON.stringify({
      version: 1,
      approved: [],
      revoked: [],
      installed: {
	[`skill/${name}`]: {
	  sha256: "e".repeat(64),
	  files: ["SKILL.md"],
	  directories: [],
	  fileHashes: { "SKILL.md": sha(Buffer.from("installed contents")) },
	  installedAt: new Date().toISOString(),
	  uncommitted: true,
	  candidateIdentity: { dev: targetStat.dev.toString(), ino: targetStat.ino.toString() },
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
    const target = path.join(skillsDir, "changed-after-exposure");
    assert.equal(existsSync(target), false);
    const recoveries = readdirSync(skillsDir)
      .filter((entry) => entry.startsWith(".provision-rejected-"));
    assert.equal(recoveries.length, 1);
    assert.equal(
      readFileSync(path.join(skillsDir, recoveries[0]!, "SKILL.md"), "utf8"),
      "changed after exposure",
    );
    const state = JSON.parse(readFileSync(path.join(stateDir, "provision.lock.json"), "utf8"));
    assert.equal(state.installed["skill/changed-after-exposure"], undefined);
    assert.deepEqual(
      state.upgradeRecoveries,
      [recoveries[0]!.slice(".provision-rejected-".length)],
    );
  });

  test("restart isolates added content in an exposed first-install journal before repair", async () => {
    process.env.PROVISION_AUTOAPPLY = "auto";
    const name = "restart-changed-exposure";
    const key = `skill/${name}`;
    const marker = "a".repeat(32);
    const recoveryId = "b".repeat(32);
    const target = path.join(skillsDir, name);
    mkdirSync(target);
    writeFileSync(path.join(target, "SKILL.md"), "registry contents");
    writeFileSync(path.join(target, "UNTRACKED.md"), "added after exposure");
    writeFileSync(firstInstallMarkerPath(target, marker), marker);
    const targetStat = lstatSync(target, { bigint: true });
    const skill = serveSkill("/restart-changed-exposure.tgz", "registry contents");
    writeFileSync(path.join(stateDir, "provision.lock.json"), JSON.stringify({
      version: 1,
      approved: [key],
      revoked: [],
      upgradeRecoveries: [recoveryId],
      installed: {
	[key]: {
	  sha256: skill.sha256,
	  files: ["SKILL.md"],
	  directories: [],
	  fileHashes: { "SKILL.md": sha(Buffer.from("registry contents")) },
	  installedAt: new Date().toISOString(),
	  uncommitted: true,
	  candidateIdentity: { dev: targetStat.dev.toString(), ino: targetStat.ino.toString() },
	  installMarker: marker,
	  rejectionRecoveryId: recoveryId,
	},
      },
    }));
    registerManifestUrl(serveManifest([{ type: "skill", name, ...skill }]));

    assert.equal(statusOf(await syncNow(), name), "installed");
    assert.equal(readFileSync(path.join(target, "SKILL.md"), "utf8"), "registry contents");
    const recovery = path.join(skillsDir, `.provision-rejected-${recoveryId}`);
    assert.equal(readFileSync(path.join(recovery, "SKILL.md"), "utf8"), "registry contents");
    assert.equal(readFileSync(path.join(recovery, "UNTRACKED.md"), "utf8"), "added after exposure");
    const state = JSON.parse(readFileSync(path.join(stateDir, "provision.lock.json"), "utf8"));
    assert.deepEqual(state.upgradeRecoveries, [recoveryId]);
    assert.equal(state.installed[key].uncommitted, undefined);
    assert.equal(state.installed[key].rejectionRecoveryId, undefined);
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

  test("DELETE preserves an exact-path target recreated after interrupted removal", async () => {
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const name = "remove-recreated-target";
    const skill = serveSkill("/remove-recreated-target.tgz", "managed");
    registerManifestUrl(serveManifest([{ type: "skill", name, ...skill }]));
    await syncNow();

    const target = path.join(skillsDir, name);
    const recoveryId = "a".repeat(32);
    const priorRecovery = path.join(skillsDir, `.provision-removed-${recoveryId}`);
    renameSync(target, priorRecovery);
    mkdirSync(target);
    writeFileSync(path.join(target, "SKILL.md"), "user replacement");
    const lockfile = path.join(stateDir, "provision.lock.json");
    const stateBeforeRestart = JSON.parse(readFileSync(lockfile, "utf8"));
    stateBeforeRestart.removalRecoveries = [recoveryId];
    stateBeforeRestart.installed[`skill/${name}`].removalRecoveryId = recoveryId;
    writeFileSync(lockfile, JSON.stringify(stateBeforeRestart));
    initProvisioning();

    assert.deepEqual(await deleteItem("skill", name), { removed: true });
    assert.equal(readFileSync(path.join(target, "SKILL.md"), "utf8"), "user replacement");
    assert.equal(readFileSync(path.join(priorRecovery, "SKILL.md"), "utf8"), "managed");
    const state = JSON.parse(readFileSync(lockfile, "utf8"));
    assert.equal(state.installed[`skill/${name}`], undefined);
    assert.deepEqual(state.removalRecoveries, [recoveryId]);
  });

  test("upgrade preserves an exact-path target recreated after interrupted removal", async () => {
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const name = "upgrade-recreated-target";
    const first = serveSkill("/upgrade-recreated-target-v1.tgz", "managed");
    registerManifestUrl(serveManifest([{ type: "skill", name, ...first }]));
    await syncNow();

    const target = path.join(skillsDir, name);
    const recoveryId = "b".repeat(32);
    const priorRecovery = path.join(skillsDir, `.provision-removed-${recoveryId}`);
    renameSync(target, priorRecovery);
    mkdirSync(target);
    writeFileSync(path.join(target, "SKILL.md"), "user replacement");
    const lockfile = path.join(stateDir, "provision.lock.json");
    const stateBeforeRestart = JSON.parse(readFileSync(lockfile, "utf8"));
    stateBeforeRestart.removalRecoveries = [recoveryId];
    stateBeforeRestart.installed[`skill/${name}`].removalRecoveryId = recoveryId;
    writeFileSync(lockfile, JSON.stringify(stateBeforeRestart));
    initProvisioning();

    const second = serveSkill("/upgrade-recreated-target-v2.tgz", "registry upgrade");
    registerManifestUrl(serveManifest([{ type: "skill", name, ...second }]));
    const view = await syncNow();

    assert.equal(statusOf(view, name), "failed");
    assert.match(view.data.find((item) => item.name === name)?.error ?? "", /refusing to replace/i);
    assert.equal(readFileSync(path.join(target, "SKILL.md"), "utf8"), "user replacement");
    assert.equal(readFileSync(path.join(priorRecovery, "SKILL.md"), "utf8"), "managed");
    const state = JSON.parse(readFileSync(lockfile, "utf8"));
    assert.equal(state.installed[`skill/${name}`].sha256, first.sha256);
    assert.deepEqual(state.removalRecoveries, [recoveryId]);
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

  test("DELETE preserves a recovery sibling swapped in after isolation", async () => {
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const name = "delete-isolation-swap";
    const skill = serveSkill("/delete-isolation-swap.tgz", "managed");
    registerManifestUrl(serveManifest([{ type: "skill", name, ...skill }]));
    await syncNow();
    let recovery = "";
    let displaced = "";
    initProvisioning({
      afterRemovalIsolation: (isolated) => {
	recovery = isolated;
	displaced = `${isolated}-displaced`;
	renameSync(isolated, displaced);
	mkdirSync(isolated);
      },
    });

    assert.deepEqual(await deleteItem("skill", name), { removed: true });

    assert.deepEqual(readdirSync(recovery), []);
    assert.equal(readFileSync(path.join(displaced, "SKILL.md"), "utf8"), "managed");
  });

  test("manifest removal preserves a recovery sibling swapped in after isolation", async () => {
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const name = "manifest-isolation-swap";
    const skill = serveSkill("/manifest-isolation-swap.tgz", "managed");
    registerManifestUrl(serveManifest([{ type: "skill", name, ...skill }]));
    await syncNow();
    let recovery = "";
    let displaced = "";
    initProvisioning({
      afterRemovalIsolation: (isolated) => {
	recovery = isolated;
	displaced = `${isolated}-displaced`;
	renameSync(isolated, displaced);
	mkdirSync(isolated);
      },
    });
    registerManifestUrl(serveManifest([]));

    const view = await syncNow();

    assert.equal(statusOf(view, name), "removed");
    assert.deepEqual(readdirSync(recovery), []);
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

  test("a lowercase DELETE removes a legacy uppercase lockfile item", async () => {
    const contents = "legacy delete contents";
    const target = path.join(skillsDir, "Demo");
    mkdirSync(target);
    writeFileSync(path.join(target, "SKILL.md"), contents);
    writeFileSync(path.join(stateDir, "provision.lock.json"), JSON.stringify({
      version: 1,
      approved: ["skill/Demo"],
      revoked: [],
      installed: {
	"skill/Demo": {
	  sha256: "a".repeat(64),
	  files: ["SKILL.md"],
	  directories: [],
	  fileHashes: { "SKILL.md": sha(Buffer.from(contents)) },
	  installedAt: new Date().toISOString(),
	},
      },
    }));
    initProvisioning();

    assert.deepEqual(await deleteItem("skill", "demo"), { removed: true });

    const state = JSON.parse(readFileSync(path.join(stateDir, "provision.lock.json"), "utf8"));
    assert.deepEqual(state.approved, []);
    assert.deepEqual(state.revoked, ["skill/demo"]);
    assert.deepEqual(state.installed, {});
    const recovery = readdirSync(skillsDir)
      .find((entry) => entry.startsWith(".provision-removed-"));
    assert.notEqual(recovery, undefined);
    assert.equal(readFileSync(path.join(skillsDir, recovery!, "SKILL.md"), "utf8"), contents);
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
    let firstExposed = false;
    initProvisioning({
      afterFirstInstallMove: (target) => {
	if (path.basename(target) === "first") firstExposed = true;
      },
    });
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
    assert.equal(firstExposed, false);
    assert.equal(existsSync(path.join(skillsDir, "first")), false);
    assert.equal(existsSync(path.join(skillsDir, "second", "SKILL.md")), true);
  });

  test("a superseded manifest fetch performs no filesystem mutation", async () => {
    process.env.PROVISION_AUTOAPPLY = "auto";
    let firstExposed = false;
    initProvisioning({
      afterFirstInstallMove: (target) => {
	if (path.basename(target) === "first") firstExposed = true;
      },
    });
    const first = serveSkill("/first.tgz", "first");
    const second = serveSkill("/second.tgz", "second");
    responses.set("/first.json", { schema: "agent-provisioning/v1", items: [{ type: "skill", name: "first", ...first }] });
    responses.set("/second.json", { schema: "agent-provisioning/v1", items: [{ type: "skill", name: "second", ...second }] });
    let release!: () => void;
    responseGates.set("/first.json", new Promise<void>((resolve) => { release = resolve; }));

    registerManifestUrl(`${baseUrl}/first.json`);
    const firstSync = syncNow();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const switched = handleAuthorizedSession(`${baseUrl}/second.json`);
    release();
    await Promise.all([firstSync, switched]);

    assert.equal(firstExposed, false);
    assert.equal(existsSync(path.join(skillsDir, "first")), false);
    assert.equal(existsSync(path.join(skillsDir, "second", "SKILL.md")), true);
  });

  test("a failed manifest response is cancelled before the fetch error is reported", async () => {
    const realFetch = globalThis.fetch;
    let cancelled = false;
    globalThis.fetch = async () => new Response(new ReadableStream({
      cancel: () => { cancelled = true; },
    }), { status: 503 });
    try {
      registerManifestUrl("https://example.invalid/provision.json");
      assert.equal(await codeOf(syncNow), "manifest_fetch_failed");
      assert.equal(cancelled, true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("persists and removes a root-level __proto__ artifact after reload", async () => {
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const archive = skillArchive("managed", "__proto__");
    responses.set("/proto.tgz", archive);
    registerManifestUrl(serveManifest([{
      type: "skill",
      name: "proto-name",
      url: `${baseUrl}/proto.tgz`,
      sha256: sha(archive),
    }]));
    await syncNow();

    const persisted = JSON.parse(
      readFileSync(path.join(stateDir, "provision.lock.json"), "utf8"),
    ) as { installed: Record<string, { fileHashes: Record<string, string> }> };
    assert.equal(
      Object.hasOwn(persisted.installed["skill/proto-name"]!.fileHashes, "__proto__"),
      true,
    );

    registerManifestUrl(serveManifest([]));
    await syncNow();
    assert.equal(existsSync(path.join(skillsDir, "proto-name")), false);
    const recovery = readdirSync(skillsDir)
      .find((entry) => entry.startsWith(".provision-removed-"));
    assert.notEqual(recovery, undefined);
    assert.equal(readFileSync(path.join(skillsDir, recovery!, "__proto__"), "utf8"), "managed");
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

  test("an auth-delivered manifest registration survives restart and resumes drift repair", async () => {
    process.env.PROVISION_AUTOAPPLY = "auto";
    process.env.PROVISION_REFETCH_MS = "10";
    initProvisioning();
    const skill = serveSkill("/persistent.tgz", "persistent");
    const manifestPath = "/persistent.json?token=secret";
    const manifestUrl = `${baseUrl}${manifestPath}`;
    responses.set(manifestPath, {
      schema: "agent-provisioning/v1",
      items: [{ type: "skill", name: "persistent", ...skill }],
    });

    await handleAuthorizedSession(manifestUrl);
    assert.equal(existsSync(path.join(skillsDir, "persistent", "SKILL.md")), true);
    assert.equal(statSync(registeredManifestFilePath()).mode & 0o777, 0o600);
    assert.equal(
      readFileSync(registeredManifestFilePath(), "utf8").includes("token=secret"),
      false,
      "a same-uid CLI must not recover the signed URL from provisioning state",
    );

    await shutdownProvisioning();
    responses.set(manifestPath, { schema: "agent-provisioning/v1", items: [] });
    initProvisioning();
    await syncNow();

    assert.equal(getStatus().manifest_url, manifestUrl);
    assert.equal(existsSync(path.join(skillsDir, "persistent")), false);

    responses.set(manifestPath, {
      schema: "agent-provisioning/v1",
      items: [{ type: "skill", name: "persistent", ...skill }],
    });
    const deadline = Date.now() + 1_000;
    while (!existsSync(path.join(skillsDir, "persistent", "SKILL.md")) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(existsSync(path.join(skillsDir, "persistent", "SKILL.md")), true);
  });

  test("a replacement manifest invalidates approvals from the previous generation", async () => {
    const skill = serveSkill("/stale-approval.tgz", "stale");
    responses.set("/first.json", {
      schema: "agent-provisioning/v1",
      items: [{ type: "skill", name: "stale", ...skill }],
    });
    responses.set("/second.json", { schema: "agent-provisioning/v1", items: [] });
    registerManifestUrl(`${baseUrl}/first.json`);
    await syncNow();

    let release!: () => void;
    responseGates.set("/second.json", new Promise<void>((resolve) => { release = resolve; }));
    registerManifestUrl(`${baseUrl}/second.json`);
    const switching = syncNow();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(await codeOf(() => approveItem("skill", "stale")), "unknown_item");
    release();
    await switching;
    const state = JSON.parse(readFileSync(path.join(stateDir, "provision.lock.json"), "utf8"));
    assert.equal(state.approved.includes("skill/stale"), false);
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

  test("startup status restores git source metadata from the lockfile", () => {
    const key = "skill/startup-git";
    writeFileSync(path.join(stateDir, "provision.lock.json"), JSON.stringify({
      version: 1,
      approved: [key],
      revoked: [],
      installed: {
	[key]: {
	  sha256: "f".repeat(64),
	  source: {
	    type: "git",
	    ref: "main",
	    rev: "a".repeat(40),
	    path: "skills/demo",
	  },
	  files: ["SKILL.md"],
	  directories: [],
	  fileHashes: { "SKILL.md": sha(Buffer.from("git skill")) },
	  installedAt: new Date().toISOString(),
	},
      },
    }));

    initProvisioning();

    assert.deepEqual(getStatus().data.find((item) => item.name === "startup-git"), {
      type: "skill",
      name: "startup-git",
      status: "installed",
      git: { rev: "main", resolved_rev: "a".repeat(40), path: "skills/demo" },
    });
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

  test("startup status omits an interrupted removal", () => {
    const key = "skill/startup-removal";
    const removalRecoveryId = "c".repeat(32);
    writeFileSync(path.join(stateDir, "provision.lock.json"), JSON.stringify({
      version: 1,
      approved: [key],
      revoked: [],
      removalRecoveries: [removalRecoveryId],
      installed: {
	[key]: {
	  sha256: "a".repeat(64),
	  files: ["SKILL.md"],
	  directories: [],
	  fileHashes: { "SKILL.md": sha(Buffer.from("isolated")) },
	  installedAt: new Date().toISOString(),
	  removalRecoveryId,
	},
      },
    }));
    mkdirSync(path.join(skillsDir, `.provision-removed-${removalRecoveryId}`));
    writeFileSync(
      path.join(skillsDir, `.provision-removed-${removalRecoveryId}`, "SKILL.md"),
      "isolated",
    );

    initProvisioning();

    assert.equal(statusOf(getStatus(), "startup-removal"), undefined);
    const state = JSON.parse(readFileSync(path.join(stateDir, "provision.lock.json"), "utf8"));
    assert.equal(state.installed[key].removalRecoveryId, removalRecoveryId);
  });

  test("installs and rotates an approved config item without rewriting unchanged content", async () => {
    const first = configItem("tok-1");
    registerManifestUrl(serveManifest([first.item]));
    const pending = await syncNow();
    assert.equal(pending.data[0]!.status, "pending_approval");
    assert.equal(existsSync(path.join(configDir, "collavre")), false);

    const installed = await approveItem("config", "collavre");
    const file = path.join(configDir, "collavre", "config.json");
    assert.equal(installed.data[0]!.status, "installed");
    assert.equal(readFileSync(file, "utf8"), first.body);
    assert.equal(lstatSync(file).mode & 0o777, 0o600);
    assert.equal(lstatSync(path.dirname(file)).mode & 0o777, 0o700);

    const before = statSync(file).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 10));
    await syncNow();
    assert.equal(statSync(file).mtimeMs, before);

    const rotated = configItem("tok-2");
    responses.set("/provision.json", { schema: "agent-provisioning/v1", items: [rotated.item] });
    const upgraded = await syncNow();
    assert.equal(upgraded.data[0]!.status, "installed");
    assert.equal(readFileSync(file, "utf8"), rotated.body);
  });

  test("repairs loosened config permissions without another approval", async () => {
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const config = configItem("tok-1");
    registerManifestUrl(serveManifest([config.item]));
    await syncNow();
    const target = path.join(configDir, "collavre");
    const file = path.join(target, "config.json");
    chmodSync(target, 0o755);
    chmodSync(file, 0o644);

    const repaired = await syncNow();
    assert.equal(repaired.data[0]!.status, "installed");
    assert.equal(lstatSync(target).mode & 0o777, 0o700);
    assert.equal(lstatSync(file).mode & 0o777, 0o600);
  });

  test("restart erases only the recorded pre-publication candidate before retrying", async () => {
    const config = configItem("tok-1");
    const key = "config/collavre";
    const target = path.join(configDir, "collavre");
    mkdirSync(target);
    const candidateName = `.provision-config-candidate-${"c".repeat(32)}`;
    const untrackedName = `.provision-config-candidate-${"d".repeat(32)}`;
    const candidatePath = path.join(target, candidateName);
    writeFileSync(candidatePath, config.body, { mode: 0o600 });
    writeFileSync(path.join(target, untrackedName), "user-owned", { mode: 0o600 });
    const targetStat = lstatSync(target, { bigint: true });
    const candidateStat = lstatSync(candidatePath, { bigint: true });
    writeFileSync(path.join(stateDir, "provision.lock.json"), JSON.stringify({
      version: 1,
      approved: [key],
      revoked: [],
      installed: {
	[key]: {
	  sha256: config.item.sha256,
	  files: ["config.json"],
	  directories: [],
	  fileHashes: { "config.json": sha(Buffer.from(config.body)) },
	  installedAt: new Date().toISOString(),
	  uncommitted: true,
	  candidateIdentity: {
	    dev: targetStat.dev.toString(),
	    ino: targetStat.ino.toString(),
	  },
	  configCandidate: {
	    name: candidateName,
	    dev: candidateStat.dev.toString(),
	    ino: candidateStat.ino.toString(),
	  },
	},
      },
    }));
    registerManifestUrl(serveManifest([config.item]));

    const status = await syncNow();
    assert.equal(status.data[0]!.status, "installed");
    assert.equal(readFileSync(candidatePath).length, 0);
    assert.equal(readFileSync(path.join(target, untrackedName), "utf8"), "user-owned");
    assert.equal(readFileSync(path.join(target, "config.json"), "utf8"), config.body);
  });

  test("restart removes Windows hard-link candidates before committing ownership", {
    skip: process.platform !== "win32",
  }, async () => {
    const first = configItem("tok-1", "/config-v1.tar.gz");
    const key = "config/collavre";
    const target = path.join(configDir, "collavre");
    mkdirSync(target);
    const firstCandidateName = `.provision-config-candidate-${"a".repeat(32)}`;
    const firstCandidatePath = path.join(target, firstCandidateName);
    const publishedPath = path.join(target, "config.json");
    writeFileSync(firstCandidatePath, first.body, { mode: 0o600 });
    linkSync(firstCandidatePath, publishedPath);
    const targetStat = lstatSync(target, { bigint: true });
    const firstCandidateStat = lstatSync(firstCandidatePath, { bigint: true });
    const stateFile = path.join(stateDir, "provision.lock.json");
    writeFileSync(stateFile, JSON.stringify({
      version: 1,
      approved: [key],
      revoked: [],
      installed: {
	[key]: {
	  sha256: first.item.sha256,
	  files: ["config.json"],
	  directories: [],
	  fileHashes: { "config.json": sha(Buffer.from(first.body)) },
	  installedAt: new Date().toISOString(),
	  uncommitted: true,
	  candidateIdentity: {
	    dev: targetStat.dev.toString(),
	    ino: targetStat.ino.toString(),
	  },
	  configCandidate: {
	    name: firstCandidateName,
	    dev: firstCandidateStat.dev.toString(),
	    ino: firstCandidateStat.ino.toString(),
	  },
	},
      },
    }));
    registerManifestUrl(serveManifest([first.item]));

    const firstStatus = await syncNow();
    assert.equal(firstStatus.data[0]!.status, "installed");
    assert.equal(existsSync(firstCandidatePath), false);
    assert.equal(readFileSync(publishedPath, "utf8"), first.body);
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(state.installed[key].uncommitted, undefined);
    assert.equal(state.installed[key].configCandidate, undefined);

    const second = configItem("tok-2", "/config-v2.tar.gz");
    const secondCandidateName = `.provision-config-candidate-${"b".repeat(32)}`;
    const secondCandidatePath = path.join(target, secondCandidateName);
    writeFileSync(secondCandidatePath, second.body, { mode: 0o600 });
    rmSync(publishedPath);
    linkSync(secondCandidatePath, publishedPath);
    const secondCandidateStat = lstatSync(secondCandidatePath, { bigint: true });
    state.installed[key].pending = {
      sha256: second.item.sha256,
      files: ["config.json"],
      directories: [],
      fileHashes: { "config.json": sha(Buffer.from(second.body)) },
      installedAt: new Date().toISOString(),
    };
    state.installed[key].candidateIdentity = {
      dev: targetStat.dev.toString(),
      ino: targetStat.ino.toString(),
    };
    state.installed[key].configCandidate = {
      name: secondCandidateName,
      dev: secondCandidateStat.dev.toString(),
      ino: secondCandidateStat.ino.toString(),
    };
    writeFileSync(stateFile, JSON.stringify(state));
    registerManifestUrl(serveManifest([second.item]));

    const secondStatus = await syncNow();
    assert.equal(secondStatus.data[0]!.status, "installed");
    assert.equal(existsSync(secondCandidatePath), false);
    assert.equal(readFileSync(publishedPath, "utf8"), second.body);
    const upgradedState = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(upgradedState.installed[key].sha256, second.item.sha256);
    assert.equal(upgradedState.installed[key].pending, undefined);
    assert.equal(upgradedState.installed[key].configCandidate, undefined);
  });

  test("an unresolved config upgrade journal blocks replacement", async () => {
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const first = configItem("tok-1");
    registerManifestUrl(serveManifest([first.item]));
    await syncNow();
    const key = "config/collavre";
    const target = path.join(configDir, "collavre");
    const displaced = path.join(configDir, "displaced");
    const targetStat = lstatSync(target, { bigint: true });
    const candidateName = `.provision-config-candidate-${"f".repeat(32)}`;
    const candidatePath = path.join(target, candidateName);
    writeFileSync(candidatePath, "candidate", { mode: 0o600 });
    const candidateStat = lstatSync(candidatePath, { bigint: true });
    const second = configItem("tok-2");
    const stateFile = path.join(stateDir, "provision.lock.json");
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    state.installed[key].pending = {
      sha256: second.item.sha256,
      files: ["config.json"],
      directories: [],
      fileHashes: { "config.json": sha(Buffer.from(second.body)) },
      installedAt: new Date().toISOString(),
    };
    state.installed[key].candidateIdentity = {
      dev: targetStat.dev.toString(),
      ino: targetStat.ino.toString(),
    };
    state.installed[key].configCandidate = {
      name: candidateName,
      dev: candidateStat.dev.toString(),
      ino: candidateStat.ino.toString(),
    };
    writeFileSync(stateFile, JSON.stringify(state));
    renameSync(target, displaced);
    mkdirSync(target, { mode: 0o700 });
    writeFileSync(path.join(target, "config.json"), first.body, { mode: 0o600 });
    responses.set("/provision.json", { schema: "agent-provisioning/v1", items: [second.item] });

    const status = await syncNow();
    assert.equal(status.data[0]!.status, "failed");
    assert.match(status.data[0]!.error!, /interrupted upgrade journal/);
    assert.equal(readFileSync(path.join(target, "config.json"), "utf8"), first.body);
    assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).installed[key].pending.sha256,
      second.item.sha256);
    await assert.rejects(
      () => deleteItem("config", "collavre"),
      (err: ProvisionError) => err.code === "untracked_content" && /journal/.test(err.message),
    );
    assert.equal(readFileSync(path.join(target, "config.json"), "utf8"), first.body);
  });

  test("restart never adopts a same-content config with the wrong inode", async () => {
    const config = configItem("tok-1");
    const key = "config/collavre";
    const target = path.join(configDir, "collavre");
    mkdirSync(target, { mode: 0o700 });
    const original = path.join(target, "original-candidate");
    writeFileSync(original, config.body, { mode: 0o600 });
    const targetStat = lstatSync(target, { bigint: true });
    const originalStat = lstatSync(original, { bigint: true });
    const replacement = path.join(target, "config.json");
    writeFileSync(replacement, config.body, { mode: 0o600 });
    writeFileSync(path.join(stateDir, "provision.lock.json"), JSON.stringify({
      version: 1,
      approved: [key],
      revoked: [],
      installed: {
	[key]: {
	  sha256: config.item.sha256,
	  files: ["config.json"],
	  directories: [],
	  fileHashes: { "config.json": sha(Buffer.from(config.body)) },
	  installedAt: new Date().toISOString(),
	  uncommitted: true,
	  candidateIdentity: {
	    dev: targetStat.dev.toString(),
	    ino: targetStat.ino.toString(),
	  },
	  configCandidate: {
	    name: `.provision-config-candidate-${"e".repeat(32)}`,
	    dev: originalStat.dev.toString(),
	    ino: originalStat.ino.toString(),
	  },
	},
      },
    }));
    registerManifestUrl(serveManifest([config.item]));

    const status = await syncNow();
    assert.equal(status.data[0]!.status, "failed");
    assert.match(status.data[0]!.error!, /ownership journal/);
    assert.equal(readFileSync(replacement, "utf8"), config.body);
    const state = JSON.parse(readFileSync(path.join(stateDir, "provision.lock.json"), "utf8"));
    assert.equal(state.installed[key].uncommitted, true);
  });

  test("skill and config items with the same name install side by side", async () => {
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const config = configItem("tok-1");
    const skill = serveSkill("/skill.tar.gz", "# collavre skill");
    registerManifestUrl(serveManifest([
      { type: "skill", name: "collavre", ...skill },
      config.item,
    ]));
    const status = await syncNow();
    assert.deepEqual(status.data.map((item) => item.status), ["installed", "installed"]);
    assert.equal(existsSync(path.join(skillsDir, "collavre", "SKILL.md")), true);
    assert.equal(existsSync(path.join(configDir, "collavre", "config.json")), true);
  });

  test("removing config desired state preserves user files", async () => {
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const config = configItem("tok-1");
    registerManifestUrl(serveManifest([config.item]));
    await syncNow();
    const target = path.join(configDir, "collavre");
    writeFileSync(path.join(target, "notes.txt"), "mine");
    responses.set("/provision.json", { schema: "agent-provisioning/v1", items: [] });
    const status = await syncNow();
    assert.equal(status.data[0]!.status, "removed");
    assert.equal(existsSync(path.join(target, "config.json")), false);
    assert.equal(readFileSync(path.join(target, "notes.txt"), "utf8"), "mine");
  });

  test("persists a reconciled config upgrade before removing its published file", async () => {
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const first = configItem("tok-1", "/config-v1.tar.gz");
    registerManifestUrl(serveManifest([first.item]));
    await syncNow();

    const second = configItem("tok-2", "/config-v2.tar.gz");
    const key = "config/collavre";
    const target = path.join(configDir, "collavre");
    const published = path.join(target, "config.json");
    const candidateName = `.provision-config-candidate-${"a".repeat(32)}`;
    const candidate = path.join(target, candidateName);
    writeFileSync(candidate, second.body, { mode: 0o600 });
    const targetStat = lstatSync(target, { bigint: true });
    const candidateStat = lstatSync(candidate, { bigint: true });
    rmSync(published);
    renameSync(candidate, published);

    const stateFile = path.join(stateDir, "provision.lock.json");
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    state.installed[key].pending = {
      sha256: second.item.sha256,
      files: ["config.json"],
      directories: [],
      fileHashes: { "config.json": sha(Buffer.from(second.body)) },
      installedAt: new Date().toISOString(),
    };
    state.installed[key].candidateIdentity = {
      dev: targetStat.dev.toString(),
      ino: targetStat.ino.toString(),
    };
    state.installed[key].configCandidate = {
      name: candidateName,
      dev: candidateStat.dev.toString(),
      ino: candidateStat.ino.toString(),
    };
    writeFileSync(stateFile, JSON.stringify(state));
    responses.set("/provision.json", { schema: "agent-provisioning/v1", items: [] });

    initProvisioning({
      afterConfigRemoval: () => {
	const persisted = JSON.parse(readFileSync(stateFile, "utf8"));
	assert.equal(persisted.installed[key].sha256, second.item.sha256);
	assert.equal(persisted.installed[key].pending, undefined);
	assert.equal(persisted.installed[key].configCandidate, undefined);
	throw new Error("simulated crash after config unlink");
      },
    });
    registerManifestUrl(`${baseUrl}/provision.json`);
    const interrupted = await syncNow();
    assert.equal(interrupted.data[0]!.status, "failed");
    assert.match(interrupted.data[0]!.error!, /simulated crash/);
    assert.equal(existsSync(published), false);

    initProvisioning();
    registerManifestUrl(`${baseUrl}/provision.json`);
    const recovered = await syncNow();
    assert.equal(recovered.data[0]!.status, "removed");
    assert.equal(key in JSON.parse(readFileSync(stateFile, "utf8")).installed, false);
  });

  test("DELETE revokes config and the next sync returns it to pending approval", async () => {
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const config = configItem("tok-1");
    registerManifestUrl(serveManifest([config.item]));
    await syncNow();
    assert.deepEqual(await deleteItem("config", "collavre"), { removed: true });
    assert.deepEqual(getStatus().data, []);
    assert.deepEqual(readdirSync(path.join(configDir, "collavre")), []);
    const status = await syncNow();
    assert.equal(status.data[0]!.status, "pending_approval");
  });

  test("adopt approval takes over an untracked config file and consumes its grant", async () => {
    const target = path.join(configDir, "collavre");
    mkdirSync(target);
    writeFileSync(path.join(target, "config.json"), "hand-written");
    const config = configItem("tok-1");
    registerManifestUrl(serveManifest([config.item]));
    await syncNow();

    const status = await approveItem("config", "collavre", { adopt: true });
    assert.equal(status.data[0]!.status, "installed");
    assert.equal(readFileSync(path.join(target, "config.json"), "utf8"), config.body);
    const state = JSON.parse(readFileSync(path.join(stateDir, "provision.lock.json"), "utf8"));
    assert.deepEqual(state.adopted, []);
  });

  test("an idempotent adopt request consumes its one-shot grant immediately", async () => {
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const config = configItem("tok-1");
    registerManifestUrl(serveManifest([config.item]));
    await syncNow();

    const unchanged = await approveItem("config", "collavre", { adopt: true });
    assert.equal(unchanged.data[0]!.status, "installed");
    const state = JSON.parse(readFileSync(path.join(stateDir, "provision.lock.json"), "utf8"));
    assert.deepEqual(state.adopted, []);
  });

  test("a failed adopt attempt does not authorize a later overwrite", async () => {
    const target = path.join(configDir, "collavre");
    mkdirSync(target);
    writeFileSync(path.join(target, "config.json"), "hand-written");
    const config = configItem("tok-1");
    registerManifestUrl(serveManifest([config.item]));
    await syncNow();

    const artifact = responses.get("/config.tar.gz")!;
    responses.delete("/config.tar.gz");
    const failed = await approveItem("config", "collavre", { adopt: true });
    assert.equal(failed.data[0]!.status, "failed");
    responses.set("/config.tar.gz", artifact);

    const retried = await syncNow();
    assert.equal(retried.data[0]!.status, "failed");
    assert.match(retried.data[0]!.error!, /untracked file/);
    assert.equal(readFileSync(path.join(target, "config.json"), "utf8"), "hand-written");
    const state = JSON.parse(readFileSync(path.join(stateDir, "provision.lock.json"), "utf8"));
    assert.deepEqual(state.adopted, []);
  });

  test("an untracked config collision fails without touching the file", async () => {
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const target = path.join(configDir, "collavre");
    mkdirSync(target);
    writeFileSync(path.join(target, "config.json"), "hand-written");
    const config = configItem("tok-1");
    registerManifestUrl(serveManifest([config.item]));
    const status = await syncNow();
    assert.equal(status.data[0]!.status, "failed");
    assert.match(status.data[0]!.error!, /untracked file "config\.json"/);
    assert.equal(readFileSync(path.join(target, "config.json"), "utf8"), "hand-written");
  });

  test("a per-user gateway refuses config while leaving skill provisioning enabled", async () => {
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const config = configItem("tok-1");
    registerManifestUrl(serveManifest([config.item]));
    await syncNow();
    const configTarget = path.join(configDir, "collavre");
    writeFileSync(path.join(configTarget, "notes.txt"), "mine");

    initProvisioning({ perUserWorkers: true });
    assert.equal(
      existsSync(path.join(configTarget, "config.json")),
      false,
      "gateway transition removes credentials before a manifest is available",
    );
    assert.equal(readFileSync(path.join(configTarget, "notes.txt"), "utf8"), "mine");
    const gatewayState = JSON.parse(
      readFileSync(path.join(stateDir, "provision.lock.json"), "utf8"),
    );
    assert.equal("config/collavre" in gatewayState.installed, false);
    const skill = serveSkill("/skill.tar.gz", "# gateway skill");
    responses.set("/provision.json", { schema: "agent-provisioning/v1", items: [
      config.item,
      { type: "skill", name: "gateway-skill", ...skill },
    ] });
    registerManifestUrl(`${baseUrl}/provision.json`);
    const status = await syncNow();
    assert.equal(status.data[0]!.status, "failed");
    assert.match(status.data[0]!.error!, /per-user/);
    assert.equal(status.data[1]!.status, "installed");
    assert.equal(existsSync(path.join(configTarget, "config.json")), false);
    assert.equal(readFileSync(path.join(configTarget, "notes.txt"), "utf8"), "mine");
  });

  test("config status and download errors never expose artifact or callback tokens", async () => {
    process.env.PROVISION_AUTOAPPLY = "auto";
    initProvisioning();
    const artifactToken = "artifact-token-abcdef";
    const callbackToken = "callback-token-abcdef";
    const config = configItem(callbackToken, `/artifacts/${artifactToken}/config.tar.gz`);
    registerManifestUrl(serveManifest([config.item]));
    await syncNow();
    let serialized = JSON.stringify(getStatus());
    assert.equal(serialized.includes(artifactToken), false);
    assert.equal(serialized.includes(callbackToken), false);

    responses.delete(`/artifacts/${artifactToken}/config.tar.gz`);
    rmSync(path.join(configDir, "collavre"), { recursive: true, force: true });
    const failed = await syncNow();
    serialized = JSON.stringify(failed);
    assert.match(failed.data[0]!.error!, /HTTP 404/);
    assert.equal(serialized.includes(artifactToken), false);
    assert.equal(serialized.includes(callbackToken), false);
  });
});
