/**
 * Remote CLI auth provisioning endpoints.
 *
 * These mutate host credentials and accept secrets in request bodies, so they
 * are gated by their own AUTH_ADMIN_KEYS — separate from the completion-facing
 * API_KEYS. Fail-closed: with no admin keys configured the whole surface is
 * disabled, so simply upgrading the proxy never exposes a login endpoint.
 */

import type { Request, Response, NextFunction } from "express";
import { engineRegistry, resolveEngine } from "../auth/registry.js";
import {
  cancelSession,
  createSession,
  getSession,
  submitSession,
} from "../auth/session-manager.js";
import { clearCredential } from "../auth/token-store.js";
import { AuthProvisioningError } from "../auth/types.js";

/** Path prefix these handlers own. authMiddleware defers to this module's gate for it. */
export const AUTH_PROVISIONING_PREFIX = "/v1/auth";

let adminKeys: Set<string> | null = null;

export function initAuthAdmin(): { enabled: boolean; keyCount: number } {
  const keys = (process.env.AUTH_ADMIN_KEYS ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  adminKeys = keys.length > 0 ? new Set(keys) : null;
  return { enabled: adminKeys !== null, keyCount: keys.length };
}

function fail(res: Response, status: number, message: string, code: string, type = "invalid_request_error"): void {
  res.status(status).json({ error: { message, type, code } });
}

/**
 * Gate for every /v1/auth route. Answers 404 (not 401) when disabled: an
 * operator who never opted in should not even advertise that the surface exists.
 */
export function authAdminMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!adminKeys) {
    fail(res, 404, "Auth provisioning is disabled. Set AUTH_ADMIN_KEYS to enable it.", "auth_provisioning_disabled");
    return;
  }
  const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token || !adminKeys.has(token)) {
    fail(res, 401, "Invalid or missing auth-admin key", "invalid_admin_key", "authentication_error");
    return;
  }
  next();
}

/** Resolve :engine, answering 404 for an unregistered one. */
function engineOf(req: Request, res: Response): string | null {
  const engine = String(req.params.engine ?? "");
  if (!resolveEngine(engine)) {
    fail(res, 404, `Unknown engine "${engine}". Known engines: ${engineRegistry.ids().join(", ")}.`, "unknown_engine");
    return null;
  }
  return engine;
}

/** Map a thrown provisioning error onto the OpenAI-style envelope. */
function sendError(res: Response, err: unknown): void {
  if (err instanceof AuthProvisioningError) {
    // 409 for a superseded start: the request was well-formed, it just lost a race
    // with a concurrent one for the engine's single session slot — retryable.
    const status =
      err.code === "unknown_engine" || err.code === "unknown_session"
        ? 404
        : err.code === "session_superseded"
          ? 409
          : 400;
    fail(res, status, err.message, err.code);
    return;
  }
  const message = err instanceof Error ? err.message : "Unknown error";
  res.status(500).json({ error: { message, type: "server_error", code: null } });
}

/** GET /v1/auth/engines — lets the caller build its UI without hardcoding flows. */
export function handleAuthEngines(_req: Request, res: Response): void {
  res.json({
    object: "list",
    data: engineRegistry.ids().map((engine) => {
      const descriptor = resolveEngine(engine)!;
      return { engine, flow: descriptor.flow };
    }),
  });
}

/** GET /v1/auth/:engine/status */
export async function handleAuthStatus(req: Request, res: Response): Promise<void> {
  const engine = engineOf(req, res);
  if (!engine) return;
  try {
    const status = await resolveEngine(engine)!.checkStatus();
    res.json({ engine, flow: resolveEngine(engine)!.flow, ...status });
  } catch (err) {
    sendError(res, err);
  }
}

/** POST /v1/auth/:engine/sessions */
export async function handleCreateAuthSession(req: Request, res: Response): Promise<void> {
  const engine = engineOf(req, res);
  if (!engine) return;
  try {
    res.status(201).json(await createSession(engine));
  } catch (err) {
    sendError(res, err);
  }
}

/**
 * POST /v1/auth/:engine/sessions/:sessionId — submit the code or API key.
 *
 * A rejected credential is a completed session with status "failed", not a
 * transport error, so it answers 200 with the session view; only malformed
 * requests and unknown sessions are 4xx.
 */
export async function handleSubmitAuthSession(req: Request, res: Response): Promise<void> {
  const engine = engineOf(req, res);
  if (!engine) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const raw = body.value ?? body.code ?? body.api_key ?? body.apiKey;
  if (typeof raw !== "string" || !raw.trim()) {
    fail(res, 400, "Request body must include a non-empty `value` (alias: code, api_key).", "missing_value");
    return;
  }
  try {
    res.json(await submitSession(engine, String(req.params.sessionId ?? ""), raw));
  } catch (err) {
    sendError(res, err);
  }
}

/** GET /v1/auth/:engine/sessions/:sessionId */
export function handleGetAuthSession(req: Request, res: Response): void {
  const engine = engineOf(req, res);
  if (!engine) return;
  try {
    res.json(getSession(engine, String(req.params.sessionId ?? "")));
  } catch (err) {
    sendError(res, err);
  }
}

/** DELETE /v1/auth/:engine/sessions/:sessionId — abandon, killing any held CLI child. */
export function handleCancelAuthSession(req: Request, res: Response): void {
  const engine = engineOf(req, res);
  if (!engine) return;
  try {
    res.json(cancelSession(engine, String(req.params.sessionId ?? "")));
  } catch (err) {
    sendError(res, err);
  }
}

/**
 * DELETE /v1/auth/:engine/credential — forget a provisioned credential.
 * Only credentials this API holds; a CLI that persists its own is untouched
 * (logging that out is the CLI's own concern, not something we do behind it).
 */
export function handleForgetCredential(req: Request, res: Response): void {
  const engine = engineOf(req, res);
  if (!engine) return;
  res.json({ engine, cleared: clearCredential(engine) });
}
