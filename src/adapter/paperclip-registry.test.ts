import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolvePaperclipModel,
  createRunner,
  PAPERCLIP_MODEL_IDS,
  UnknownPaperclipModelError,
  DEFAULT_MODEL,
  defaultModelForHost,
  adapterCredentialNotes,
  adapterLabel,
  suggestedSetupModelIds,
} from "./paperclip-registry.js";
import { PaperclipRunner } from "./paperclip-runner.js";

test("resolves a known paperclip model to a spec with an execute fn", () => {
  const resolved = resolvePaperclipModel("paperclip/claude_local");
  assert.ok(resolved);
  assert.equal(resolved!.spec.adapterType, "claude_local");
  assert.equal(typeof resolved!.spec.execute, "function");
  assert.equal(resolved!.spec.baseConfig.engine, "cli");
  assert.equal(resolved!.cliModel, undefined, "no suffix means the CLI default model");
});

test("returns null for models outside the paperclip/<adapter> namespace", () => {
  assert.equal(resolvePaperclipModel("claude-opus-4"), null);
  assert.equal(resolvePaperclipModel("claude-max/claude-opus-4-6"), null);
  assert.equal(resolvePaperclipModel("gpt-4o"), null);
  assert.equal(resolvePaperclipModel("paperclip/does-not-exist"), null);
  assert.equal(resolvePaperclipModel("paperclip/does-not-exist/gpt-5"), null);
});

test("resolves paperclip/codex_local to the codex adapter with per-adapter strategies", () => {
  // codex diverges from claude on all three seams: its prompt comes from a
  // rendered promptTemplate (not paperclipTaskMarkdown), it rejects claude-only
  // CLI flags, and it emits its own JSONL that the runner parses live (codex-jsonl).
  const resolved = resolvePaperclipModel("paperclip/codex_local");
  assert.ok(resolved);
  const spec = resolved!.spec;
  assert.equal(spec!.adapterType, "codex_local");
  assert.equal(typeof spec!.execute, "function");
  assert.equal(spec!.baseConfig.command, "codex");
  // codex reads its own bypass key (claude's dangerouslySkipPermissions is ignored).
  assert.equal(spec!.baseConfig.dangerouslyBypassApprovalsAndSandbox, true);
  assert.equal(spec!.promptInjection, "prompt-template");
  assert.equal(spec!.outputMode, "codex-jsonl");
  // No claude-only flags, but codex needs --skip-git-repo-check because the runner
  // executes it in a fresh non-git /tmp dir (buildCodexExecArgs only self-adds it for
  // its sandbox lane, not for local `codex exec`).
  assert.deepEqual(spec!.cliFlags, ["--skip-git-repo-check"], "codex gets git-repo bypass, no claude flags");
  assert.ok(!spec!.cliFlags.includes("--include-partial-messages"), "no claude-only flags for codex");
});

test("createRunner returns PaperclipRunner for every registered adapter, with or without a model suffix", () => {
  assert.ok(createRunner("paperclip/claude_local") instanceof PaperclipRunner);
  assert.ok(createRunner("paperclip/codex_local") instanceof PaperclipRunner);
  assert.ok(createRunner("paperclip/claude_local/claude-opus-4-8") instanceof PaperclipRunner);
  assert.ok(createRunner("paperclip/codex_local/gpt-5.4-mini") instanceof PaperclipRunner);
});

test("createRunner NEVER silently falls back to Claude for an unknown paperclip/* model", () => {
  // Regression: an unregistered paperclip/* id used to fall through to
  // the default Claude runner, so requesting a Paperclip adapter silently ran
  // the wrong adapter. A paperclip/* prefix must resolve explicitly or error.
  assert.throws(() => createRunner("paperclip/gemini_local"), UnknownPaperclipModelError);
  assert.throws(() => createRunner("paperclip/definitely_not_registered"), UnknownPaperclipModelError);
});

test("UnknownPaperclipModelError names the model and lists the known ids", () => {
  try {
    createRunner("paperclip/definitely_not_registered");
    assert.fail("expected createRunner to throw");
  } catch (err) {
    if (!(err instanceof UnknownPaperclipModelError)) throw err;
    assert.equal(err.model, "paperclip/definitely_not_registered");
    assert.ok(err.message.includes("paperclip/definitely_not_registered"));
    assert.ok(err.message.includes("paperclip/claude_local")); // a known id is surfaced
  }
});

test("PAPERCLIP_MODEL_IDS advertises the registered ids", () => {
  assert.ok(PAPERCLIP_MODEL_IDS.includes("paperclip/claude_local"));
  assert.ok(PAPERCLIP_MODEL_IDS.includes("paperclip/codex_local"));
});

test("splits the model suffix off the adapter key and passes it through verbatim", () => {
  const codex = resolvePaperclipModel("paperclip/codex_local/gpt-5.4-mini");
  assert.ok(codex);
  assert.equal(codex!.spec.adapterType, "codex_local");
  assert.equal(codex!.cliModel, "gpt-5.4-mini");

  const claude = resolvePaperclipModel("paperclip/claude_local/claude-opus-4-8");
  assert.ok(claude);
  assert.equal(claude!.spec.adapterType, "claude_local");
  assert.equal(claude!.cliModel, "claude-opus-4-8");
});

test("keeps the whole suffix, slashes included, as the model string", () => {
  // There is no model catalog here: whether a vendor-prefixed id is valid is the CLI's call.
  const resolved = resolvePaperclipModel("paperclip/codex_local/openrouter/some-model");
  assert.ok(resolved);
  assert.equal(resolved!.spec.adapterType, "codex_local");
  assert.equal(resolved!.cliModel, "openrouter/some-model");
});

test("an empty or whitespace-only suffix falls back to the CLI default model", () => {
  assert.equal(resolvePaperclipModel("paperclip/codex_local/")!.cliModel, undefined);
  assert.equal(resolvePaperclipModel("paperclip/codex_local/   ")!.cliModel, undefined);
});

test("the adapter key must match a registered adapter exactly, not by prefix", () => {
  // A prefix match would route paperclip/codex_local_x to the codex CLI.
  assert.equal(resolvePaperclipModel("paperclip/codex_local_x"), null);
  assert.equal(resolvePaperclipModel("paperclip/codex_local_x/gpt-5"), null);
});

test("createRunner rejects every model id outside the paperclip namespace", () => {
  // This proxy serves paperclip adapters only. The pre-1.4 aliases must 404 rather
  // than quietly run claude, so a client notices its config is stale.
  assert.throws(() => createRunner("claude-opus-4"), UnknownPaperclipModelError);
  assert.throws(() => createRunner("claude-max/claude-opus-4-6"), UnknownPaperclipModelError);
  assert.throws(() => createRunner("opus"), UnknownPaperclipModelError);
  assert.throws(() => createRunner("gpt-4o"), UnknownPaperclipModelError);
});

test("createRunner builds the runner with the parsed model", () => {
  // The model is injected at construction time (not per request), so this locks the
  // parse result and the runner together.
  const resolved = resolvePaperclipModel("paperclip/codex_local/gpt-5.4-mini");
  assert.equal(resolved!.cliModel, "gpt-5.4-mini");
  assert.ok(createRunner("paperclip/codex_local/gpt-5.4-mini") instanceof PaperclipRunner);
});

test("DEFAULT_MODEL is a registered adapter", () => {
  assert.ok(resolvePaperclipModel(DEFAULT_MODEL), "default must resolve");
  assert.ok(PAPERCLIP_MODEL_IDS.includes(DEFAULT_MODEL));
});

test("a healthy Claude host keeps the plain default without probing anything", async () => {
  const probed: string[] = [];
  assert.equal(
    await defaultModelForHost(true, async (cmd) => {
      probed.push(cmd);
      return true;
    }),
    DEFAULT_MODEL,
  );
  assert.deepEqual(probed, [], "a working Claude host needs no other CLI");
});

test("a host without Claude is pointed at a non-Claude adapter that runs", async () => {
  // Suggesting claude_local to a host whose Claude CLI just failed preflight
  // hands the user a first request that cannot succeed.
  const suggested = await defaultModelForHost(false, async () => true);
  const resolved = resolvePaperclipModel(suggested);
  assert.ok(resolved, `${suggested} must resolve`);
  assert.notEqual(resolved!.spec.authEngine, "claude");
});

test("an adapter is not suggested until its own CLI has been probed", async () => {
  // Claude missing does not make codex present. Suggesting an unprobed adapter
  // just swaps one guaranteed failure for another.
  const probed: string[] = [];
  const suggested = await defaultModelForHost(false, async (cmd) => {
    probed.push(cmd);
    return false;
  });

  assert.ok(probed.length > 0, "the fallback adapter's CLI must be probed");
  assert.equal(
    suggested,
    DEFAULT_MODEL,
    "with no runnable alternative, keep the primary — its install hints are the ones printed",
  );
});

test("every advertised adapter says which CLI and credential its runs spend", () => {
  // The plugin prints these verbatim during setup, so an adapter missing from
  // the list is a model the user is offered with no idea what it charges.
  const notes = adapterCredentialNotes();
  assert.equal(notes.length, PAPERCLIP_MODEL_IDS.length);

  for (const id of PAPERCLIP_MODEL_IDS) {
    const note = notes.find((n) => n.startsWith(`${id} `));
    assert.ok(note, `${id} must have a credential note`);
    assert.ok(note!.length > id.length + 10, `${id}'s note must say something`);
  }
});

test("no adapter's credential note claims another adapter's CLI", () => {
  const notes = adapterCredentialNotes();
  const claude = notes.find((n) => n.startsWith("paperclip/claude_local "))!;
  const codex = notes.find((n) => n.startsWith("paperclip/codex_local "))!;

  assert.match(claude, /Claude/);
  assert.doesNotMatch(codex, /Claude Max|Claude Code/);
  assert.match(codex, /codex/i);
});

test("every suggested setup id resolves, and each suffix stays on its own adapter", () => {
  // These are written into a host's model catalog, so a suffix filed under the
  // wrong adapter would run the other CLI rather than fail.
  const suggested = suggestedSetupModelIds();

  for (const id of PAPERCLIP_MODEL_IDS) {
    assert.ok(suggested.includes(id), `${id} must stay selectable without a suffix`);
  }

  for (const id of suggested) {
    const resolved = resolvePaperclipModel(id);
    assert.ok(resolved, `${id} is suggested but 404s`);
    const base = resolved!.cliModel ? id.slice(0, id.length - resolved!.cliModel.length - 1) : id;
    assert.equal(
      resolvePaperclipModel(base)!.spec.adapterType,
      resolved!.spec.adapterType,
      `${id} resolves to a different adapter than the one it names`,
    );
  }
});

test("a suffixed id is labelled by its adapter, not by its CLI model", () => {
  // The label goes in the host's model picker next to the id.
  assert.equal(adapterLabel("paperclip/claude_local"), "Claude Local");
  assert.equal(adapterLabel("paperclip/claude_local/opus"), "Claude Local");
  assert.equal(adapterLabel("paperclip/codex_local"), "Codex Local");
});
