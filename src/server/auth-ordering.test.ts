import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "./index.js";

// When auth is enabled, an unauthenticated request must be rejected BEFORE the
// JSON body parser buffers/parses it — otherwise anyone can force the server to
// parse up to the (now 30MB) body limit without a valid key. A malformed body
// with no Authorization header discriminates the ordering: body-parser-first
// fails on the syntax error (non-401); auth-first returns 401 without parsing.
test("auth runs before body parsing for unauthenticated requests", async () => {
  process.env.API_KEYS = "sk-test-ordering";
  const app = createApp();
  const server = app.listen(0);
  try {
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ this is not valid json",
    });
    assert.equal(res.status, 401, "unauthenticated request must be rejected before body parsing");
  } finally {
    server.close();
    delete process.env.API_KEYS;
  }
});
