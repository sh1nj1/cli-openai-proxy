/**
 * Agent provisioning endpoints.
 *
 * Same trust model as the auth-provisioning surface: admin-key gated
 * (AUTH_ADMIN_KEYS — installing prompt-loaded instructions is at least as
 * sensitive as mutating credentials), and fail-closed behind its own opt-in:
 * without PROVISION_SYNC=1 every route answers 404, so upgrading the proxy
 * never exposes an install channel by itself.
 */

import type { Request, Response, NextFunction } from "express";
import { authAdminMiddleware } from "./auth-routes.js";
import {
  approveItem,
  deleteItem,
  getStatus,
  provisionEnabled,
  syncNow,
} from "../provision/sync.js";
import { ProvisionError } from "../provision/types.js";

/** Path prefix these handlers own. authMiddleware defers to this module's gate for it. */
export const PROVISION_PREFIX = "/v1/provision";

function fail(res: Response, status: number, message: string, code: string): void {
  res.status(status).json({ error: { message, type: "invalid_request_error", code } });
}

export function provisionAdminMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!provisionEnabled()) {
    fail(res, 404, "Provisioning is disabled. Set PROVISION_SYNC=1 to enable it.", "provisioning_disabled");
    return;
  }
  // The provisioning opt-in does not replace the key check: both gates hold.
  authAdminMiddleware(req, res, next);
}

function sendError(res: Response, err: unknown): void {
  if (err instanceof ProvisionError) {
    // 502 for upstream faults: the request was fine, the registry's answer was
    // not — retrying may succeed once the remote side is fixed.
    const status =
      err.code === "unknown_item" || err.code === "provisioning_disabled"
        ? 404
        : err.code === "manifest_fetch_failed" ||
            err.code === "invalid_manifest" ||
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

/** POST /v1/provision/sync — re-fetch the manifest and apply it now. */
export async function handleProvisionSync(_req: Request, res: Response): Promise<void> {
  try {
    res.json(await syncNow());
  } catch (err) {
    sendError(res, err);
  }
}

/** POST /v1/provision/items/:type/:name/approve — lift the TOFU stop for one item. */
export async function handleProvisionApprove(req: Request, res: Response): Promise<void> {
  try {
    res.json(await approveItem(String(req.params.type ?? ""), String(req.params.name ?? "")));
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
