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
    assert.deepStrictEqual(getProvisionedAuthEnv("claude"), {});
  });

  test("a stored credential is exposed as the env var its engine reads", () => {
    setCredential("claude", { envVar: "CLAUDE_CODE_OAUTH_TOKEN", value: "sk-ant-oat01-xyz" });
    assert.strictEqual(hasCredential("claude"), true);
    assert.deepStrictEqual(getProvisionedAuthEnv("claude"), {
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-xyz",
    });
  });

  // A credential belongs to one vendor's CLI. Handing Claude's OAuth token to the
  // codex child would expose it to an unrelated process for no reason.
  test("a credential is not exposed to any engine but its own", () => {
    setCredential("claude", { envVar: "CLAUDE_CODE_OAUTH_TOKEN", value: "sk-ant-oat01-xyz" });
    assert.deepStrictEqual(getProvisionedAuthEnv("codex"), {});
  });

  // Every runner declares its engine; one that does not gets nothing, because the
  // alternative is guessing which secret it may see.
  test("an unnamed engine gets no credential rather than all of them", () => {
    setCredential("claude", { envVar: "CLAUDE_CODE_OAUTH_TOKEN", value: "sk-ant-oat01-xyz" });
    assert.deepStrictEqual(getProvisionedAuthEnv(undefined), {});
  });

  test("re-provisioning replaces the previous credential rather than accumulating", () => {
    setCredential("claude", { envVar: "CLAUDE_CODE_OAUTH_TOKEN", value: "old" });
    setCredential("claude", { envVar: "CLAUDE_CODE_OAUTH_TOKEN", value: "new" });
    assert.deepStrictEqual(getProvisionedAuthEnv("claude"), { CLAUDE_CODE_OAUTH_TOKEN: "new" });
  });

  test("clearing removes the env var so runs fall back to host credentials", () => {
    setCredential("claude", { envVar: "CLAUDE_CODE_OAUTH_TOKEN", value: "sk-ant-oat01-xyz" });
    assert.strictEqual(clearCredential("claude"), true);
    assert.strictEqual(clearCredential("claude"), false);
    assert.strictEqual(hasCredential("claude"), false);
    assert.deepStrictEqual(getProvisionedAuthEnv("claude"), {});
  });
});
