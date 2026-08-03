#!/usr/bin/env node
/**
 * Standalone server for testing without Clawdbot
 *
 * Usage:
 *   npm run start
 *   # or
 *   node dist/server/standalone.js [port]
 */

import { initializeGatewaySecurity, startServer, stopServer } from "./index.js";
import { verifyClaude, verifyAuth } from "../cli/claude.js";
import { runPreflight } from "./preflight.js";
import { PKG_VERSION, getTimeoutMs } from "../config.js";
import { defaultModelForHost } from "../adapter/paperclip-registry.js";
import { userWorkerModeEnabled } from "../config.js";
import { createPlatformProvisioner } from "../isolation/provisioner-client.js";
import { UserWorkerProxy } from "../isolation/worker-proxy.js";

const DEFAULT_PORT = 3456;

async function main(): Promise<void> {
  console.log(`\ncli-openai-proxy v${PKG_VERSION}`);
  console.log("=".repeat(40));

  // Parse port and host from command line / environment
  const port = parseInt(process.env.PORT || process.argv[2] || String(DEFAULT_PORT), 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    console.error(`Invalid port: ${process.env.PORT || process.argv[2]}`);
    process.exit(1);
  }
  const host = process.env.HOST || "127.0.0.1";
  const displayHost = host === "0.0.0.0" ? "localhost" : host;
  const baseUrl = `http://${displayHost}:${port}`;

  // Capture gateway-only credentials before preflight launches any CLI child.
  // createApp re-initializes from the in-memory capture when the listener starts.
  const perUserWorkers = userWorkerModeEnabled();
  const security = initializeGatewaySecurity(perUserWorkers);

  // Preflight. Claude CLI / auth are non-fatal: the proxy also serves
  // non-Claude adapter models (e.g. paperclip/codex_local),
  // so a codex-only host must still be able to start. Missing Claude is
  // surfaced as a warning; a claude-targeted request fails cleanly at request
  // time instead.
  console.log("\n[Preflight]");
  const { claudeOk } = perUserWorkers
    ? { claudeOk: true }
    : await runPreflight({
        verifyClaude,
        verifyAuth,
        log: (m) => console.log(m),
        warn: (m) => console.error(m),
      });
  if (perUserWorkers) {
    console.log("  Skipped gateway CLI probe; CLIs run only inside user workers.");
  }

  // Show configuration
  console.log("\n[Config]");
  console.log(`  Host:      ${host}`);
  console.log(`  Port:      ${port}`);
  console.log(`  API keys:  ${security.auth.enabled ? "enabled" : "disabled (open access)"}`);
  console.log(`  Debug:     ${process.env.DEBUG ? "enabled" : "disabled"}`);
  const timeoutMs = getTimeoutMs();
  console.log(`  Timeout:   ${timeoutMs}ms (${(timeoutMs / 60000).toFixed(1)} min)`);

  // Show CLI command template
  console.log("\n[CLI Command]");
  console.log("  claude --print --output-format stream-json --verbose \\");
  console.log("    --include-partial-messages --model <model> \\");
  console.log("    --no-session-persistence --dangerously-skip-permissions");

  // Start server
  try {
    const userWorkerProxy = perUserWorkers
      ? new UserWorkerProxy(createPlatformProvisioner())
      : undefined;
    await startServer({ port, host, userWorkerProxy });

    console.log("\n[Endpoints]");
    console.log(`  POST ${baseUrl}/v1/chat/completions`);
    console.log(`  GET  ${baseUrl}/v1/models`);
    console.log(`  GET  ${baseUrl}/v1/usage`);
    console.log(`  GET  ${baseUrl}/v1/usage/recent`);
    console.log(`  GET  ${baseUrl}/health`);
    if (security.admin.enabled) console.log(`  GET  ${baseUrl}/auth`);

    console.log("\n[Test]");
    console.log(`  curl -s ${baseUrl}/health | jq .`);
    console.log(`  curl -X POST ${baseUrl}/v1/chat/completions \\`);
    console.log(`    -H "Content-Type: application/json" \\`);
    // Taken from the registry, not spelled out: the proxy 404s any id it cannot
    // resolve, so a hand-written example here goes stale into a broken command.
    // It also follows preflight, so a codex-only host is not shown a copy-paste
    // command whose CLI was just reported missing.
    console.log(
      `    -d '{"model": "${await defaultModelForHost(claudeOk)}", "messages": [{"role": "user", "content": "Hello!"}]}'`,
    );
    console.log("\nReady. Press Ctrl+C to stop.\n");
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }

  // Handle graceful shutdown
  const shutdown = async () => {
    console.log("\nShutting down...");
    await stopServer();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
