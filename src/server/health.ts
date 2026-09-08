/**
 * Readiness snapshot for the gateway.
 *
 * Kept separate from `/health` on purpose. That path is already wired to launchd
 * KeepAlive, the docker healthcheck and both installers' post-install probe, and
 * every one of those consumers reacts to a failure by restarting the process. An
 * engine that is merely logged out is not fixed by a restart, so reporting it
 * there would turn one expired credential into a restart loop. Liveness stays a
 * constant the process answers by being able to answer; readiness lives here.
 */

import { engineRegistry, resolveEngine } from "../auth/registry.js";
import type { EngineAuthStatus } from "../auth/types.js";

export const HEALTH_PATH = "/health";
export const HEALTH_READY_PATH = "/health/ready";

/** How long a probe result is served before the next reader kicks a refresh. */
const PROBE_TTL_MS = 30_000;

/**
 * Releases the single-flight lock if an engine's check never settles. Deliberately
 * above the registry's own 15s status timeout so the real verdict normally wins
 * and this only covers a check that hangs past its own deadline.
 */
const PROBE_TIMEOUT_MS = 20_000;

export type ReadyStatus = "ok" | "degraded" | "down";

export interface EngineHealth {
  /** null until the first probe lands — see `stale`. */
  probedAt: number | null;
  ageMs: number | null;
  stale: boolean;
  items: Record<string, EngineAuthStatus>;
}

interface Snapshot {
  probedAt: number;
  items: Record<string, EngineAuthStatus>;
}

let snapshot: Snapshot | null = null;
let inFlight: Promise<void> | null = null;

async function probeEngine(engine: string): Promise<EngineAuthStatus> {
  const descriptor = resolveEngine(engine);
  if (!descriptor) return { state: "unknown", detail: "engine is not registered" };
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      descriptor.checkStatus(),
      new Promise<EngineAuthStatus>(resolve => {
        timer = setTimeout(
          () => resolve({ state: "unknown", detail: "status check did not answer in time" }),
          PROBE_TIMEOUT_MS,
        );
        // A background refresh is never worth keeping the process alive for.
        timer.unref();
      }),
    ]);
  } catch (err) {
    // A thrown check says nothing about the credential, and calling that
    // `unauthenticated` would send a caller through a login it may not need.
    return { state: "unknown", detail: err instanceof Error ? err.message : String(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Single-flight: `codex login status` spawns a subprocess, so N concurrent
 * readers of an unauthenticated endpoint must still cost exactly one spawn.
 */
function refresh(): Promise<void> {
  if (inFlight) return inFlight;
  const run = (async () => {
    const ids = engineRegistry.ids();
    const results = await Promise.all(
      ids.map(async id => [id, await probeEngine(id)] as const),
    );
    snapshot = { probedAt: Date.now(), items: Object.fromEntries(results) };
  })();
  inFlight = run.then(
    () => { inFlight = null; },
    () => { inFlight = null; },
  );
  return inFlight;
}

/**
 * Always O(1) and never blocking: readers get the last snapshot and a refresh is
 * kicked in the background when it has aged out. Freshness is reported rather
 * than waited for, so a wedged CLI slows nobody's health check down.
 */
export function engineHealth(): EngineHealth {
  if (!snapshot) {
    void refresh();
    return { probedAt: null, ageMs: null, stale: true, items: {} };
  }
  const ageMs = Date.now() - snapshot.probedAt;
  const stale = ageMs >= PROBE_TTL_MS;
  if (stale) void refresh();
  return { probedAt: snapshot.probedAt, ageMs, stale, items: snapshot.items };
}

/** Drops the snapshot after a credential changed, so readiness does not lag a login. */
export function invalidateEngineProbe(): void {
  snapshot = null;
}

/** Test seam: also cancels the single-flight guard so probes do not leak between tests. */
export function resetEngineProbe(): void {
  snapshot = null;
  inFlight = null;
}

/** Awaits the in-flight (or a fresh) probe. For tests and callers that want a warm cache. */
export async function warmEngineProbe(): Promise<void> {
  await refresh();
}

/**
 * `unknown` is not a failure. `claudeStatus()` returns it on every healthy macOS
 * host, because the credential is in the OS keychain and cannot be read from
 * here — failing closed on it would leave a working production host permanently
 * at 503. So 503 is reserved for "every engine is provably unusable", and
 * anything less certain answers 200 and lets the body carry the nuance.
 */
export function rollupStatus(items: Record<string, EngineAuthStatus>): ReadyStatus {
  const states = Object.values(items).map(s => s.state);
  if (states.length === 0) return "degraded";
  if (states.every(s => s === "unauthenticated")) return "down";
  if (states.every(s => s === "authenticated")) return "ok";
  return "degraded";
}

export function countReady(items: Record<string, EngineAuthStatus>): number {
  return Object.values(items).filter(s => s.state === "authenticated").length;
}
