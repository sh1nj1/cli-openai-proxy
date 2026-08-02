import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { parseManifest, checkUrlAllowed, getAllowlist } from "./manifest.js";
import { ProvisionError } from "./types.js";

const valid = () => ({
  schema: "agent-provisioning/v1",
  items: [
    {
      type: "skill",
      name: "pr-monitor",
      url: "https://collavre.com/registry/pr-monitor-1.4.2.tar.gz",
      sha256: "a".repeat(64),
    },
  ],
});

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    if (err instanceof ProvisionError) return err.code;
    throw err;
  }
  return "(no error)";
};

describe("provision manifest", () => {
  let savedAllowlist: string | undefined;
  beforeEach(() => {
    savedAllowlist = process.env.PROVISION_ALLOWLIST;
    delete process.env.PROVISION_ALLOWLIST;
  });
  afterEach(() => {
    if (savedAllowlist === undefined) delete process.env.PROVISION_ALLOWLIST;
    else process.env.PROVISION_ALLOWLIST = savedAllowlist;
  });

  test("a well-formed manifest parses to its items", () => {
    const manifest = parseManifest(valid());
    assert.equal(manifest.schema, "agent-provisioning/v1");
    assert.equal(manifest.items.length, 1);
    assert.equal(manifest.items[0]!.name, "pr-monitor");
  });

  test("a manifest with another schema id is refused", () => {
    assert.equal(codeOf(() => parseManifest({ ...valid(), schema: "something/v2" })), "invalid_manifest");
  });

  test("non-object input and a missing items array are refused", () => {
    assert.equal(codeOf(() => parseManifest("nope")), "invalid_manifest");
    assert.equal(codeOf(() => parseManifest({ schema: "agent-provisioning/v1" })), "invalid_manifest");
  });

  test("an item without a name is refused", () => {
    const manifest = valid();
    delete (manifest.items[0] as Record<string, unknown>).name;
    assert.equal(codeOf(() => parseManifest(manifest)), "invalid_item");
  });

  // The name becomes a directory segment under the type's sandbox; a traversal
  // or hidden-file name must die at parse time, before any install logic runs.
  test("path-hostile names are refused", () => {
    for (const name of ["../evil", "a/b", ".hidden", "..", "", "a".repeat(80)]) {
      const manifest = valid();
      (manifest.items[0] as Record<string, unknown>).name = name;
      assert.equal(codeOf(() => parseManifest(manifest)), "invalid_item", `name=${JSON.stringify(name)}`);
    }
  });

  test("a supported-type item without url or sha256 is refused", () => {
    for (const field of ["url", "sha256"] as const) {
      const manifest = valid();
      delete (manifest.items[0] as Record<string, unknown>)[field];
      assert.equal(codeOf(() => parseManifest(manifest)), "invalid_item", `missing ${field}`);
    }
  });

  test("a malformed sha256 is refused", () => {
    const manifest = valid();
    (manifest.items[0] as Record<string, unknown>).sha256 = "zz".repeat(32);
    assert.equal(codeOf(() => parseManifest(manifest)), "invalid_item");
  });

  // Forward compatibility: a newer collavre may send types this proxy version
  // does not know. They must parse (and later report `unsupported`) rather than
  // poison the whole manifest.
  test("an unknown item type parses without url/sha256", () => {
    const manifest = valid();
    manifest.items.push({ type: "mcp", name: "future-thing" } as never);
    assert.equal(parseManifest(manifest).items.length, 2);
  });

  test("duplicate (type, name) pairs are refused", () => {
    const manifest = valid();
    manifest.items.push({ ...manifest.items[0]! });
    assert.equal(codeOf(() => parseManifest(manifest)), "invalid_item");
  });

  describe("checkUrlAllowed", () => {
    const manifestUrl = "https://collavre.com/agents/vrex/provision.json";

    test("without an allowlist, item hosts must match the manifest host", () => {
      checkUrlAllowed("https://collavre.com/registry/x.tar.gz", { manifestUrl, allowlist: null });
      assert.equal(
        codeOf(() => checkUrlAllowed("https://evil.example/x.tar.gz", { manifestUrl, allowlist: null })),
        "url_not_allowed",
      );
    });

    test("with an allowlist, both listed and unlisted hosts are judged by it", () => {
      const allowlist = ["cdn.example"];
      checkUrlAllowed("https://cdn.example/x.tar.gz", { manifestUrl, allowlist });
      assert.equal(
        codeOf(() => checkUrlAllowed("https://collavre.com/x.tar.gz", { manifestUrl, allowlist })),
        "url_not_allowed",
      );
    });

    test("plain http is refused except for loopback hosts", () => {
      assert.equal(
        codeOf(() => checkUrlAllowed("http://collavre.com/x.tar.gz", { manifestUrl, allowlist: null })),
        "url_not_allowed",
      );
      checkUrlAllowed("http://127.0.0.1:8099/x.tar.gz", {
        manifestUrl: "http://127.0.0.1:8099/provision.json",
        allowlist: null,
      });
    });

    test("an unparseable url is refused", () => {
      assert.equal(codeOf(() => checkUrlAllowed("not a url", { manifestUrl, allowlist: null })), "invalid_url");
    });
  });

  describe("getAllowlist", () => {
    test("unset means null, set means lowercased hostnames", () => {
      assert.equal(getAllowlist(), null);
      process.env.PROVISION_ALLOWLIST = " CDN.Example , collavre.com ";
      assert.deepEqual(getAllowlist(), ["cdn.example", "collavre.com"]);
    });
  });
});
