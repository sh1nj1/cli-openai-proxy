import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isClaudeAuthRequired } from "./claude-auth-detect.js";

describe("claude-auth-detect", () => {
  // Wordings the CLI actually uses when it has no usable credentials.
  for (const text of [
    "Invalid API key · Please run /login",
    "Not logged in. Run `claude login` to continue.",
    "Error: unauthorized",
    "authentication required",
    "OAuth token expired",
  ]) {
    test(`recognises: ${text}`, () => {
      assert.equal(isClaudeAuthRequired(text), true);
    });
  }

  // Would otherwise turn an ordinary answer into a 401 for anyone asking about auth.
  for (const text of [
    "Here is how to store an invalid API key safely in your config.",
    "The login page renders a form.",
    "Claude usage limit reached",
    "",
  ]) {
    test(`does not fire on: ${text || "(empty)"}`, () => {
      assert.equal(isClaudeAuthRequired(text), false);
    });
  }

  test("scans every candidate text, not just the first", () => {
    assert.equal(isClaudeAuthRequired("", null, undefined, "please run /login"), true);
    assert.equal(isClaudeAuthRequired(null, undefined), false);
  });
});
