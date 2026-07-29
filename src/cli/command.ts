import { spawn } from "child_process";

/** A `--version` call that hangs is a broken install; treat it as unavailable. */
const PROBE_TIMEOUT_MS = 5000;

/**
 * Whether a CLI is installed and runnable.
 *
 * Presence only — an installed CLI can still be logged out, which stays a
 * request-time error. This exists so nothing is suggested to a user without
 * having been checked: "Claude is missing" says nothing about codex.
 */
export function commandRuns(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };

    const proc = spawn(command, ["--version"], { stdio: "ignore" });
    const timer = setTimeout(() => {
      proc.kill();
      done(false);
    }, PROBE_TIMEOUT_MS);

    proc.on("error", () => done(false));
    proc.on("close", (code) => done(code === 0));
  });
}
