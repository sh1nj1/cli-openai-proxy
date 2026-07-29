import { test } from "node:test";
import assert from "node:assert/strict";
import { runLocalAuthSetup, PROVIDER_ID } from "./index.js";
import {
  PAPERCLIP_MODEL_IDS,
  resolvePaperclipModel,
} from "./adapter/paperclip-registry.js";

interface Note {
  message: string;
  title: string;
}

interface TextPrompt {
  message: string;
  initialValue?: string;
  validate?: (value: string) => string | undefined;
}

/**
 * Answers each prompt with its own default unless the test overrides it by
 * message substring, so a new prompt cannot silently receive another's answer.
 */
function fakeCtx(notes: Note[], answers: Record<string, string> = {}, prompts: TextPrompt[] = []) {
  return {
    prompter: {
      progress: () => ({ message: () => {}, stop: () => {} }),
      note: async (message: string, title: string) => {
        notes.push({ message, title });
      },
      text: async (opts: TextPrompt) => {
        prompts.push(opts);
        const override = Object.entries(answers).find(([key]) => opts.message.includes(key));
        return override ? override[1] : (opts.initialValue ?? "");
      },
    },
  };
}

function registeredIds(auth: any): string[] {
  return auth.configPatch.models.providers[PROVIDER_ID].models.map((m: { id: string }) => m.id);
}

function allowlistKeys(auth: any): string[] {
  return Object.keys(auth.configPatch.agents.defaults.models);
}

test("setup completes on a codex-only host (no Claude CLI)", async () => {
  // The provider advertises paperclip/codex_local, so a host with only the
  // codex CLI must be able to finish setup; blocking here would make every
  // advertised codex model unreachable.
  const notes: Note[] = [];
  const started: number[] = [];

  const { port, auth } = await runLocalAuthSetup(fakeCtx(notes), {
    verifyClaude: async () => ({ ok: false, error: "not found on PATH" }),
    verifyAuth: async () => ({ ok: true }),
    commandRuns: async (cmd) => cmd === "codex",
    startServer: async (opts) => {
      started.push(opts.port);
    },
  });

  assert.deepEqual(started, [3456]);
  assert.equal(port, 3456);
  // Defaulting to the adapter whose CLI just failed preflight would make the
  // provider's very first completion fail on a host that is otherwise usable.
  assert.equal(auth.defaultModel, `${PROVIDER_ID}/paperclip/codex_local`);

  const advertised = registeredIds(auth);
  for (const id of PAPERCLIP_MODEL_IDS) {
    assert.ok(advertised.includes(id), `${id} is not registered`);
  }
  assert.ok(advertised.includes("paperclip/codex_local"));

  // The user still has to be told Claude-backed models will not work.
  assert.equal(notes.length, 1);
  assert.match(notes[0].message, /claude/i);
});

test("setup notes describe the CLI behind the model that was actually selected", async () => {
  // Telling a codex-only host that its requests run on a Claude Max subscription
  // names the wrong subscription, the wrong CLI, and the wrong login to fix.
  const { auth } = await runLocalAuthSetup(fakeCtx([]), {
    verifyClaude: async () => ({ ok: false, error: "not found on PATH" }),
    verifyAuth: async () => ({ ok: true }),
    commandRuns: async (cmd) => cmd === "codex",
    startServer: async () => {},
  });

  const notes: string[] = auth.notes;
  assert.equal(auth.defaultModel, `${PROVIDER_ID}/paperclip/codex_local`);
  assert.ok(
    notes.some((n) => n.includes(auth.defaultModel)),
    "the notes must name the default the provider was configured with",
  );
  assert.ok(
    !notes.some((n) => /Claude Max/i.test(n) && !n.startsWith("paperclip/claude_local")),
    "no note may claim Claude Max for a request that runs codex",
  );
});

test("setup notes cover every advertised adapter on any host", async () => {
  // Both adapters stay selectable whatever the default is, so both have to say
  // what they spend — the Claude host is where the codex line used to go missing.
  const { auth } = await runLocalAuthSetup(fakeCtx([]), {
    verifyClaude: async () => ({ ok: true, version: "2.1.218" }),
    verifyAuth: async () => ({ ok: true }),
    commandRuns: async () => true,
    startServer: async () => {},
  });

  const notes: string[] = auth.notes;
  for (const id of PAPERCLIP_MODEL_IDS) {
    assert.ok(
      notes.some((n) => n.startsWith(`${id} `)),
      `${id} is advertised but never described`,
    );
  }
});

test("setup completes when Claude auth is missing", async () => {
  const notes: Note[] = [];
  const started: number[] = [];

  await runLocalAuthSetup(fakeCtx(notes), {
    verifyClaude: async () => ({ ok: true, version: "2.1.218" }),
    verifyAuth: async () => ({ ok: false, error: "not logged in" }),
    commandRuns: async (cmd) => cmd === "codex",
    startServer: async (opts) => {
      started.push(opts.port);
    },
  });

  assert.deepEqual(started, [3456]);
  assert.equal(notes.length, 1);
  assert.match(notes[0].message, /claude auth login/i);
});

test("a host with no working CLI at all is not sent to an absent one", async () => {
  // Claude missing does not imply codex present. Naming codex here would state
  // something the setup never checked, and the first completion fails either way.
  const notes: Note[] = [];

  const { auth } = await runLocalAuthSetup(fakeCtx(notes), {
    verifyClaude: async () => ({ ok: false, error: "not found on PATH" }),
    verifyAuth: async () => ({ ok: true }),
    commandRuns: async () => false,
    startServer: async () => {},
  });

  assert.equal(auth.defaultModel, `${PROVIDER_ID}/paperclip/claude_local`);
  assert.equal(notes.length, 1);
  assert.doesNotMatch(notes[0].message, /codex_local instead/i);
  assert.match(notes[0].message, /npm install -g @anthropic-ai\/claude-code/);
});

test("setup warns about nothing when Claude is fully available", async () => {
  const notes: Note[] = [];

  const { auth } = await runLocalAuthSetup(fakeCtx(notes), {
    verifyClaude: async () => ({ ok: true, version: "2.1.218" }),
    verifyAuth: async () => ({ ok: true }),
    commandRuns: async () => true,
    startServer: async () => {},
  });

  assert.deepEqual(notes, []);
  assert.ok(auth.profiles.length > 0);
  assert.equal(auth.defaultModel, `${PROVIDER_ID}/paperclip/claude_local`);
});

test("a suffixed CLI model is registered in both the catalog and the allowlist", async () => {
  // The host enumerates selectable models: `agents.defaults.models` is its
  // allowlist and the provider's `models` list is its catalog. A suffix that
  // reaches neither cannot be picked, however well the proxy resolves it.
  const { auth } = await runLocalAuthSetup(
    fakeCtx([], { "Models to register": "paperclip/claude_local, paperclip/claude_local/opus" }),
    {
      verifyClaude: async () => ({ ok: true, version: "2.1.218" }),
      verifyAuth: async () => ({ ok: true }),
      commandRuns: async () => true,
      startServer: async () => {},
    },
  );

  assert.ok(registeredIds(auth).includes("paperclip/claude_local/opus"));
  assert.ok(allowlistKeys(auth).includes(`${PROVIDER_ID}/paperclip/claude_local/opus`));
});

test("the suggested answer already covers the documented suffix form", async () => {
  // Taking the default answer is the common path, so the suffix syntax has to
  // work without the user knowing to type one.
  const prompts: TextPrompt[] = [];
  const { auth } = await runLocalAuthSetup(fakeCtx([], {}, prompts), {
    verifyClaude: async () => ({ ok: true, version: "2.1.218" }),
    verifyAuth: async () => ({ ok: true }),
    commandRuns: async () => true,
    startServer: async () => {},
  });

  const ids = registeredIds(auth);
  assert.ok(
    ids.some((id) => resolvePaperclipModel(id)?.cliModel),
    "no CLI model is selectable by default",
  );
  for (const id of ids) {
    assert.ok(resolvePaperclipModel(id) !== null, `${id} is registered but 404s`);
  }
  assert.deepEqual(
    allowlistKeys(auth),
    ids.map((id) => `${PROVIDER_ID}/${id}`),
    "catalog and allowlist must not drift",
  );
  assert.ok(prompts.some((p) => p.message.includes("Models to register")));
});

test("setup rejects a model id the proxy would 404", async () => {
  // Catching it here beats a first request that fails against a config the
  // setup itself wrote.
  const prompts: TextPrompt[] = [];
  await runLocalAuthSetup(fakeCtx([], {}, prompts), {
    verifyClaude: async () => ({ ok: true, version: "2.1.218" }),
    verifyAuth: async () => ({ ok: true }),
    commandRuns: async () => true,
    startServer: async () => {},
  });

  const validate = prompts.find((p) => p.message.includes("Models to register"))?.validate;
  assert.ok(validate, "the model prompt must validate its input");
  assert.equal(validate("paperclip/claude_local/opus, paperclip/codex_local"), undefined);
  assert.match(validate("anthropic/claude-opus-4-6") ?? "", /paperclip/);
  assert.ok(validate("") !== undefined);
});

test("the default model is registered even when the user drops it", async () => {
  // The default is applied to the host config regardless of this list, so
  // leaving it out of the allowlist would reject the provider's own default.
  const { auth } = await runLocalAuthSetup(
    fakeCtx([], { "Models to register": "paperclip/codex_local" }),
    {
      verifyClaude: async () => ({ ok: true, version: "2.1.218" }),
      verifyAuth: async () => ({ ok: true }),
      commandRuns: async () => true,
      startServer: async () => {},
    },
  );

  assert.equal(auth.defaultModel, `${PROVIDER_ID}/paperclip/claude_local`);
  assert.ok(registeredIds(auth).includes("paperclip/claude_local"));
  assert.ok(allowlistKeys(auth).includes(auth.defaultModel));
});

test("a failing server start still fails setup", async () => {
  // Preflight is advisory; the server itself is not.
  await assert.rejects(
    runLocalAuthSetup(fakeCtx([]), {
      verifyClaude: async () => ({ ok: true, version: "2.1.218" }),
      verifyAuth: async () => ({ ok: true }),
      commandRuns: async () => true,
      startServer: async () => {
        throw new Error("EADDRINUSE");
      },
    }),
    /EADDRINUSE/,
  );
});
