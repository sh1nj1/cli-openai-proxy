import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getBgWaitCeilingMs, DEFAULT_BG_WAIT_CEILING_MS, getTimeoutMs, DEFAULT_TIMEOUT_MS } from "./config.js";

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

describe("getTimeoutMs", () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env.TIMEOUT;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.TIMEOUT;
    else process.env.TIMEOUT = original;
  });

  it("defaults to no timeout (0 = run until the subprocess exits)", () => {
    delete process.env.TIMEOUT;
    assert.equal(getTimeoutMs(), DEFAULT_TIMEOUT_MS);
    assert.equal(getTimeoutMs(), 0);
  });

  it("honors a user-set positive bound", () => {
    process.env.TIMEOUT = "6000000";
    assert.equal(getTimeoutMs(), 6000000);
  });

  it("falls back to no timeout on empty, zero, or invalid values", () => {
    process.env.TIMEOUT = "";
    assert.equal(getTimeoutMs(), DEFAULT_TIMEOUT_MS);
    process.env.TIMEOUT = "0";
    assert.equal(getTimeoutMs(), DEFAULT_TIMEOUT_MS);
    process.env.TIMEOUT = "not-a-number";
    assert.equal(getTimeoutMs(), DEFAULT_TIMEOUT_MS);
  });
});
