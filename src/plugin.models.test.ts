import { test } from "node:test";
import assert from "node:assert/strict";
import { PROVIDER_ID } from "./index.js";
import {
  defaultModelForHost,
  resolvePaperclipModel,
  suggestedSetupModelIds,
} from "./adapter/paperclip-registry.js";

test("every model the plugin offers at setup resolves to a registered adapter", () => {
  // A model the plugin registers but the proxy cannot resolve is a 404 on every
  // completion, so the two lists must not drift apart.
  const ids = suggestedSetupModelIds();
  assert.ok(ids.length > 0);
  for (const id of ids) {
    assert.ok(resolvePaperclipModel(id) !== null, `${id} is offered but not registered`);
  }
});

test("the plugin offers no legacy alias ids", () => {
  const ids = suggestedSetupModelIds();
  for (const legacy of ["claude-opus-4", "claude-sonnet-4", "claude-haiku-4"]) {
    assert.ok(!ids.includes(legacy), `${legacy} must not be advertised`);
  }
});

test("the plugin default model is a provider-qualified registered adapter", async () => {
  // Whichever host state it is asked about, the default has to be an id the
  // proxy accepts — the provider is configured with it before any request runs.
  for (const claudeOk of [true, false]) {
    const advertised = `${PROVIDER_ID}/${await defaultModelForHost(claudeOk, async () => true)}`;
    assert.ok(advertised.startsWith(`${PROVIDER_ID}/`));
    const modelId = advertised.slice(PROVIDER_ID.length + 1);
    assert.ok(
      resolvePaperclipModel(modelId) !== null,
      `${modelId} is the default but not registered`,
    );
  }
});
