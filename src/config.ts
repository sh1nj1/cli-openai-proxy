import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

export const DEFAULT_TIMEOUT_MS = 6000000; // 100 minutes

// Since v2.1.182, `claude -p` caps how long it waits for background subagents
// to finish at 10 minutes by default, then exits — cutting off longer runs.
// 0 = wait until subagents finish; the request timeout above is the real bound.
export const DEFAULT_BG_WAIT_CEILING_MS = 0;

const KEEPALIVE_INTERVAL_MS = 15000;
export { KEEPALIVE_INTERVAL_MS };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PKG_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(path.resolve(__dirname, "../package.json"), "utf-8")).version || "unknown";
  } catch { return "unknown"; }
})();

export function getTimeoutMs(): number {
  const raw = process.env.TIMEOUT;
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

// Ceiling passed to the CLI as CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS.
// A user-set env value wins; otherwise default to no ceiling (0). Note 0 is a
// valid value (unlimited), so the guard is >= 0, not > 0.
export function getBgWaitCeilingMs(): number {
  const raw = process.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS;
  if (raw === undefined || raw === "") return DEFAULT_BG_WAIT_CEILING_MS;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_BG_WAIT_CEILING_MS;
}
