import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CODEX_CUSTOM_PROVIDER_ID,
  DEFAULT_CODEX_REASONING_EFFORT,
  coerceCodexReasoningEffort,
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

test("resolves a per-run home outside the Paperclip-managed company tree", () => {
  // A home the codex adapter classifies as managed is seeded with (and gated on)
  // an auth.json this adapter deliberately does not have.
  const home = resolveCodexCustomHome("run-abc", "/tmp/example-paperclip-home");

  assert.ok(home.startsWith("/tmp/example-paperclip-home/instances/"));
  assert.ok(!home.includes(`${path.sep}companies${path.sep}`), `must not live under companies/: ${home}`);
  assert.ok(home.endsWith(path.join("cli-openai-proxy", "codex-custom-homes", "run-abc")));
});

test("prepare creates separate homes for separate runs", async () => {
  const paperclipHome = await mkdtemp(path.join(tmpdir(), "codex-custom-home-test-"));
  try {
    const one = await prepareCodexCustomHome("https://one.example/v1", "run-one", paperclipHome);
    const two = await prepareCodexCustomHome("https://two.example/v1", "run-two", paperclipHome);

    assert.notEqual(one, two);
    assert.match(await readFile(path.join(one, "config.toml"), "utf8"), /one\.example/);
    assert.match(await readFile(path.join(two, "config.toml"), "utf8"), /two\.example/);
    assert.doesNotMatch(await readFile(path.join(one, "config.toml"), "utf8"), /two\.example/);
  } finally {
    await rm(paperclipHome, { recursive: true, force: true });
  }
});

test("concurrent prepares give each run a complete isolated file", async () => {
  const paperclipHome = await mkdtemp(path.join(tmpdir(), "codex-custom-home-test-"));
  try {
    const homes = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
	prepareCodexCustomHome(`https://gateway-${index}.example/v1`, `run-${index}`, paperclipHome),
      ),
    );
    assert.equal(new Set(homes).size, 8, "each run gets its own home");
    for (const [index, home] of homes.entries()) {
      const configToml = await readFile(path.join(home, "config.toml"), "utf8");
      assert.match(configToml, new RegExp(`gateway-${index}\\.example`));
      assert.equal(configToml.match(/^model_provider =/gm)?.length, 1);
      assert.match(configToml, /^# <<< cli-openai-proxy codex_custom provider \(table\) <<<$/m);
      assert.deepEqual((await readdir(home)).filter((name) => name.endsWith(".tmp")), []);
    }
  } finally {
    await rm(paperclipHome, { recursive: true, force: true });
  }
});

test("prepare keeps an existing config.toml's foreign content", async () => {
  const paperclipHome = await mkdtemp(path.join(tmpdir(), "codex-custom-home-test-"));
  try {
    const home = resolveCodexCustomHome("run-foreign", paperclipHome);
    await mkdir(home, { recursive: true });
    await writeFile(path.join(home, "config.toml"), '[mcp_servers.kept]\ncommand = "npx"\n');

    await prepareCodexCustomHome("https://one.example/v1", "run-foreign", paperclipHome);

    const merged = await readFile(path.join(home, "config.toml"), "utf8");
    assert.match(merged, /\[mcp_servers\.kept\]/);
    assert.match(merged, /one\.example/);
  } finally {
    await rm(paperclipHome, { recursive: true, force: true });
  }
});

test("pins a reasoning effort so a gateway model is not sent effort-less reasoning", () => {
  // codex has no built-in metadata for a gateway's model ids, and its fallback
  // metadata says effort "none" — which reaches the wire as a `reasoning` block
  // with no effort and is rejected outright by reasoning-mandatory endpoints.
  const toml = renderCodexCustomConfigToml("", "https://openrouter.ai/api/v1");

  assert.match(toml, new RegExp(`^model_reasoning_effort = "${DEFAULT_CODEX_REASONING_EFFORT}"$`, "m"));
  assert.ok(
    toml.indexOf("model_reasoning_effort =") < toml.indexOf("[model_providers."),
    "root key must precede the table header",
  );
});

test("renders the requested reasoning effort", () => {
  const toml = renderCodexCustomConfigToml("", "https://openrouter.ai/api/v1", "high");

  assert.match(toml, /^model_reasoning_effort = "high"$/m);
  assert.equal(toml.match(/^model_reasoning_effort =/gm)?.length, 1);
});

test("re-rendering replaces the previous effort instead of stacking a second one", () => {
  const first = renderCodexCustomConfigToml("", "https://one.example/v1", "low");
  const second = renderCodexCustomConfigToml(first, "https://one.example/v1", "high");

  assert.equal(second.match(/^model_reasoning_effort =/gm)?.length, 1);
  assert.match(second, /^model_reasoning_effort = "high"$/m);
});

test("coerces only efforts codex accepts", () => {
  for (const effort of ["none", "minimal", "low", "medium", "high"]) {
    assert.equal(coerceCodexReasoningEffort(effort), effort);
  }
  // An unknown value would make codex refuse the whole config, so it is dropped
  // in favour of the default rather than written through.
  for (const bad of ["MEDIUM", "ultra", "", 3, null, undefined]) {
    assert.equal(coerceCodexReasoningEffort(bad), undefined);
  }
});

test("prepareCodexCustomHome writes the requested effort into config.toml", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "codex-custom-effort-"));
  try {
    const codexHome = await prepareCodexCustomHome("https://openrouter.ai/api/v1", "run-effort", home, "low");
    const toml = await readFile(path.join(codexHome, "config.toml"), "utf8");
    assert.match(toml, /^model_reasoning_effort = "low"$/m);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
