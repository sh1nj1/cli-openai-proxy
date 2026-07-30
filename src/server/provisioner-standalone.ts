#!/usr/bin/env node
import {
  LinuxUserProvisioner,
  linuxProvisionerConfigFromEnv,
} from "../isolation/linux-user-provisioner.js";
import { startProvisionerServer } from "../isolation/provisioner-server.js";

async function main(): Promise<void> {
  if (process.platform !== "linux") {
    throw new Error("The built-in dynamic OS user provisioner currently supports Linux only");
  }
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    throw new Error("The Linux user provisioner must run as root");
  }
  const service = new LinuxUserProvisioner(await linuxProvisionerConfigFromEnv());
  const fd = Number.parseInt(process.env.LISTEN_FDS ? "3" : process.env.PROVISIONER_LISTEN_FD ?? "3", 10);
  await startProvisionerServer(service, { fd });
  console.log(`[Provisioner] listening on inherited fd ${fd}`);
}

main().catch((error) => {
  console.error("[Provisioner] Fatal:", error instanceof Error ? error.message : error);
  process.exit(1);
});
