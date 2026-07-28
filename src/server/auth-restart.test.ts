/**
 * The exported server can be restarted in-process (startServer → stopServer →
 * startServer, and the plugin's claude-cli:start / claude-cli:stop commands), so
 * createApp() — and with it initAuth / initAuthAdmin — runs more than once per
 * process. Initialization takes its keys out of the environment, so a second run
 * must answer from the capture rather than from the environment it emptied.
 *
 * Own file: the capture is module state, and a sibling test that boots with keys
 * would seed it. node:test gives each file its own process.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Express } from "express";
import { createApp } from "./index.js";

async function listen(app: Express): Promise<{ server: Server; port: number }> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  return { server, port: (server.address() as AddressInfo).port };
}

test("completion auth survives an in-process restart", async () => {
  process.env.API_KEYS = "sk-restart";

  createApp(); // first boot: consumes API_KEYS out of the environment
  assert.equal("API_KEYS" in process.env, false, "boot must still remove the variable");

  const { server, port } = await listen(createApp()); // the restart
  try {
    const unauthenticated = await fetch(`http://127.0.0.1:${port}/v1/models`);
    assert.equal(
      unauthenticated.status,
      401,
      "a restart must not reopen the completion routes to unauthenticated callers",
    );

    const authenticated = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers: { Authorization: "Bearer sk-restart" },
    });
    assert.equal(authenticated.status, 200, "the operator's configured key must still be accepted");
  } finally {
    server.close();
    delete process.env.API_KEYS;
  }
});

test("auth provisioning stays enabled across an in-process restart", async () => {
  process.env.AUTH_ADMIN_KEYS = "admin-restart";

  createApp();
  const { server, port } = await listen(createApp());
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/auth/engines`, {
      headers: { Authorization: "Bearer admin-restart" },
    });
    // 404 here would mean the fail-closed gate decided the operator never opted
    // in — losing the surface the restart was supposed to preserve.
    assert.equal(res.status, 200, "the admin key must still open the provisioning surface");
  } finally {
    server.close();
    delete process.env.AUTH_ADMIN_KEYS;
  }
});
