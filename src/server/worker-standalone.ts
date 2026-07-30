#!/usr/bin/env node
import { startServer, stopServer } from "./index.js";

async function main(): Promise<void> {
  const fd = Number.parseInt(process.env.WORKER_LISTEN_FD ?? "3", 10);
  if (!Number.isSafeInteger(fd) || fd < 0) {
    throw new Error("WORKER_LISTEN_FD must be a non-negative integer");
  }
  await startServer({ fd, role: "worker" });
  const shutdown = async () => {
    await stopServer();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

main().catch((error) => {
  console.error("[Worker] Fatal:", error instanceof Error ? error.message : error);
  process.exit(1);
});
