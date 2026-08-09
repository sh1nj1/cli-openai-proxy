import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { createServer, type Server } from "http";
import { tmpdir } from "os";
import path from "path";
import { installConfig, removeConfig } from "./config-installer.js";
import { ProvisionError } from "./types.js";

function makeArchive(files: Record<string, string>, wrapper?: string): Buffer {
  const build = mkdtempSync(path.join(tmpdir(), "config-archive-"));
  const root = wrapper ? path.join(build, wrapper) : build;
  mkdirSync(root, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), content, { mode: 0o644 });
  }
  const archive = path.join(build, "out.tgz");
  execFileSync("tar", [
    "-czf",
    archive,
    "-C",
    build,
    ...(wrapper ? [wrapper] : Object.keys(files)),
  ]);
  const result = readFileSync(archive);
  rmSync(build, { recursive: true, force: true });
  return result;
}

const CONFIG_JSON = JSON.stringify({ url: "https://collavre.example.com", token: "tok-1" });

describe("config installer", () => {
  let server: Server;
  let baseUrl: string;
  let responses: Map<string, Buffer>;
  let configDir: string;

  before(async () => {
    responses = new Map();
    server = createServer((req, res) => {
      const body = responses.get(req.url ?? "");
      if (!body) {
	res.statusCode = 404;
	res.end("not found");
	return;
      }
      res.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  });

  beforeEach(() => {
    responses.clear();
    configDir = mkdtempSync(path.join(tmpdir(), "provision-config-"));
  });

  afterEach(() => rmSync(configDir, { recursive: true, force: true }));

  function publish(name: string, archive: Buffer) {
    const pathname = `/artifacts/${name}.tar.gz`;
    responses.set(pathname, archive);
    return {
      name,
      url: `${baseUrl}${pathname}`,
      sha256: createHash("sha256").update(archive).digest("hex"),
    };
  }

  test("installs flat config files with credential-grade modes", async () => {
    const result = await installConfig(
      publish("collavre", makeArchive({ "config.json": CONFIG_JSON })),
      { configDir },
    );
    const target = path.join(configDir, "collavre");
    assert.deepEqual(result.files, ["config.json"]);
    assert.equal(readFileSync(path.join(target, "config.json"), "utf8"), CONFIG_JSON);
    if (process.platform !== "win32") {
      assert.equal(lstatSync(target).mode & 0o777, 0o700);
      assert.equal(lstatSync(path.join(target, "config.json")).mode & 0o777, 0o600);
    }
    assert.equal(
      result.fileHashes["config.json"],
      createHash("sha256").update(CONFIG_JSON).digest("hex"),
    );
  });

  test("strips one wrapper directory", async () => {
    const item = publish("collavre", makeArchive({ "config.json": CONFIG_JSON }, "collavre"));
    await installConfig(item, { configDir });
    assert.equal(readFileSync(path.join(configDir, "collavre", "config.json"), "utf8"), CONFIG_JSON);
  });

  test("forces 0600 even when the archive records a loose mode", async () => {
    const build = mkdtempSync(path.join(tmpdir(), "config-loose-"));
    writeFileSync(path.join(build, "config.json"), CONFIG_JSON);
    chmodSync(path.join(build, "config.json"), 0o666);
    const archivePath = path.join(build, "out.tgz");
    execFileSync("tar", ["-czf", archivePath, "-C", build, "config.json"]);
    const item = publish("collavre", readFileSync(archivePath));
    rmSync(build, { recursive: true, force: true });
    await installConfig(item, { configDir });
    if (process.platform !== "win32") {
      assert.equal(lstatSync(path.join(configDir, "collavre", "config.json")).mode & 0o777, 0o600);
    }
  });

  test("rejects invalid hashes, nested files, oversized files, and binary files", async () => {
    const good = publish("collavre", makeArchive({ "config.json": CONFIG_JSON }));
    await assert.rejects(
      () => installConfig({ ...good, sha256: "0".repeat(64) }, { configDir }),
      (err: ProvisionError) => err.code === "sha256_mismatch",
    );
    for (const [archive, code] of [
      [makeArchive({ "nested/config.json": CONFIG_JSON }), "archive_rejected"],
      [makeArchive({ "config.json": "x".repeat(1024 * 1024 + 1) }), "audit_failed"],
      [makeArchive({ "config.json": "before\0after" }), "audit_failed"],
    ] as const) {
      await assert.rejects(
	() => installConfig(publish("collavre", archive), { configDir }),
	(err: ProvisionError) => err.code === code,
      );
    }
    assert.deepEqual(readdirSync(configDir), []);
  });

  test("does not apply the skill remote-execution text scan", async () => {
    const item = publish("collavre", makeArchive({ "config.json": "curl x | sh" }));
    assert.deepEqual((await installConfig(item, { configDir })).files, ["config.json"]);
  });

  test("keeps unrelated user files and refuses a colliding untracked file", async () => {
    const target = path.join(configDir, "collavre");
    mkdirSync(target, { mode: 0o755 });
    chmodSync(target, 0o755);
    writeFileSync(path.join(target, "notes.txt"), "mine");
    writeFileSync(path.join(target, "config.json"), "hand-written");
    const item = publish("collavre", makeArchive({ "config.json": CONFIG_JSON }));
    await assert.rejects(
      () => installConfig(item, { configDir }),
      (err: ProvisionError) => err.code === "untracked_content" && /config\.json/.test(err.message),
    );
    assert.equal(readFileSync(path.join(target, "config.json"), "utf8"), "hand-written");
    assert.equal(readFileSync(path.join(target, "notes.txt"), "utf8"), "mine");
    if (process.platform !== "win32") {
      assert.equal(lstatSync(target).mode & 0o777, 0o755);
    }
  });

  test("a file created after the collision audit is not adopted implicitly", async () => {
    const item = publish("collavre", makeArchive({ "config.json": CONFIG_JSON }));
    const target = path.join(configDir, "collavre");
    await assert.rejects(
      () => installConfig(item, {
	configDir,
	beforePublish: () => writeFileSync(path.join(target, "config.json"), "raced"),
      }),
      (err: ProvisionError) => err.code === "untracked_content",
    );
    assert.equal(readFileSync(path.join(target, "config.json"), "utf8"), "raced");
  });

  test("a directory swap cannot redirect credential publication", {
    skip: process.platform === "win32"
      ? "Windows prevents renaming a directory that contains the open candidate"
      : false,
  }, async () => {
    const elsewhere = mkdtempSync(path.join(tmpdir(), "config-race-elsewhere-"));
    const displaced = path.join(configDir, "displaced");
    const target = path.join(configDir, "collavre");
    const item = publish("collavre", makeArchive({ "config.json": CONFIG_JSON }));
    await assert.rejects(
      () => installConfig(item, {
	configDir,
	beforePublish: () => {
	  renameSync(target, displaced);
	  symlinkSync(elsewhere, target);
	},
      }),
      (err: ProvisionError) => err.code === "untracked_content",
    );
    assert.equal(existsSync(path.join(elsewhere, "config.json")), false);
    assert.equal(existsSync(path.join(displaced, "config.json")), false);
    rmSync(elsewhere, { recursive: true, force: true });
  });

  test("a directory swap cannot redirect an atomic credential replacement", {
    skip: process.platform === "win32"
      ? "Windows prevents renaming a directory that contains the open candidate"
      : false,
  }, async () => {
    const first = publish("collavre", makeArchive({ "config.json": CONFIG_JSON }));
    const installed = await installConfig(first, { configDir });
    const target = path.join(configDir, "collavre");
    const displaced = path.join(configDir, "displaced");
    const replacement = JSON.stringify({ token: "tok-2" });
    const second = publish("collavre", makeArchive({ "config.json": replacement }));

    await assert.rejects(
      () => installConfig(second, {
	configDir,
	managedFiles: installed.files,
	beforeReplace: () => {
	  renameSync(target, displaced);
	  mkdirSync(target);
	  writeFileSync(path.join(target, "config.json"), "user-owned");
	},
      }),
      (err: ProvisionError) => err.code === "untracked_content",
    );
    assert.equal(readFileSync(path.join(target, "config.json"), "utf8"), "user-owned");
    assert.equal(readFileSync(path.join(displaced, "config.json"), "utf8"), CONFIG_JSON);
    const displacedEntries = readdirSync(displaced);
    assert.equal(displacedEntries.includes("config.json"), true);
    const placeholder = displacedEntries.find((entry) => entry.startsWith(".provision-config-candidate-"));
    assert.ok(placeholder);
    assert.equal(readFileSync(path.join(displaced, placeholder)).length, 0);
  });

  test("adopts a colliding file only with an explicit grant", async () => {
    const target = path.join(configDir, "collavre");
    mkdirSync(target);
    writeFileSync(path.join(target, "config.json"), "hand-written");
    const item = publish("collavre", makeArchive({ "config.json": CONFIG_JSON }));
    await installConfig(item, { configDir, adopt: true });
    assert.equal(readFileSync(path.join(target, "config.json"), "utf8"), CONFIG_JSON);
  });

  test("upgrades the owned credential atomically", async () => {
    const first = publish("collavre", makeArchive({ "config.json": CONFIG_JSON }));
    const installed = await installConfig(first, { configDir });
    const rotated = JSON.stringify({ token: "tok-2" });
    const second = publish("collavre", makeArchive({ "config.json": rotated }));
    await installConfig(second, { configDir, managedFiles: installed.files });
    assert.equal(readFileSync(path.join(configDir, "collavre", "config.json"), "utf8"), rotated);
  });

  test("secures an existing directory before publishing a credential", async () => {
    const target = path.join(configDir, "collavre");
    mkdirSync(target, { mode: 0o755 });
    chmodSync(target, 0o755);
    const item = publish("collavre", makeArchive({ "config.json": CONFIG_JSON }));

    await assert.rejects(
      () => installConfig(item, {
	configDir,
	afterPublish: () => {
	  if (process.platform !== "win32") {
	    assert.equal(lstatSync(target).mode & 0o777, 0o700);
	  }
	  throw new Error("simulated crash after publish");
	},
      }),
      /simulated crash after publish/,
    );
    if (process.platform !== "win32") {
      assert.equal(lstatSync(target).mode & 0o777, 0o700);
    }
    assert.equal(readFileSync(path.join(target, "config.json"), "utf8"), CONFIG_JSON);
  });

  test("rejects extra flat files outside the config artifact contract", async () => {
    const item = publish("collavre", makeArchive({
      "config.json": CONFIG_JSON,
      "obsolete.json": "old",
    }));
    await assert.rejects(
      () => installConfig(item, { configDir }),
      (err: ProvisionError) => err.code === "archive_rejected",
    );
  });

  test("a publication failure leaves the previous credential file intact", async () => {
    const first = publish("collavre", makeArchive({ "config.json": CONFIG_JSON }));
    const installed = await installConfig(first, { configDir });
    const second = publish("collavre", makeArchive({ "config.json": JSON.stringify({ token: "tok-2" }) }));
    await assert.rejects(
      () => installConfig(second, {
	configDir,
	managedFiles: installed.files,
	beforePublish: () => { throw new Error("simulated failure"); },
      }),
      /simulated failure/,
    );
    assert.equal(readFileSync(path.join(configDir, "collavre", "config.json"), "utf8"), CONFIG_JSON);
    const entries = readdirSync(path.join(configDir, "collavre"));
    assert.equal(entries.includes("config.json"), true);
    const placeholder = entries.find((entry) => entry.startsWith(".provision-config-candidate-"));
    assert.ok(placeholder);
    assert.equal(readFileSync(path.join(configDir, "collavre", placeholder)).length, 0);
  });

  test("refuses a symlinked item directory", async () => {
    const elsewhere = mkdtempSync(path.join(tmpdir(), "config-elsewhere-"));
    symlinkSync(elsewhere, path.join(configDir, "collavre"));
    const item = publish("collavre", makeArchive({ "config.json": CONFIG_JSON }));
    await assert.rejects(
      () => installConfig(item, { configDir }),
      (err: ProvisionError) => err.code === "untracked_content",
    );
    assert.equal(existsSync(path.join(elsewhere, "config.json")), false);
    rmSync(elsewhere, { recursive: true, force: true });
  });

  test("records ownership before publication and cleans staging", async () => {
    const order: string[] = [];
    const item = publish("collavre", makeArchive({ "config.json": CONFIG_JSON }));
    await installConfig(item, {
      configDir,
      beforeCommit: (_result, journal) => {
	order.push("commit");
	assert.equal(existsSync(path.join(configDir, "collavre", "config.json")), false);
	assert.equal(existsSync(path.join(configDir, "collavre", journal.candidate.name)), true);
      },
      beforePublish: () => order.push("publish"),
    });
    assert.deepEqual(order, ["commit", "publish"]);
    assert.deepEqual(readdirSync(configDir), ["collavre"]);
  });

  test("sanitizes download errors so signed artifact URLs never leak", async () => {
    const secretUrl = `${baseUrl}/artifacts/workspace-secret/config.tar.gz`;
    await assert.rejects(
      () => installConfig(
	{ name: "collavre", url: secretUrl, sha256: "0".repeat(64) },
	{ configDir },
      ),
      (err: ProvisionError) => err.code === "download_failed"
	&& /HTTP 404/.test(err.message)
	&& !err.message.includes("workspace-secret")
	&& !err.message.includes(baseUrl),
    );
  });

  test("removal deletes only recorded files and retains user content", async () => {
    const installed = await installConfig(
      publish("collavre", makeArchive({ "config.json": CONFIG_JSON })),
      { configDir },
    );
    const target = path.join(configDir, "collavre");
    writeFileSync(path.join(target, "notes.txt"), "mine");
    assert.deepEqual(removeConfig("collavre", { configDir, files: installed.files }), {
      removed: ["config.json"],
    });
    assert.equal(readFileSync(path.join(target, "notes.txt"), "utf8"), "mine");
    assert.equal(existsSync(target), true);
  });

  test("removal retains an empty shared item directory and rejects escaped records", async () => {
    const installed = await installConfig(
      publish("collavre", makeArchive({ "config.json": CONFIG_JSON })),
      { configDir },
    );
    removeConfig("collavre", { configDir, files: installed.files });
    assert.deepEqual(readdirSync(path.join(configDir, "collavre")), []);
    assert.throws(
      () => removeConfig("collavre", { configDir, files: ["../escape"] }),
      (err: ProvisionError) => err.code === "invalid_item",
    );
  });

  test("removal refuses a symlinked item directory", () => {
    const elsewhere = mkdtempSync(path.join(tmpdir(), "config-remove-elsewhere-"));
    writeFileSync(path.join(elsewhere, "config.json"), "mine");
    symlinkSync(elsewhere, path.join(configDir, "collavre"));
    assert.throws(
      () => removeConfig("collavre", { configDir, files: ["config.json"] }),
      (err: ProvisionError) => err.code === "untracked_content",
    );
    assert.equal(readFileSync(path.join(elsewhere, "config.json"), "utf8"), "mine");
    rmSync(elsewhere, { recursive: true, force: true });
  });

  test("removal refuses a directory swapped after opening it", async () => {
    const installed = await installConfig(
      publish("collavre", makeArchive({ "config.json": CONFIG_JSON })),
      { configDir },
    );
    const elsewhere = mkdtempSync(path.join(tmpdir(), "config-remove-race-"));
    const target = path.join(configDir, "collavre");
    const displaced = path.join(configDir, "displaced");
    writeFileSync(path.join(elsewhere, "config.json"), "mine");
    assert.throws(
      () => removeConfig("collavre", {
	configDir,
	files: installed.files,
	beforeRemove: () => {
	  renameSync(target, displaced);
	  symlinkSync(elsewhere, target);
	},
      }),
      (err: ProvisionError) => err.code === "untracked_content",
    );
    assert.equal(readFileSync(path.join(elsewhere, "config.json"), "utf8"), "mine");
    assert.equal(readFileSync(path.join(displaced, "config.json"), "utf8"), CONFIG_JSON);
    rmSync(elsewhere, { recursive: true, force: true });
  });
});
