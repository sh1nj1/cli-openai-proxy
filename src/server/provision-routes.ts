/**
 * Agent provisioning endpoints.
 *
 * Same trust model as the auth-provisioning surface: admin-key gated
 * (AUTH_ADMIN_KEYS — installing prompt-loaded instructions is at least as
 * sensitive as mutating credentials), and fail-closed behind its own opt-in:
 * without PROVISION_SYNC=1 every route answers 404, so upgrading the proxy
 * never exposes an install channel by itself. Worker role mounts only the
 * opt-in gate (provisionEnabledGate): the gateway already authenticated the
 * caller and each worker's unix socket is per-user, so a second admin-key
 * check there would gate against a key the worker never receives.
 */

import type { Request, Response, NextFunction } from "express";
import { authAdminMiddleware } from "./auth-routes.js";
import {
  approveItem,
  deleteItem,
  getStatus,
  provisionEnabled,
  registerManifestUrl,
  syncNow,
} from "../provision/sync.js";
import { ProvisionError } from "../provision/types.js";
// Registration bound: the URL is persisted, so the acceptance limit is the
// persistence limit. Unrelated to the login path's tighter base64url budget,
// which exists only because that URL travels in a response header.
import { MAX_REGISTERED_MANIFEST_URL_BYTES } from "../provision/state.js";

/** Path prefix these handlers own. authMiddleware defers to this module's gate for it. */
export const PROVISION_PREFIX = "/v1/provision";


function fail(res: Response, status: number, message: string, code: string): void {
  res.status(status).json({ error: { message, type: "invalid_request_error", code } });
}

/** The opt-in half of the gate; worker role mounts it without the admin-key half. */
export function provisionEnabledGate(req: Request, res: Response, next: NextFunction): void {
  if (!provisionEnabled()) {
    fail(res, 404, "Provisioning is disabled. Set PROVISION_SYNC=1 to enable it.", "provisioning_disabled");
    return;
  }
  next();
}

export function provisionAdminMiddleware(req: Request, res: Response, next: NextFunction): void {
  // The provisioning opt-in does not replace the key check: both gates hold.
  provisionEnabledGate(req, res, () => authAdminMiddleware(req, res, next));
}

function sendError(res: Response, err: unknown, invalidItemIsUpstream = false): void {
  if (err instanceof ProvisionError) {
    // 409 for the pin: the request is well-formed and the key is valid — the
    // server refuses on policy, and retrying changes nothing until the operator
    // unsets PROVISION_MANIFEST_URL.
    // 502 for upstream faults: the request was fine, the registry's answer was
    // not — retrying may succeed once the remote side is fixed.
    const status =
      err.code === "unknown_item" || err.code === "provisioning_disabled"
        ? 404
        : err.code === "manifest_url_locked"
          ? 409
          : err.code === "manifest_fetch_failed" ||
              err.code === "invalid_manifest" ||
              (invalidItemIsUpstream && err.code === "invalid_item") ||
              err.code === "download_failed"
            ? 502
            : 400;
    fail(res, status, err.message, err.code);
    return;
  }
  const message = err instanceof Error ? err.message : "Unknown error";
  res.status(500).json({ error: { message, type: "server_error", code: null } });
}

/** GET /v1/provision — item states from the last sync (or the lockfile before one). */
export function handleProvisionStatus(_req: Request, res: Response): void {
  res.json(getStatus());
}

/**
 * POST /v1/provision/manifest — register a manifest URL, then apply it now.
 *
 * The login-carried `provisioning_url` does the same thing as a side effect of
 * authenticating; this route decouples the two so an already-authorized agent
 * can be (re)provisioned on its own. It also reports failures instead of
 * swallowing them: a login must not fail because its manifest did, while a
 * caller who asked only to provision wants the 4xx/5xx.
 */
export async function handleProvisionRegisterManifest(req: Request, res: Response): Promise<void> {
  const raw = (req.body as { url?: unknown } | undefined)?.url;
  if (typeof raw !== "string" || !raw.trim()) {
    fail(res, 400, "Request body must include a non-empty `url`.", "invalid_provisioning_url");
    return;
  }
  const url = raw.trim();
  if (Buffer.byteLength(url, "utf8") > MAX_REGISTERED_MANIFEST_URL_BYTES) {
    fail(res, 400, "`url` is too long.", "invalid_provisioning_url");
    return;
  }
  try {
    registerManifestUrl(url, { persist: true });
    res.json(await syncNow());
  } catch (err) {
    sendError(res, err, true);
  }
}

/** POST /v1/provision/sync — re-fetch the manifest and apply it now. */
export async function handleProvisionSync(_req: Request, res: Response): Promise<void> {
  try {
    res.json(await syncNow());
  } catch (err) {
    sendError(res, err, true);
  }
}

/** POST /v1/provision/items/:type/:name/approve — lift the TOFU stop for one item. */
export async function handleProvisionApprove(req: Request, res: Response): Promise<void> {
  const adopt = (req.body as { adopt?: unknown } | undefined)?.adopt;
  if (adopt !== undefined && typeof adopt !== "boolean") {
    fail(res, 400, "`adopt` must be a boolean", "invalid_item");
    return;
  }
  try {
    res.json(await approveItem(
      String(req.params.type ?? ""),
      String(req.params.name ?? ""),
      { adopt: adopt === true },
    ));
  } catch (err) {
    sendError(res, err);
  }
}

/** DELETE /v1/provision/items/:type/:name — uninstall and revoke approval. */
export async function handleProvisionDelete(req: Request, res: Response): Promise<void> {
  const type = String(req.params.type ?? "");
  const name = String(req.params.name ?? "");
  try {
    res.json({ type, name, ...await deleteItem(type, name) });
  } catch (err) {
    sendError(res, err);
  }
}
