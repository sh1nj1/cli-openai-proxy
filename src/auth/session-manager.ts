/**
 * In-memory registry of in-flight auth attempts.
 *
 * The "paste-code" and "device-code" flows hold a live CLI child after start —
 * so an abandoned session is a leaked process. Two invariants keep that
 * bounded: at most one *pending* session per engine (a new start cancels the
 * old), every session is reaped after a TTL, and server shutdown drops them all.
 *
 * "device-code" sessions finish without a submit request, so their terminal
 * status arrives asynchronously (see settleWhenDone). A concluded session stays
 * queryable until its TTL — the poll that discovers the outcome needs something
 * to read — but releases its engine slot immediately.
 *
 * Sessions are not persisted. A proxy restart drops them and the caller simply
 * restarts the flow — the same trade-off as the memory-only token store. That
 * holds for an in-process restart only because `stopServer()` calls
 * `resetSessions()`: these maps are module state, so without it a session would
 * outlive the server that created it and stay submittable after the next start.
 */

import { randomUUID } from "crypto";
import { TRUST_COMPLETION_CALLERS_VAR, trustsCompletionCallers } from "../config.js";
import { handleAuthorizedSession } from "../provision/sync.js";
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
  /** "device-code" only: the one-time code the user enters at the URL. */
  userCode?: string;
  instructions: string;
  expiresAt: string;
  error?: { message: string; code: string };
}

interface SessionRecord extends Omit<SessionView, "expiresAt"> {
  expiresAt: number;
  handle: EngineAuthSession;
  timer: NodeJS.Timeout;
  /**
   * Manifest URL the caller asked to sync once this login succeeds. Held on the
   * record (not in SessionView) because it only matters at the authorized
   * transition — and the device-code flow reaches that transition without a
   * request to carry it.
   */
  provisioningUrl?: string;
  /** Prevent repeated device-code polls from notifying the gateway repeatedly. */
  provisioningNotificationTaken: boolean;
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
  const {
    handle: _handle,
    timer: _timer,
    submitting: _submitting,
    provisioningUrl: _provisioningUrl,
    expiresAt,
    ...rest
  } = record;
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
 * `flow` picks among the engine's flows; omitted means the engine's default.
 */
export async function createSession(
  engine: string,
  flow?: string,
  opts: { provisioningUrl?: string } = {},
): Promise<SessionView> {
  const descriptor = resolveEngine(engine);
  if (!descriptor) {
    throw new AuthProvisioningError(`Unknown engine "${engine}"`, "unknown_engine");
  }
  const flowDescriptor = flow !== undefined
    ? descriptor.flows.find((f) => f.flow === flow)
    : descriptor.flows[0];
  if (!flowDescriptor) {
    throw new AuthProvisioningError(
      `Engine "${engine}" does not support flow "${flow}". Supported: ${descriptor.flows.map((f) => f.flow).join(", ")}.`,
      "unsupported_flow",
    );
  }
  // Refused before the flow starts, not after: the caller would otherwise mint a
  // real token through the OAuth dance and only then learn we will not use it.
  if (flowDescriptor.injectsCredential && !trustsCompletionCallers()) {
    throw new AuthProvisioningError(
      `Provisioning "${engine}" is refused: its credential can only reach the CLI through a ` +
        `completion child's environment, which any completion caller can read. Set ` +
        `${TRUST_COMPLETION_CALLERS_VAR}=1 to declare that every completion caller is as ` +
        `trusted as this admin key.`,
      "caller_trust_not_declared",
    );
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

  const handle = flowDescriptor.createSession();
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
    flow: flowDescriptor.flow,
    status: "pending",
    verificationUrl: started.verificationUrl,
    userCode: started.userCode,
    instructions: started.instructions,
    expiresAt,
    handle,
    timer,
    submitting: false,
    provisioningUrl: opts.provisioningUrl,
    provisioningNotificationTaken: false,
  };
  byId.set(sessionId, record);
  byEngine.set(engine, sessionId);
  if (handle.wait) settleWhenDone(record);
  return view(record);
}

/**
 * Consume a self-completing flow's outcome (see EngineAuthSession.wait). The
 * record keeps its terminal status until the TTL reaper drops it, so the caller's
 * poll can still read it — but the engine slot is released at once: a concluded
 * attempt holds no child worth superseding, and must not block the next login.
 */
function settleWhenDone(record: SessionRecord): void {
  const conclude = (status: SessionStatus, error?: SessionView["error"]) => {
    // A session that was cancelled, superseded, or reaped already told its story.
    if (byId.get(record.sessionId) !== record || record.status !== "pending") return;
    record.status = status;
    record.error = error;
    if (byEngine.get(record.engine) === record.sessionId) byEngine.delete(record.engine);
  };
  record.handle.wait!().then(
    (result) => {
      if (result.credential) setCredential(record.engine, result.credential);
      conclude("authorized");
      // Only on the transition this call made: a session already concluded (or
      // superseded) must not re-trigger a sync from a stale outcome.
      if (record.status === "authorized") void handleAuthorizedSession(record.provisioningUrl);
    },
    (err) => {
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof AuthProvisioningError ? err.code : "login_failed";
      conclude("failed", { message, code });
    },
  );
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
  // Refused WITHOUT touching the session: the adapter's submit() would throw
  // the same error, but through the catch below — concluding a login that is
  // still waiting for the user because someone POSTed to the wrong endpoint.
  if (record.handle.wait) {
    throw new AuthProvisioningError(
      "This flow takes no submission: enter the code at the verification URL, then poll the session.",
      "submission_not_supported",
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
    // Fire-and-forget: provisioning is a follow-on to a successful login, and
    // its failure must not turn this response into an error (see sync.ts).
    void handleAuthorizedSession(record.provisioningUrl);
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

/** Read before submit() disposes a paste-code/API-key session. */
export function getSessionProvisioningUrl(engine: string, sessionId: string): string | undefined {
  return requireSession(engine, sessionId).provisioningUrl;
}

/** Return a completed device-code session's URL once, for worker-to-gateway notification. */
export function takeAuthorizedProvisioningUrl(engine: string, sessionId: string): string | undefined {
  const record = requireSession(engine, sessionId);
  if (record.status !== "authorized" || record.provisioningNotificationTaken) return undefined;
  record.provisioningNotificationTaken = true;
  return record.provisioningUrl;
}

export function cancelSession(engine: string, sessionId: string): SessionView {
  const record = requireSession(engine, sessionId);
  // A concluded device-code session has nothing left to cancel; deleting it
  // early is fine, but reporting "cancelled" would contradict the outcome the
  // caller may already have seen. Keep the terminal status it earned.
  const status: SessionStatus = record.status === "pending" ? "cancelled" : record.status;
  const result: SessionView = { ...view(record), status };
  dispose(record, status);
  return result;
}

/**
 * Drop every session, killing any child it holds.
 *
 * Called by `stopServer()` as well as by tests: a pending paste-code session owns
 * a pty child that no route can reach once the listener is gone, so leaving it to
 * the TTL leaks a login for up to ten minutes past shutdown.
 */
export function resetSessions(): void {
  for (const record of [...byId.values()]) dispose(record, "cancelled");
  for (const [engine, reservation] of [...starting.entries()]) {
    starting.delete(engine);
    reservation.handle.cancel();
  }
}
