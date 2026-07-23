/**
 * Startup preflight checks.
 *
 * Claude CLI / auth are NOT hard requirements: this proxy also serves
 * `paperclip/*` adapter models (e.g. codex) that never touch the Claude CLI.
 * On a host that only has the codex CLI, a missing/unauthenticated Claude must
 * NOT stop the server from starting — it is surfaced as a warning instead. A
 * Claude-targeted request on such a host still fails cleanly at request time
 * (the subprocess manager rejects with a clear "Claude CLI not found" error).
 */

export interface PreflightDeps {
  verifyClaude: () => Promise<{ ok: boolean; error?: string; version?: string }>;
  verifyAuth: () => Promise<{ ok: boolean; error?: string }>;
  /** Info-level line sink (defaults to no-op; tests inject a capture). */
  log?: (msg: string) => void;
  /** Warning-level line sink (defaults to no-op; tests inject a capture). */
  warn?: (msg: string) => void;
}

export interface PreflightResult {
  /** True only when both the Claude CLI and its auth are available. */
  claudeOk: boolean;
  /** Human-readable warnings surfaced when Claude is unavailable. */
  warnings: string[];
}

export async function runPreflight(deps: PreflightDeps): Promise<PreflightResult> {
  const log = deps.log ?? (() => {});
  const warn = deps.warn ?? (() => {});
  const warnings: string[] = [];

  const record = (msg: string): PreflightResult => {
    warnings.push(msg);
    warn(`  ⚠ ${msg}`);
    return { claudeOk: false, warnings };
  };

  log("  Checking Claude CLI...");
  const cliCheck = await deps.verifyClaude();
  if (!cliCheck.ok) {
    return record(
      `Claude CLI unavailable: ${cliCheck.error}. ` +
        `Claude-backed models will fail; paperclip/* adapter models remain available.`
    );
  }
  log(`  ✓ Claude CLI: ${cliCheck.version || "OK"}`);

  log("  Checking authentication...");
  const authCheck = await deps.verifyAuth();
  if (!authCheck.ok) {
    return record(
      `Claude authentication unavailable: ${authCheck.error} (run: claude auth login). ` +
        `Claude-backed models will fail; paperclip/* adapter models remain available.`
    );
  }
  log("  ✓ Authentication: OK");

  return { claudeOk: true, warnings };
}
