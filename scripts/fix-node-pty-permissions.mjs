#!/usr/bin/env node
/**
 * node-pty ships its prebuilt macOS `spawn-helper` without the execute bit
 * (mode 0644 in the published tarball). Every pty spawn then fails with
 * "posix_spawnp failed" — even for /bin/echo — and the message names neither
 * node-pty nor the permission, so the symptom points nowhere near the cause.
 * Restore the bit at install time.
 *
 * Never fails the install: node-pty is only needed for the paste-code auth flow,
 * and a host without a working one should still get a working proxy.
 */
import { chmodSync, existsSync, readdirSync, statSync } from "fs";
import { createRequire } from "module";
import path from "path";

const EXEC_BITS = 0o111;

/** Both layouts: prebuilds/<platform>-<arch>/ (published) and build/Release/ (source build). */
function helperPaths(root) {
  const paths = [path.join(root, "build", "Release", "spawn-helper")];
  const prebuilds = path.join(root, "prebuilds");
  if (existsSync(prebuilds)) {
    for (const entry of readdirSync(prebuilds)) {
      paths.push(path.join(prebuilds, entry, "spawn-helper"));
    }
  }
  return paths;
}

try {
  const require = createRequire(import.meta.url);
  const root = path.dirname(require.resolve("node-pty/package.json"));
  let fixed = 0;

  for (const helper of helperPaths(root)) {
    if (!existsSync(helper)) continue; // Linux/Windows builds have no helper
    const mode = statSync(helper).mode;
    if ((mode & EXEC_BITS) === EXEC_BITS) continue;
    chmodSync(helper, mode | EXEC_BITS);
    fixed++;
  }

  if (fixed > 0) {
    console.log(`[postinstall] restored execute permission on ${fixed} node-pty spawn-helper binary/binaries`);
  }
} catch (err) {
  console.warn(`[postinstall] skipped node-pty spawn-helper fix: ${err.message}`);
}
