#!/usr/bin/env node
/**
 * Standalone server for testing without Clawdbot
 *
 * Usage:
 *   npm run start
 *   # or
 *   node dist/server/standalone.js [port]
 */

import { startServer, stopServer } from "./index.js";
import { verifyClaude, verifyAuth } from "../subprocess/manager.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const DEFAULT_PORT = 3456;

function getVersion(): string {
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "../../package.json"), "utf-8"));
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  const version = getVersion();

  console.log(`\nclaude-max-api-proxy v${version}`);
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

  // Verify Claude CLI
  console.log("\n[Preflight]");
  console.log("  Checking Claude CLI...");
  const cliCheck = await verifyClaude();
  if (!cliCheck.ok) {
    console.error(`  ✗ Claude CLI: ${cliCheck.error}`);
    process.exit(1);
  }
  console.log(`  ✓ Claude CLI: ${cliCheck.version || "OK"}`);

  // Verify authentication
  console.log("  Checking authentication...");
  const authCheck = await verifyAuth();
  if (!authCheck.ok) {
    console.error(`  ✗ Auth: ${authCheck.error}`);
    console.error("    Run: claude auth login");
    process.exit(1);
  }
  console.log("  ✓ Authentication: OK");

  // Show configuration
  console.log("\n[Config]");
  console.log(`  Host:      ${host}`);
  console.log(`  Port:      ${port}`);
  console.log(`  API keys:  ${process.env.API_KEYS ? "enabled" : "disabled (open access)"}`);
  console.log(`  Debug:     ${process.env.DEBUG ? "enabled" : "disabled"}`);
  console.log(`  Timeout:   ${process.env.TIMEOUT || "600000"}ms`);

  // Show CLI command template
  console.log("\n[CLI Command]");
  console.log("  claude --print --output-format stream-json --verbose \\");
  console.log("    --include-partial-messages --model <model> \\");
  console.log("    --no-session-persistence --dangerously-skip-permissions");

  // Start server
  try {
    await startServer({ port, host });

    console.log("\n[Endpoints]");
    console.log(`  POST ${baseUrl}/v1/chat/completions`);
    console.log(`  GET  ${baseUrl}/v1/models`);
    console.log(`  GET  ${baseUrl}/v1/usage`);
    console.log(`  GET  ${baseUrl}/v1/usage/recent`);
    console.log(`  GET  ${baseUrl}/health`);

    console.log("\n[Test]");
    console.log(`  curl -s ${baseUrl}/health | jq .`);
    console.log(`  curl -X POST ${baseUrl}/v1/chat/completions \\`);
    console.log(`    -H "Content-Type: application/json" \\`);
    console.log(`    -d '{"model": "claude-sonnet-4", "messages": [{"role": "user", "content": "Hello!"}]}'`);
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
