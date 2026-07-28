import { test, describe, beforeEach } from "node:test";
import assert from "node:assert";
import {
  clearAllCredentials,
  clearCredential,
  getProvisionedAuthEnv,
  hasCredential,
  setCredential,
} from "./token-store.js";

describe("token-store", () => {
  beforeEach(() => clearAllCredentials());

  test("no provisioned credential contributes no env, so host auth is untouched", () => {
    assert.deepStrictEqual(getProvisionedAuthEnv(), {});
  });

  test("a stored credential is exposed as the env var its engine reads", () => {
    setCredential("claude", { envVar: "CLAUDE_CODE_OAUTH_TOKEN", value: "sk-ant-oat01-xyz" });
    assert.strictEqual(hasCredential("claude"), true);
    assert.deepStrictEqual(getProvisionedAuthEnv(), { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-xyz" });
  });

  test("re-provisioning replaces the previous credential rather than accumulating", () => {
    setCredential("claude", { envVar: "CLAUDE_CODE_OAUTH_TOKEN", value: "old" });
    setCredential("claude", { envVar: "CLAUDE_CODE_OAUTH_TOKEN", value: "new" });
    assert.deepStrictEqual(getProvisionedAuthEnv(), { CLAUDE_CODE_OAUTH_TOKEN: "new" });
  });

  test("clearing removes the env var so runs fall back to host credentials", () => {
    setCredential("claude", { envVar: "CLAUDE_CODE_OAUTH_TOKEN", value: "sk-ant-oat01-xyz" });
    assert.strictEqual(clearCredential("claude"), true);
    assert.strictEqual(clearCredential("claude"), false);
    assert.strictEqual(hasCredential("claude"), false);
    assert.deepStrictEqual(getProvisionedAuthEnv(), {});
  });
});
