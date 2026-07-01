import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

export const DEFAULT_TIMEOUT_MS = 6000000; // 100 minutes

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
