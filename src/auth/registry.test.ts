import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { TRUST_COMPLETION_CALLERS_VAR } from "../config.js";
import { resolveEngine } from "./registry.js";
import { commandRunner, runCommand, type CommandResult, type RunCommandFn } from "./adapters/codex-api-key.js";
import { clearAllCredentials, getProvisionedAuthEnv, setCredential } from "./token-store.js";
import { AuthProvisioningError } from "./types.js";

const codexStatus = () => resolveEngine("codex")!.checkStatus();
const claudeStatus = () => resolveEngine("claude")!.checkStatus();
const CLAUDE_STATUS_ENV_VARS = [
  TRUST_COMPLETION_CALLERS_VAR,
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
] as const;
let savedClaudeStatusEnv: Record<string, string | undefined>;

test("engine lookup rejects inherited Object.prototype names", () => {
  for (const engine of ["toString", "constructor", "__proto__"]) {
    assert.strictEqual(resolveEngine(engine), null, engine);
  }
});

function stubRunner(result: CommandResult | Error): void {
  const run: RunCommandFn = async () => {
    if (result instanceof Error) throw result;
    return result;
  };
  commandRunner.run = run;
}

describe("claude flows", () => {
  // Order is the API contract: the first flow is what a caller naming none gets,
  // and existing paste-code callers must keep getting paste-code.
  test("offers paste-code (default) and api-key, both credential-injecting", () => {
    const flows = resolveEngine("claude")!.flows;
    assert.deepStrictEqual(flows.map((f) => f.flow), ["paste-code", "api-key"]);
    assert.ok(flows.every((f) => f.injectsCredential), "claude credentials only reach the CLI via injection");
  });
});

describe("claude auth status", () => {
  beforeEach(() => {
    clearAllCredentials();
    savedClaudeStatusEnv = Object.fromEntries(
      CLAUDE_STATUS_ENV_VARS.map((name) => [name, process.env[name]]),
    );
    for (const name of CLAUDE_STATUS_ENV_VARS) delete process.env[name];
  });

  afterEach(() => {
    clearAllCredentials();
    for (const name of CLAUDE_STATUS_ENV_VARS) {
      const value = savedClaudeStatusEnv[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  test("a provisioned credential is authenticated only while it can be injected", async () => {
    process.env[TRUST_COMPLETION_CALLERS_VAR] = "1";
    setCredential("claude", { envVar: "CLAUDE_CODE_OAUTH_TOKEN", value: "stored-token" });

    assert.deepStrictEqual(await claudeStatus(), {
      state: "authenticated",
      source: "provisioned",
    });
    assert.deepStrictEqual(getProvisionedAuthEnv("claude"), {
      CLAUDE_CODE_OAUTH_TOKEN: "stored-token",
    });

    delete process.env[TRUST_COMPLETION_CALLERS_VAR];

    const withheld = await claudeStatus();
    assert.strictEqual(withheld.state, "unknown");
    assert.deepStrictEqual(getProvisionedAuthEnv("claude"), {});
  });

  test("an explicit host credential remains authenticated when a stored token is withheld", async () => {
    setCredential("claude", { envVar: "CLAUDE_CODE_OAUTH_TOKEN", value: "stored-token" });
    process.env.ANTHROPIC_API_KEY = "host-key";

    assert.deepStrictEqual(await claudeStatus(), {
      state: "authenticated",
      source: "host",
      detail: "credential supplied via environment",
    });
  });
});

describe("codex auth status", () => {
  afterEach(() => {
    commandRunner.run = runCommand;
  });

  test("a clean exit is authenticated", async () => {
    stubRunner({ exitCode: 0, stdout: "Logged in using an API key", stderr: "" });
    const status = await codexStatus();
    assert.strictEqual(status.state, "authenticated");
    assert.strictEqual(status.source, "host");
    assert.strictEqual(status.detail, "Logged in using an API key");
  });

  // Positive control: the timeout fixes must not turn every failure into "unknown",
  // or the status endpoint would stop reporting a genuinely logged-out CLI.
  test("a reported failure is still unauthenticated", async () => {
    stubRunner({ exitCode: 1, stdout: "", stderr: "Not logged in" });
    const status = await codexStatus();
    assert.strictEqual(status.state, "unauthenticated");
    assert.strictEqual(status.detail, "Not logged in");
  });

  test("a timed-out check is unknown, not unauthenticated", async () => {
    stubRunner(new AuthProvisioningError("`codex login status` did not finish within 15000ms", "cli_timeout"));
    const status = await codexStatus();
    assert.strictEqual(status.state, "unknown");
    assert.match(status.detail ?? "", /did not finish within/);
  });

  test("a check killed from outside reports no verdict rather than a failure", async () => {
    stubRunner({ exitCode: null, stdout: "", stderr: "" });
    const status = await codexStatus();
    assert.strictEqual(status.state, "unknown");
  });

  test("a missing CLI names the operator problem, not the spawn error", async () => {
    stubRunner(new Error("spawn codex ENOENT"));
    const status = await codexStatus();
    assert.strictEqual(status.state, "unknown");
    assert.strictEqual(status.detail, "codex CLI not found on the service PATH");
  });
});

describe("codex_custom status", () => {
  const codexCustomStatus = () => resolveEngine("codex_custom")!.checkStatus();
  const provision = () =>
    setCredential("codex_custom", {
      envVar: "CODEX_CUSTOM_API_KEY",
      value: "sk-or-1",
      gateway: { baseUrl: "https://openrouter.ai/api/v1" },
    });

  beforeEach(() => {
    clearAllCredentials();
    process.env[TRUST_COMPLETION_CALLERS_VAR] = "1";
  });
  afterEach(() => {
    clearAllCredentials();
    delete process.env[TRUST_COMPLETION_CALLERS_VAR];
  });

  test("offers exactly one flow, and it holds the credential itself", () => {
    // There is no `codex login` for a custom provider: its table reads the key
    // from an env var, so the proxy must inject it into every run.
    const flows = resolveEngine("codex_custom")!.flows;
    assert.deepStrictEqual(flows.map((f) => f.flow), ["api-key"]);
    assert.strictEqual(flows[0].injectsCredential, true);
  });

  test("nothing provisioned is a definitive unauthenticated, not unknown", async () => {
    // Unlike claude and codex, this engine has no host-side credential store to
    // be unsure about — so telling the caller to log in is never a wrong guess.
    const status = await codexCustomStatus();
    assert.strictEqual(status.state, "unauthenticated");
    assert.match(status.detail ?? "", /No gateway provisioned/);
  });

  test("a provisioned gateway is reported with the endpoint runs will use", async () => {
    provision();
    const status = await codexCustomStatus();
    assert.strictEqual(status.state, "authenticated");
    assert.strictEqual(status.source, "provisioned");
    assert.match(status.detail ?? "", /openrouter\.ai\/api\/v1/);
  });

  test("a credential runs cannot spend is not reported as authenticated", async () => {
    provision();
    delete process.env[TRUST_COMPLETION_CALLERS_VAR];

    const status = await codexCustomStatus();
    assert.strictEqual(status.state, "unauthenticated");
    assert.match(status.detail ?? "", new RegExp(TRUST_COMPLETION_CALLERS_VAR));
  });
});
