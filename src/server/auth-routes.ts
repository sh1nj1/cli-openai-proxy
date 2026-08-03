/**
 * Remote CLI auth provisioning endpoints.
 *
 * These mutate host credentials and accept secrets in request bodies, so they
 * are gated by their own AUTH_ADMIN_KEYS — separate from the completion-facing
 * API_KEYS. Fail-closed: with no admin keys configured the whole surface is
 * disabled, so simply upgrading the proxy never exposes a login endpoint.
 */

import type { Request, Response, NextFunction } from "express";
import { takeProxySecret } from "../config.js";
import { engineRegistry, resolveEngine } from "../auth/registry.js";
import {
  cancelSession,
  createSession,
  getAuthorizedProvisioningNotification,
  getSessionProvisioningNotification,
  getSession,
  submitSession,
  type SessionProvisioningNotification,
} from "../auth/session-manager.js";
import { clearCredential } from "../auth/token-store.js";
import { AuthProvisioningError } from "../auth/types.js";
import { provisionEnabled } from "../provision/sync.js";
import {
  AUTHORIZED_PROVISIONING_HEADER,
  PROVISIONING_GENERATION_HEADER,
  PROVISIONING_SESSION_TTL_HEADER,
  SUPERSEDED_PROVISIONING_GENERATION_HEADER,
  decodeProvisioningGeneration,
  decodeProvisioningSessionTtl,
  encodeProvisioningUrl,
  provisioningUrlFitsHeader,
} from "../isolation/worker-protocol.js";

/** Path prefix these handlers own. authMiddleware defers to this module's gate for it. */
export const AUTH_PROVISIONING_PREFIX = "/v1/auth";

let adminKeys: Set<string> | null = null;

export function authAdminEnabled(): boolean {
  return adminKeys !== null;
}

export function initAuthAdmin(): { enabled: boolean; keyCount: number } {
  // Taken, not read. This is the higher-privilege key; a completion caller who can
  // make the model print its environment must not find it there (takeProxySecret).
  const keys = (takeProxySecret("AUTH_ADMIN_KEYS") ?? "")
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
    // 409 for the race codes: the request was well-formed, it just lost to a
    // concurrent one for the engine's single session slot (session_superseded) or
    // for the session itself (session_submitting). Both are retryable.
    // 403 for caller_trust_not_declared: the key is valid and the request is
    // well-formed — the server refuses on policy, and retrying changes nothing
    // until the operator declares the trust boundary.
    const status =
      err.code === "unknown_engine" || err.code === "unknown_session"
        ? 404
        : err.code === "session_superseded" || err.code === "session_submitting"
          ? 409
          : err.code === "caller_trust_not_declared"
            ? 403
            : 400;
    fail(res, status, err.message, err.code);
    return;
  }
  const message = err instanceof Error ? err.message : "Unknown error";
  res.status(500).json({ error: { message, type: "server_error", code: null } });
}

/**
 * An engine's flows for a response body: `flows` lists every supported one,
 * `flow` repeats the default — the shape callers relied on when engines had
 * exactly one flow, kept so they keep working unchanged.
 */
function parseable(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

function notifyGatewayWhenWorker(
  req: Request,
  res: Response,
  notification: SessionProvisioningNotification | undefined,
): void {
  // With a worker-local engine the URL is applied here, in this user's HOME.
  // Echoing it upward would additionally rewrite the gateway-global manifest.
  if (notification && req.app?.locals.cliProxyRole === "worker" && !provisionEnabled()) {
    res.setHeader(AUTHORIZED_PROVISIONING_HEADER, encodeProvisioningUrl(notification.url));
    res.setHeader(PROVISIONING_GENERATION_HEADER, notification.generation);
  }
}

function flowFields(engine: string): { flow: string; flows: string[] } {
  const flows = resolveEngine(engine)!.flows.map((f) => f.flow);
  return { flow: flows[0]!, flows };
}

/** GET /v1/auth/engines — lets the caller build its UI without hardcoding flows. */
export function handleAuthEngines(_req: Request, res: Response): void {
  res.json({
    object: "list",
    data: engineRegistry.ids().map((engine) => ({ engine, ...flowFields(engine) })),
  });
}

/** GET /v1/auth/:engine/status */
export async function handleAuthStatus(req: Request, res: Response): Promise<void> {
  const engine = engineOf(req, res);
  if (!engine) return;
  try {
    const status = await resolveEngine(engine)!.checkStatus();
    res.json({ engine, ...flowFields(engine), ...status });
  } catch (err) {
    sendError(res, err);
  }
}

/**
 * POST /v1/auth/:engine/sessions — body may name a `flow` (omitted means the
 * engine's default) and a `provisioning_url`: a manifest the proxy pulls and
 * applies once this login succeeds (see src/provision/sync.ts). The URL is
 * validated here but acted on only if PROVISION_SYNC=1 — with provisioning off
 * it is accepted and ignored, so one Collavre client works against both setups.
 */
export async function handleCreateAuthSession(req: Request, res: Response): Promise<void> {
  const engine = engineOf(req, res);
  if (!engine) return;
  const body = req.body as Record<string, unknown> | undefined;
  const flow = body?.flow;
  if (flow !== undefined && typeof flow !== "string") {
    fail(res, 400, "`flow` must be a string naming one of the engine's flows.", "invalid_flow");
    return;
  }
  const provisioningUrl = body?.provisioning_url;
  if (provisioningUrl !== undefined && (typeof provisioningUrl !== "string" || !parseable(provisioningUrl))) {
    fail(res, 400, "`provisioning_url` must be a valid URL.", "invalid_provisioning_url");
    return;
  }
  if (typeof provisioningUrl === "string" && !provisioningUrlFitsHeader(provisioningUrl)) {
    fail(res, 400, "`provisioning_url` is too long.", "invalid_provisioning_url");
    return;
  }
  try {
    const workerRequest = req.app?.locals.cliProxyRole === "worker";
    const provisioningGeneration = workerRequest
      ? decodeProvisioningGeneration(req.headers[PROVISIONING_GENERATION_HEADER])
      : undefined;
    const sessionTtlMs = workerRequest && provisioningGeneration
      ? decodeProvisioningSessionTtl(req.headers[PROVISIONING_SESSION_TTL_HEADER])
      : undefined;
    res.status(201).json(await createSession(engine, flow, {
      provisioningUrl,
      provisioningGeneration,
      sessionTtlMs,
      onSupersededProvisioningGeneration: workerRequest
	? (generation) => res.setHeader(SUPERSEDED_PROVISIONING_GENERATION_HEADER, generation)
	: undefined,
    }));
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
    const sessionId = String(req.params.sessionId ?? "");
    const notification = req.app?.locals.cliProxyRole === "worker"
      ? getSessionProvisioningNotification(engine, sessionId)
      : undefined;
    const result = await submitSession(engine, sessionId, raw);
    if (result.status === "authorized") notifyGatewayWhenWorker(req, res, notification);
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
}

/** GET /v1/auth/:engine/sessions/:sessionId */
export function handleGetAuthSession(req: Request, res: Response): void {
  const engine = engineOf(req, res);
  if (!engine) return;
  try {
    const sessionId = String(req.params.sessionId ?? "");
    const result = getSession(engine, sessionId);
    if (req.app?.locals.cliProxyRole === "worker" && result.status === "authorized") {
      notifyGatewayWhenWorker(req, res, getAuthorizedProvisioningNotification(engine, sessionId));
    }
    res.json(result);
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
