import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  getBgWaitCeilingMs,
  DEFAULT_BG_WAIT_CEILING_MS,
  getTimeoutMs,
  DEFAULT_TIMEOUT_MS,
  PROXY_ONLY_SECRET_VARS,
  takeProxySecret,
  blankedProxySecrets,
  resetCapturedProxySecrets,
  getProvisionerEndpoint,
  getWorkerConnectTimeoutMs,
  userWorkerModeEnabled,
} from "./config.js";

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

/**
 * The keys that authenticate callers TO the proxy must not be inherited by the
 * CLI children a completion spawns: those run with permissions skipped, so a
 * caller can simply ask the model to print its environment.
 */
describe("proxy-only secrets", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of PROXY_ONLY_SECRET_VARS) saved[key] = process.env[key];
    // The capture is module state and now outlives a take; without this a case
    // would read the value a previous one captured.
    resetCapturedProxySecrets();
  });

  afterEach(() => {
    for (const key of PROXY_ONLY_SECRET_VARS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    resetCapturedProxySecrets();
  });

  it("takeProxySecret returns the value and removes it from the environment", () => {
    process.env.AUTH_ADMIN_KEYS = "admin-1,admin-2";
    assert.equal(takeProxySecret("AUTH_ADMIN_KEYS"), "admin-1,admin-2");
    assert.equal(
      "AUTH_ADMIN_KEYS" in process.env,
      false,
      "the variable must be gone, not merely emptied — a child inherits either way",
    );
  });

  it("takeProxySecret is a no-op for an unset variable", () => {
    delete process.env.API_KEYS;
    assert.equal(takeProxySecret("API_KEYS"), undefined);
  });

  it("takeProxySecret answers from the capture once the variable is gone", () => {
    process.env.API_KEYS = "sk-one";
    takeProxySecret("API_KEYS");

    assert.equal(
      takeProxySecret("API_KEYS"),
      "sk-one",
      "a re-init must not see nothing merely because the first init removed the variable",
    );
    assert.equal("API_KEYS" in process.env, false, "and it must stay out of the environment");
  });

  it("takeProxySecret prefers a value re-set after the capture", () => {
    process.env.API_KEYS = "sk-one";
    takeProxySecret("API_KEYS");

    process.env.API_KEYS = "sk-two";
    assert.equal(takeProxySecret("API_KEYS"), "sk-two", "an operator re-setting the variable means to change the keys");
    assert.equal(takeProxySecret("API_KEYS"), "sk-two", "and the capture now holds the newer value");
  });

  it("blankedProxySecrets shadows every proxy-only key with an empty value", () => {
    const blanked = blankedProxySecrets();
    for (const key of PROXY_ONLY_SECRET_VARS) assert.equal(blanked[key], "");
  });
});

describe("per-user worker configuration", () => {
  const keys = [
    "USER_WORKER_MODE",
    "USER_WORKER_PROVISIONER_ENDPOINT",
    "USER_WORKER_CONNECT_TIMEOUT_MS",
  ] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of keys) saved[key] = process.env[key];
  });

  afterEach(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("enables worker mode only for explicit affirmative values", () => {
    delete process.env.USER_WORKER_MODE;
    assert.equal(userWorkerModeEnabled(), false);
    process.env.USER_WORKER_MODE = " Enabled ";
    assert.equal(userWorkerModeEnabled(), true);
    process.env.USER_WORKER_MODE = "off";
    assert.equal(userWorkerModeEnabled(), false);
  });

  it("selects platform IPC defaults and honors an override", () => {
    delete process.env.USER_WORKER_PROVISIONER_ENDPOINT;
    assert.equal(getProvisionerEndpoint("linux"), "/run/cli-openai-proxy/provisioner.sock");
    assert.equal(getProvisionerEndpoint("win32"), "\\\\.\\pipe\\cli-openai-proxy-provisioner");
    process.env.USER_WORKER_PROVISIONER_ENDPOINT = " /tmp/custom.sock ";
    assert.equal(getProvisionerEndpoint("linux"), "/tmp/custom.sock");
  });

  it("validates the worker connection timeout", () => {
    delete process.env.USER_WORKER_CONNECT_TIMEOUT_MS;
    assert.equal(getWorkerConnectTimeoutMs(), 15_000);
    process.env.USER_WORKER_CONNECT_TIMEOUT_MS = "2500";
    assert.equal(getWorkerConnectTimeoutMs(), 2500);
    for (const invalid of ["0", "-1", "not-a-number"]) {
      process.env.USER_WORKER_CONNECT_TIMEOUT_MS = invalid;
      assert.equal(getWorkerConnectTimeoutMs(), 15_000);
    }
  });
});
