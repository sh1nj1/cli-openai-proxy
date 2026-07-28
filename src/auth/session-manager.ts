/**
 * In-memory registry of in-flight auth attempts.
 *
 * The "paste-code" flow holds a live CLI child between the start and submit
 * requests, so an abandoned session is a leaked process. Two invariants keep
 * that bounded: at most one session per engine (a new start cancels the old),
 * and every session is reaped after a TTL.
 *
 * Sessions are not persisted. A proxy restart drops them and the caller simply
 * restarts the flow — the same trade-off as the memory-only token store.
 */

import { randomUUID } from "crypto";
import { resolveEngine } from "./registry.js";
import { setCredential } from "./token-store.js";
import {
  AuthProvisioningError,
  type AuthFlow,
  type AuthStartResult,
  type EngineAuthSession,
} from "./types.js";

export type SessionStatus = "pending" | "authorized" | "failed" | "cancelled";

export interface SessionView {
  sessionId: string;
  engine: string;
  flow: AuthFlow;
  status: SessionStatus;
  verificationUrl?: string;
  instructions: string;
  expiresAt: string;
  error?: { message: string; code: string };
}

interface SessionRecord extends Omit<SessionView, "expiresAt"> {
  expiresAt: number;
  handle: EngineAuthSession;
  timer: NodeJS.Timeout;
  /**
   * Set for the duration of submit(). Not part of SessionView: the session is
   * still "pending" to an observer — nothing has been decided yet — and this only
   * answers "is another request already driving it?".
   */
  submitting: boolean;
}

const DEFAULT_TTL_MS = 10 * 60_000;

const byId = new Map<string, SessionRecord>();
const byEngine = new Map<string, string>();

/**
 * Engines whose start() is still in flight, keyed by engine.
 *
 * `byEngine` is only written once the CLI has handed back its verification URL,
 * which for paste-code takes as long as the user's CLI needs to print it. Two
 * overlapping starts would both find `byEngine` empty and both launch a child,
 * leaving one orphaned (nothing disposes it) and two live sessions racing to
 * overwrite the same credential. Reserving the engine here — before the await —
 * makes the one-session-per-engine invariant hold DURING start, not just after.
 */
const starting = new Map<string, { handle: EngineAuthSession }>();

function ttlMs(): number {
  const raw = Number(process.env.AUTH_SESSION_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_MS;
}

function view(record: SessionRecord): SessionView {
  const { handle: _handle, timer: _timer, submitting: _submitting, expiresAt, ...rest } = record;
  return { ...rest, expiresAt: new Date(expiresAt).toISOString() };
}

/** Drop a session and kill whatever it was holding. */
function dispose(record: SessionRecord, status: SessionStatus): void {
  clearTimeout(record.timer);
  record.status = status;
  record.handle.cancel();
  byId.delete(record.sessionId);
  if (byEngine.get(record.engine) === record.sessionId) byEngine.delete(record.engine);
}

function supersededError(engine: string): AuthProvisioningError {
  return new AuthProvisioningError(
    `A newer authentication attempt for "${engine}" superseded this one`,
    "session_superseded",
  );
}

/**
 * Start a new attempt for `engine`, superseding any existing one. Rejects with
 * AuthProvisioningError for an unknown engine or a flow that fails to start —
 * no record is kept in that case, so a failed start leaves nothing to reap.
 */
export async function createSession(engine: string): Promise<SessionView> {
  const descriptor = resolveEngine(engine);
  if (!descriptor) {
    throw new AuthProvisioningError(`Unknown engine "${engine}"`, "unknown_engine");
  }

  const existingId = byEngine.get(engine);
  if (existingId) {
    const existing = byId.get(existingId);
    if (existing) dispose(existing, "cancelled");
  }
  // Supersede a start that has not registered yet, killing its child now rather
  // than leaving two logins alive until one of them times out.
  const superseded = starting.get(engine);
  if (superseded) {
    starting.delete(engine);
    superseded.handle.cancel();
  }

  const handle = descriptor.createSession();
  const reservation = { handle };
  starting.set(engine, reservation);

  // Our reservation is only ever removed by a later start taking the slot (or by
  // the `finally` below, which has not run yet at the point this is consulted).
  const lostTheSlot = () => starting.get(engine) !== reservation;

  let started: AuthStartResult;
  try {
    started = await handle.start();
  } catch (err) {
    // Superseding cancels this handle mid-start, so whatever start() reports is a
    // description of that cancellation, not of the caller's request. Report the
    // race the caller actually lost instead of leaking the adapter's reason.
    if (lostTheSlot()) throw supersededError(engine);
    throw err;
  } finally {
    // Only clear our own reservation: a later start may already own the slot.
    if (starting.get(engine) === reservation) starting.delete(engine);
  }

  // A later start took the slot while we were waiting, and already cancelled this
  // handle. Registering now would resurrect the session it just superseded.
  if (starting.get(engine) !== undefined || byEngine.get(engine) !== undefined) {
    handle.cancel();
    throw supersededError(engine);
  }

  const sessionId = randomUUID();
  const expiresAt = Date.now() + ttlMs();
  const timer = setTimeout(() => {
    const record = byId.get(sessionId);
    if (record) dispose(record, "failed");
  }, ttlMs());
  // Do not hold the event loop open for a pending login.
  timer.unref?.();

  const record: SessionRecord = {
    sessionId,
    engine,
    flow: descriptor.flow,
    status: "pending",
    verificationUrl: started.verificationUrl,
    instructions: started.instructions,
    expiresAt,
    handle,
    timer,
    submitting: false,
  };
  byId.set(sessionId, record);
  byEngine.set(engine, sessionId);
  return view(record);
}

function requireSession(engine: string, sessionId: string): SessionRecord {
  const record = byId.get(sessionId);
  // Engine is part of the lookup so a session id cannot be replayed against a
  // different engine's route.
  if (!record || record.engine !== engine) {
    throw new AuthProvisioningError(`Unknown session "${sessionId}"`, "unknown_session");
  }
  return record;
}

export async function submitSession(
  engine: string,
  sessionId: string,
  input: string,
): Promise<SessionView> {
  const record = requireSession(engine, sessionId);
  if (record.status !== "pending") {
    throw new AuthProvisioningError(
      `Session is already ${record.status}`,
      "session_not_pending",
    );
  }
  // `status` alone cannot gate this: it stays "pending" until submit() resolves,
  // so two overlapping POSTs would both pass and both drive the same session —
  // two codes written to one pty, or two `codex login` runs racing to replace the
  // host credential, with both requests free to report "authorized".
  if (record.submitting) {
    throw new AuthProvisioningError(
      "Another submission for this session is already in progress",
      "session_submitting",
    );
  }
  record.submitting = true;

  try {
    const result = await record.handle.submit(input);
    if (result.credential) setCredential(engine, result.credential);
    // Snapshot before dispose(), which removes the record from the maps.
    const authorized: SessionView = { ...view(record), status: "authorized" };
    dispose(record, "authorized");
    return authorized;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof AuthProvisioningError ? err.code : "submit_failed";
    const failed: SessionView = { ...view(record), status: "failed", error: { message, code } };
    dispose(record, "failed");
    return failed;
  } finally {
    // Both paths dispose, so the record is already unreachable; released anyway so
    // the flag can never outlive the attempt that set it.
    record.submitting = false;
  }
}

export function getSession(engine: string, sessionId: string): SessionView {
  return view(requireSession(engine, sessionId));
}

export function cancelSession(engine: string, sessionId: string): SessionView {
  const record = requireSession(engine, sessionId);
  const cancelled: SessionView = { ...view(record), status: "cancelled" };
  dispose(record, "cancelled");
  return cancelled;
}

/** Test-only: drop every session (and kill held children). */
export function resetSessions(): void {
  for (const record of [...byId.values()]) dispose(record, "cancelled");
  for (const [engine, reservation] of [...starting.entries()]) {
    starting.delete(engine);
    reservation.handle.cancel();
  }
}
