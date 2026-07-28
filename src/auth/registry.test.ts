import { test, describe, afterEach } from "node:test";
import assert from "node:assert";
import { resolveEngine } from "./registry.js";
import { commandRunner, runCommand, type CommandResult, type RunCommandFn } from "./adapters/codex-api-key.js";
import { AuthProvisioningError } from "./types.js";

const codexStatus = () => resolveEngine("codex")!.checkStatus();

function stubRunner(result: CommandResult | Error): void {
  const run: RunCommandFn = async () => {
    if (result instanceof Error) throw result;
    return result;
  };
  commandRunner.run = run;
}

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
});
