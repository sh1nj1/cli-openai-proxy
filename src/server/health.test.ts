import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { notifyCredentialChange } from "../auth/credential-events.js";
import { engineRegistry } from "../auth/registry.js";
import type { EngineAuthDescriptor, EngineAuthStatus } from "../auth/types.js";
import {
  countReady,
  engineHealth,
  resetEngineProbe,
  rollupStatus,
  warmEngineProbe,
} from "./health.js";

const savedResolve = engineRegistry.resolve;
const savedIds = engineRegistry.ids;

/** Installs a fake engine set; `calls` counts how often each engine was probed. */
function stubEngines(
  engines: Record<string, () => Promise<EngineAuthStatus>>,
): { calls: Record<string, number> } {
  const calls: Record<string, number> = {};
  engineRegistry.ids = () => Object.keys(engines);
  engineRegistry.resolve = (engine: string): EngineAuthDescriptor | null => {
    const check = engines[engine];
    if (!check) return null;
    return {
      engine,
      flows: [],
      checkStatus: () => {
        calls[engine] = (calls[engine] ?? 0) + 1;
        return check();
      },
    } as unknown as EngineAuthDescriptor;
  };
  return { calls };
}

const st = (state: EngineAuthStatus["state"]): EngineAuthStatus => ({ state });

describe("rollupStatus", () => {
  test("every engine authenticated is the only way to be ok", () => {
    assert.equal(rollupStatus({ a: st("authenticated"), b: st("authenticated") }), "ok");
  });

  test("a single unauthenticated engine degrades but does not fail the gateway", () => {
    assert.equal(rollupStatus({ a: st("authenticated"), b: st("unauthenticated") }), "degraded");
  });

  // The macOS regression this whole rule exists for: claude's credential lives in
  // the OS keychain, so a perfectly healthy host reports unknown forever. Failing
  // closed on it would pin production at 503.
  test("unknown-only stays degraded, never down", () => {
    assert.equal(rollupStatus({ a: st("unknown") }), "degraded");
    assert.equal(rollupStatus({ a: st("unknown"), b: st("unknown") }), "degraded");
  });

  test("unknown mixed with an explicit failure is still not down", () => {
    assert.equal(rollupStatus({ a: st("unknown"), b: st("unauthenticated") }), "degraded");
  });

  test("down requires every engine to be provably unusable", () => {
    assert.equal(rollupStatus({ a: st("unauthenticated"), b: st("unauthenticated") }), "down");
  });

  test("an empty probe is degraded, not ok — nothing has been proven yet", () => {
    assert.equal(rollupStatus({}), "degraded");
  });
});

test("countReady counts only authenticated engines", () => {
  assert.equal(
    countReady({ a: st("authenticated"), b: st("unauthenticated"), c: st("unknown") }),
    1,
  );
});

describe("engine probe cache", () => {
  beforeEach(() => resetEngineProbe());

  afterEach(() => {
    resetEngineProbe();
    engineRegistry.resolve = savedResolve;
    engineRegistry.ids = savedIds;
  });

  test("the first read never blocks on the probe", () => {
    stubEngines({ codex: () => new Promise(() => {}) });
    const health = engineHealth();
    assert.deepEqual(health.items, {});
    assert.equal(health.probedAt, null);
    assert.equal(health.stale, true, "no snapshot yet must read as stale");
  });

  test("concurrent readers cost exactly one probe per engine", async () => {
    const { calls } = stubEngines({ codex: async () => st("authenticated") });
    engineHealth();
    engineHealth();
    engineHealth();
    await warmEngineProbe();
    assert.equal(calls.codex, 1);
  });

  test("a settled probe is served from cache without re-probing", async () => {
    const { calls } = stubEngines({ codex: async () => st("authenticated") });
    await warmEngineProbe();
    const health = engineHealth();
    assert.equal(health.items.codex?.state, "authenticated");
    assert.equal(health.stale, false);
    assert.ok(typeof health.ageMs === "number" && health.ageMs >= 0);
    assert.equal(calls.codex, 1, "a fresh snapshot must not spawn the CLI again");
  });

  // Without this the 30s TTL outlives the login: a device-code flow that just
  // succeeded would keep reading as unauthenticated.
  test("a credential change drops the snapshot so the next read re-probes", async () => {
    let state: EngineAuthStatus["state"] = "unauthenticated";
    const { calls } = stubEngines({ codex: async () => st(state) });
    await warmEngineProbe();
    assert.equal(engineHealth().items.codex?.state, "unauthenticated");

    state = "authenticated";
    notifyCredentialChange();
    assert.equal(engineHealth().probedAt, null, "the stale snapshot must be gone at once");
    await warmEngineProbe();
    assert.equal(engineHealth().items.codex?.state, "authenticated");
    assert.equal(calls.codex, 2);
  });

  test("a throwing check reports unknown rather than a login prompt", async () => {
    stubEngines({ codex: async () => { throw new Error("spawn codex ENOENT"); } });
    await warmEngineProbe();
    const { items } = engineHealth();
    assert.equal(items.codex?.state, "unknown");
    assert.match(items.codex?.detail ?? "", /ENOENT/);
  });
});
