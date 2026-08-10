import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { TRUST_COMPLETION_CALLERS_VAR } from "../config.js";
import {
  clearAllCredentials,
  clearCredential,
  getProvisionedAuthEnv,
  getProvisionedGateway,
  hasCredential,
  hasInjectableCredential,
  setCredential,
} from "./token-store.js";

describe("token-store", () => {
  // Injection is refused unless the operator has declared completion callers
  // trusted, so every case about *what* is injected has to declare it first.
  beforeEach(() => {
    clearAllCredentials();
    process.env[TRUST_COMPLETION_CALLERS_VAR] = "1";
  });
  afterEach(() => {
    delete process.env[TRUST_COMPLETION_CALLERS_VAR];
  });

  test("no provisioned credential contributes no env, so host auth is untouched", () => {
    assert.deepStrictEqual(getProvisionedAuthEnv("claude"), {});
  });

  test("a stored credential is exposed as the env var its engine reads", () => {
    setCredential("claude", { envVar: "CLAUDE_CODE_OAUTH_TOKEN", value: "sk-ant-oat01-xyz" });
    assert.strictEqual(hasCredential("claude"), true);
    assert.strictEqual(hasInjectableCredential("claude"), true);
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

  // The child's exec-time environment is readable by whoever wrote the prompt, so
  // a stored credential stays out of it until the operator says those callers are
  // trusted. Enforced here and not only at provisioning time.
  test("a stored credential is NOT injected unless completion callers are declared trusted", () => {
    setCredential("claude", { envVar: "CLAUDE_CODE_OAUTH_TOKEN", value: "sk-ant-oat01-xyz" });
    delete process.env[TRUST_COMPLETION_CALLERS_VAR];
    assert.deepStrictEqual(getProvisionedAuthEnv("claude"), {});
    // Still stored — the credential is withheld from children, not discarded.
    assert.strictEqual(hasCredential("claude"), true);
    assert.strictEqual(hasInjectableCredential("claude"), false);
  });

  test("only an affirmative declaration opens injection", () => {
    setCredential("claude", { envVar: "CLAUDE_CODE_OAUTH_TOKEN", value: "v" });
    for (const raw of ["0", "false", "no", "", "  "]) {
      process.env[TRUST_COMPLETION_CALLERS_VAR] = raw;
      assert.deepStrictEqual(getProvisionedAuthEnv("claude"), {}, `raw=${JSON.stringify(raw)}`);
    }
    for (const raw of ["1", "true", "YES", " True "]) {
      process.env[TRUST_COMPLETION_CALLERS_VAR] = raw;
      assert.deepStrictEqual(
        getProvisionedAuthEnv("claude"),
        { CLAUDE_CODE_OAUTH_TOKEN: "v" },
        `raw=${JSON.stringify(raw)}`,
      );
    }
  });

  test("clearing removes the env var so runs fall back to host credentials", () => {
    setCredential("claude", { envVar: "CLAUDE_CODE_OAUTH_TOKEN", value: "sk-ant-oat01-xyz" });
    assert.strictEqual(clearCredential("claude"), true);
    assert.strictEqual(clearCredential("claude"), false);
    assert.strictEqual(hasCredential("claude"), false);
    assert.deepStrictEqual(getProvisionedAuthEnv("claude"), {});
  });

  test("a credential's gateway travels with it, and only with it", () => {
    assert.strictEqual(getProvisionedGateway("codex_custom"), null);

    setCredential("codex_custom", {
      envVar: "CODEX_CUSTOM_API_KEY",
      value: "sk-or-1",
      gateway: { baseUrl: "https://openrouter.ai/api/v1" },
    });
    assert.deepStrictEqual(getProvisionedGateway("codex_custom"), {
      baseUrl: "https://openrouter.ai/api/v1",
    });
    // Routing is as engine-scoped as the key: no other adapter may be pointed at it.
    assert.strictEqual(getProvisionedGateway("codex"), null);

    // Forgetting the key forgets where it was spent — never a half-provisioned
    // engine that still reports somewhere to send requests.
    clearCredential("codex_custom");
    assert.strictEqual(getProvisionedGateway("codex_custom"), null);
  });

  test("an undeclared trust boundary withholds the gateway as well as the key", () => {
    // Otherwise a run could be routed at a gateway it has no key for.
    setCredential("codex_custom", {
      envVar: "CODEX_CUSTOM_API_KEY",
      value: "sk-or-1",
      gateway: { baseUrl: "https://openrouter.ai/api/v1" },
    });
    delete process.env[TRUST_COMPLETION_CALLERS_VAR];

    assert.strictEqual(getProvisionedGateway("codex_custom"), null);
    assert.deepStrictEqual(getProvisionedAuthEnv("codex_custom"), {});
  });
});
