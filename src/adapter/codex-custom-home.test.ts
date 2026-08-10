import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CODEX_CUSTOM_PROVIDER_ID,
  prepareCodexCustomHome,
  renderCodexCustomConfigToml,
  resolveCodexCustomHome,
} from "./codex-custom-home.js";

test("emits a provider table selected by a root-level model_provider", () => {
  const toml = renderCodexCustomConfigToml("", "https://openrouter.ai/api/v1");

  assert.match(toml, /^# >>> cli-openai-proxy codex_custom provider \(root\)/);
  assert.match(toml, new RegExp(`^model_provider = "${CODEX_CUSTOM_PROVIDER_ID}"$`, "m"));
  assert.match(toml, new RegExp(`^\\[model_providers\\.${CODEX_CUSTOM_PROVIDER_ID}\\]$`, "m"));
  assert.match(toml, /^base_url = "https:\/\/openrouter\.ai\/api\/v1"$/m);
  // Indirection, never the key itself: the secret must not reach this file.
  assert.match(toml, /^env_key = "CODEX_CUSTOM_API_KEY"$/m);
  // codex >= 0.145 refuses to load a config asking for "chat".
  assert.match(toml, /^wire_api = "responses"$/m);

  // TOML requires root keys before the first table header.
  assert.ok(
    toml.indexOf("model_provider =") < toml.indexOf("[model_providers."),
    "root key must precede the table header",
  );
});

test("re-rendering replaces the previous block instead of stacking a second one", () => {
  const first = renderCodexCustomConfigToml("", "https://one.example/v1");
  const second = renderCodexCustomConfigToml(first, "https://two.example/v1");

  assert.equal(second.match(/^model_provider =/gm)?.length, 1);
  assert.equal(second.match(/^\[model_providers\./gm)?.length, 1);
  assert.match(second, /base_url = "https:\/\/two\.example\/v1"/);
  assert.doesNotMatch(second, /one\.example/);
});

test("preserves content this proxy does not own", () => {
  // The codex adapter appends its own managed MCP block to this same file every
  // run; overwriting it would silently drop the run's MCP servers.
  const foreign = [
    "# >>> paperclip codex mcp -- managed >>>",
    "[mcp_servers.gateway]",
    'command = "npx"',
    "# <<< paperclip codex mcp <<<",
  ].join("\n");

  const merged = renderCodexCustomConfigToml(
    renderCodexCustomConfigToml("", "https://one.example/v1") + `\n${foreign}\n`,
    "https://two.example/v1",
  );

  assert.match(merged, /\[mcp_servers\.gateway\]/);
  assert.match(merged, /base_url = "https:\/\/two\.example\/v1"/);
  assert.equal(merged.match(/^model_provider =/gm)?.length, 1);
});

test("drops the per-run trust records codex leaves inside the block", () => {
  // codex writes [projects."<cwd>"] after every run, and its TOML editor inserts
  // it ahead of the file's trailing comments — inside our markers. Each run has a
  // fresh temp cwd, so keeping them would grow the file forever for no reader.
  const afterRun = renderCodexCustomConfigToml("", "https://one.example/v1").replace(
    /^# <<< cli-openai-proxy codex_custom provider \(table\) <<</m,
    ['[projects."/tmp/paperclip-run-abc"]', 'trust_level = "trusted"', "$&"].join("\n"),
  );
  assert.match(afterRun, /\[projects\./, "fixture must reproduce what codex writes");

  assert.doesNotMatch(renderCodexCustomConfigToml(afterRun, "https://one.example/v1"), /\[projects\./);
});

test("escapes quotes and backslashes so a hostile URL cannot break out of the string", () => {
  const toml = renderCodexCustomConfigToml("", 'https://evil.example/v1"\n[model_providers.x]\ny = "');

  assert.equal(toml.match(/^\[model_providers\./gm)?.length, 1, "no injected table survived");
  assert.match(toml, /base_url = ".*\\"/);
});

test("resolves a home outside the Paperclip-managed company tree", () => {
  // A home the codex adapter classifies as managed is seeded with (and gated on)
  // an auth.json this adapter deliberately does not have.
  const home = resolveCodexCustomHome("/tmp/example-paperclip-home");

  assert.ok(home.startsWith("/tmp/example-paperclip-home/instances/"));
  assert.ok(!home.includes(`${path.sep}companies${path.sep}`), `must not live under companies/: ${home}`);
  assert.ok(home.endsWith(path.join("cli-openai-proxy", "codex-custom-home")));
});

test("prepare creates the home and rewrites config.toml on every call", async () => {
  const paperclipHome = await mkdtemp(path.join(tmpdir(), "codex-custom-home-test-"));
  try {
    const home = await prepareCodexCustomHome("https://one.example/v1", paperclipHome);
    const configPath = path.join(home, "config.toml");
    assert.match(await readFile(configPath, "utf8"), /one\.example/);

    // A run must never inherit the gateway of a credential since replaced.
    await prepareCodexCustomHome("https://two.example/v1", paperclipHome);
    const after = await readFile(configPath, "utf8");
    assert.match(after, /two\.example/);
    assert.doesNotMatch(after, /one\.example/);
  } finally {
    await rm(paperclipHome, { recursive: true, force: true });
  }
});

test("concurrent prepares leave one complete file and no staging debris", async () => {
  // Completions share this home, so a plain in-place write could be read
  // half-finished by a codex booting at that moment.
  const paperclipHome = await mkdtemp(path.join(tmpdir(), "codex-custom-home-test-"));
  try {
    const homes = await Promise.all(
      Array.from({ length: 8 }, () => prepareCodexCustomHome("https://one.example/v1", paperclipHome)),
    );
    const home = homes[0];

    const configToml = await readFile(path.join(home, "config.toml"), "utf8");
    assert.equal(configToml.match(/^model_provider =/gm)?.length, 1);
    assert.match(configToml, /^# <<< cli-openai-proxy codex_custom provider \(table\) <<<$/m);
    assert.deepEqual(
      (await readdir(home)).filter((name) => name.endsWith(".tmp")),
      [],
      "staging files must not survive",
    );
  } finally {
    await rm(paperclipHome, { recursive: true, force: true });
  }
});

test("prepare keeps an existing config.toml's foreign content", async () => {
  const paperclipHome = await mkdtemp(path.join(tmpdir(), "codex-custom-home-test-"));
  try {
    const home = resolveCodexCustomHome(paperclipHome);
    await mkdir(home, { recursive: true });
    await writeFile(path.join(home, "config.toml"), '[mcp_servers.kept]\ncommand = "npx"\n');

    await prepareCodexCustomHome("https://one.example/v1", paperclipHome);

    const merged = await readFile(path.join(home, "config.toml"), "utf8");
    assert.match(merged, /\[mcp_servers\.kept\]/);
    assert.match(merged, /one\.example/);
  } finally {
    await rm(paperclipHome, { recursive: true, force: true });
  }
});
