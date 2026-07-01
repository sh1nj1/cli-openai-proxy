import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getBgWaitCeilingMs, DEFAULT_BG_WAIT_CEILING_MS } from "./config.js";

const ENV_KEY = "CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS";

describe("getBgWaitCeilingMs", () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[ENV_KEY];
  });

  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
  });

  it("defaults to no ceiling (0 = wait until subagents finish)", () => {
    delete process.env[ENV_KEY];
    assert.equal(getBgWaitCeilingMs(), DEFAULT_BG_WAIT_CEILING_MS);
    assert.equal(getBgWaitCeilingMs(), 0);
  });

  it("honors a user-set positive value", () => {
    process.env[ENV_KEY] = "1800000";
    assert.equal(getBgWaitCeilingMs(), 1800000);
  });

  it("treats 0 as valid (unlimited), not as a fallback trigger", () => {
    process.env[ENV_KEY] = "0";
    assert.equal(getBgWaitCeilingMs(), 0);
  });

  it("falls back to the default on empty or non-numeric values", () => {
    process.env[ENV_KEY] = "";
    assert.equal(getBgWaitCeilingMs(), DEFAULT_BG_WAIT_CEILING_MS);
    process.env[ENV_KEY] = "not-a-number";
    assert.equal(getBgWaitCeilingMs(), DEFAULT_BG_WAIT_CEILING_MS);
    process.env[ENV_KEY] = "-5";
    assert.equal(getBgWaitCeilingMs(), DEFAULT_BG_WAIT_CEILING_MS);
  });
});
