import { test } from "node:test";
import assert from "node:assert/strict";
import { runLocalAuthSetup, PLUGIN_MODELS, PROVIDER_ID } from "./index.js";

interface Note {
  message: string;
  title: string;
}

function fakeCtx(notes: Note[]) {
  return {
    prompter: {
      progress: () => ({ message: () => {}, stop: () => {} }),
      note: async (message: string, title: string) => {
        notes.push({ message, title });
      },
      text: async () => "3456",
    },
  };
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

  const advertised = auth.configPatch.models.providers[PROVIDER_ID].models.map(
    (m: { id: string }) => m.id,
  );
  assert.deepEqual(advertised, PLUGIN_MODELS.map((m) => m.id));
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
  for (const model of PLUGIN_MODELS) {
    assert.ok(
      notes.some((n) => n.startsWith(`${model.id} `)),
      `${model.id} is advertised but never described`,
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
