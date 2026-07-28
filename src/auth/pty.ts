/**
 * Minimal pty abstraction.
 *
 * `claude setup-token` detects a non-TTY stdio and suppresses its interactive UI
 * entirely (it prints nothing and never exits), so a plain child_process.spawn
 * cannot drive it — a real pty is required. node-pty is loaded lazily so unit
 * tests, which substitute the spawner, never touch the native binding.
 */

export interface PtyProcess {
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  kill(signal?: string): void;
}

export interface PtySpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
}

export type PtySpawnFn = (
  file: string,
  args: string[],
  options?: PtySpawnOptions,
) => Promise<PtyProcess>;

const spawnWithNodePty: PtySpawnFn = async (file, args, options = {}) => {
  const nodePty = await import("node-pty");
  // Wide columns so the CLI wraps less; the OSC-8 target is unwrapped regardless,
  // but a wider view keeps the plain-text fallback usable.
  const proc = nodePty.spawn(file, args, {
    name: "xterm-256color",
    cols: options.cols ?? 200,
    rows: options.rows ?? 50,
    cwd: options.cwd ?? process.cwd(),
    env: { ...(process.env as Record<string, string>), ...(options.env ?? {}) },
  });

  return {
    onData: (listener) => { proc.onData(listener); },
    onExit: (listener) => { proc.onExit(listener); },
    write: (data) => proc.write(data),
    kill: (signal) => { try { proc.kill(signal); } catch { /* already gone */ } },
  };
};

/**
 * Mutable holder so tests can substitute the spawner: ESM module namespace
 * properties are read-only, so a plain object property is the injection seam
 * (same pattern as `runnerFactory` in paperclip-registry).
 */
export const ptySpawner: { spawn: PtySpawnFn } = { spawn: spawnWithNodePty };
