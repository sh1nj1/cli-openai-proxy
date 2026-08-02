import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "crypto";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { createServer, type Server } from "http";
import { tmpdir } from "os";
import path from "path";
import { gzipSync } from "zlib";
import {
  approveItem,
  deleteItem,
  getStatus,
  handleAuthorizedSession,
  initProvisioning,
  provisionEnabled,
  registerManifestUrl,
  resetProvisioning,
  syncNow,
} from "./sync.js";
import { ProvisionError } from "./types.js";

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
  let stateDir: string;
  let skillsDir: string;
  const saved = new Map<string, string | undefined>();

  before(async () => {
    responses = new Map();
    server = createServer((req, res) => {
      const body = responses.get(req.url ?? "");
      if (body === undefined) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
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
    initProvisioning();
  });

  afterEach(() => {
    resetProvisioning();
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

  test("an unreachable manifest is manifest_fetch_failed", async () => {
    registerManifestUrl(`${baseUrl}/missing.json`);
    assert.equal(await codeOf(() => syncNow()), "manifest_fetch_failed");
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
    assert.deepEqual(deleteItem("skill", "aaa"), { removed: true });
    assert.equal(existsSync(path.join(skillsDir, "aaa")), false);

    const view = await syncNow();
    assert.equal(statusOf(view, "aaa"), "pending_approval");
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

  test("PROVISION_MANIFEST_URL registers at init", () => {
    process.env.PROVISION_MANIFEST_URL = `${baseUrl}/provision.json`;
    initProvisioning();
    assert.equal(getStatus().manifest_url, `${baseUrl}/provision.json`);
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
});
