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
    startServer: async (opts) => {
      started.push(opts.port);
    },
  });

  assert.deepEqual(started, [3456]);
  assert.equal(port, 3456);
  assert.equal(auth.defaultModel.startsWith(`${PROVIDER_ID}/`), true);

  const advertised = auth.configPatch.models.providers[PROVIDER_ID].models.map(
    (m: { id: string }) => m.id,
  );
  assert.deepEqual(advertised, PLUGIN_MODELS.map((m) => m.id));
  assert.ok(advertised.includes("paperclip/codex_local"));

  // The user still has to be told Claude-backed models will not work.
  assert.equal(notes.length, 1);
  assert.match(notes[0].message, /claude/i);
});

test("setup completes when Claude auth is missing", async () => {
  const notes: Note[] = [];
  const started: number[] = [];

  await runLocalAuthSetup(fakeCtx(notes), {
    verifyClaude: async () => ({ ok: true, version: "2.1.218" }),
    verifyAuth: async () => ({ ok: false, error: "not logged in" }),
    startServer: async (opts) => {
      started.push(opts.port);
    },
  });

  assert.deepEqual(started, [3456]);
  assert.equal(notes.length, 1);
  assert.match(notes[0].message, /claude auth login/i);
});

test("setup warns about nothing when Claude is fully available", async () => {
  const notes: Note[] = [];

  const { auth } = await runLocalAuthSetup(fakeCtx(notes), {
    verifyClaude: async () => ({ ok: true, version: "2.1.218" }),
    verifyAuth: async () => ({ ok: true }),
    startServer: async () => {},
  });

  assert.deepEqual(notes, []);
  assert.ok(auth.profiles.length > 0);
});

test("a failing server start still fails setup", async () => {
  // Preflight is advisory; the server itself is not.
  await assert.rejects(
    runLocalAuthSetup(fakeCtx([]), {
      verifyClaude: async () => ({ ok: true, version: "2.1.218" }),
      verifyAuth: async () => ({ ok: true }),
      startServer: async () => {
        throw new Error("EADDRINUSE");
      },
    }),
    /EADDRINUSE/,
  );
});
