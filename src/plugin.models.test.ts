import { test } from "node:test";
import assert from "node:assert/strict";
import { PLUGIN_MODELS, pluginDefaultModel, PROVIDER_ID } from "./index.js";
import { resolvePaperclipModel } from "./adapter/paperclip-registry.js";

test("every model the plugin advertises resolves to a registered adapter", () => {
  // A model the plugin advertises but the proxy cannot resolve is a 404 on every
  // completion, so the two lists must not drift apart.
  assert.ok(PLUGIN_MODELS.length > 0);
  for (const model of PLUGIN_MODELS) {
    assert.ok(
      resolvePaperclipModel(model.id) !== null,
      `${model.id} is advertised but not registered`,
    );
  }
});

test("the plugin advertises no legacy alias ids", () => {
  const ids = PLUGIN_MODELS.map((m) => m.id);
  for (const legacy of ["claude-opus-4", "claude-sonnet-4", "claude-haiku-4"]) {
    assert.ok(!ids.includes(legacy), `${legacy} must not be advertised`);
  }
});

test("the plugin default model is a provider-qualified registered adapter", () => {
  // Whichever host state it is asked about, the default has to be an id the
  // proxy accepts — the provider is configured with it before any request runs.
  for (const claudeOk of [true, false]) {
    const advertised = pluginDefaultModel(claudeOk);
    assert.ok(advertised.startsWith(`${PROVIDER_ID}/`));
    const modelId = advertised.slice(PROVIDER_ID.length + 1);
    assert.ok(
      resolvePaperclipModel(modelId) !== null,
      `${modelId} is the default but not registered`,
    );
  }
});
