/**
 * Optional API Key Authentication Middleware
 *
 * When API_KEYS env var is set, requires valid Bearer token.
 * When not set, all requests are allowed (backwards compatible).
 *
 * Set API_KEYS as comma-separated values:
 *   API_KEYS=sk-abc123,sk-def456 node dist/server/standalone.js
 */

import type { Request, Response, NextFunction } from "express";
import { takeProxySecret } from "../config.js";
import { AUTH_PROVISIONING_PREFIX } from "./auth-routes.js";
import { AUTH_UI_PATH } from "./auth-ui.js";
import { PROVISION_PREFIX } from "./provision-routes.js";
import { mappedCompletionKeys } from "../isolation/request-identity.js";

let validKeys: Set<string> | null = null;

/**
 * Initialize auth from environment
 */
export function initAuth(): { enabled: boolean; keyCount: number } {
  // Taken, not read: the value lives in `validKeys` from here on, and leaving it
  // in process.env would inherit it into every CLI child (see takeProxySecret).
  const keysEnv = takeProxySecret("API_KEYS");
  if (keysEnv) {
    const keys = [
      ...keysEnv.split(",").map(k => k.trim()).filter(Boolean),
      ...mappedCompletionKeys(),
    ];
    if (keys.length > 0) {
      validKeys = new Set(keys);
      return { enabled: true, keyCount: keys.length };
    }
  }
  const mappedKeys = mappedCompletionKeys();
  if (mappedKeys.length > 0) {
    validKeys = new Set(mappedKeys);
    return { enabled: true, keyCount: mappedKeys.length };
  }
  validKeys = null;
  return { enabled: false, keyCount: 0 };
}

/**
 * Auth middleware - returns 401 if API_KEYS is set and token is invalid
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Auth disabled - pass through
  if (!validKeys) {
    next();
    return;
  }

  // The auth UI accepts the separate admin key inside the page and must be
  // loadable before the browser can attach that key to provisioning requests.
  if (req.path === "/health" || req.path === AUTH_UI_PATH) {
    next();
    return;
  }

  // Auth-provisioning routes carry an auth-admin key, not a completion key, so
  // checking them here would reject the correct credential. They are gated by
  // their own fail-closed middleware (disabled entirely without AUTH_ADMIN_KEYS).
  if (req.path.startsWith(AUTH_PROVISIONING_PREFIX)) {
    next();
    return;
  }

  // Same for agent provisioning: admin-key gated by its own fail-closed
  // middleware (404 without PROVISION_SYNC=1).
  if (req.path.startsWith(PROVISION_PREFIX)) {
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader) {
    res.status(401).json({
      error: {
        message: "Missing Authorization header. Use: Authorization: Bearer <api-key>",
        type: "authentication_error",
        code: "missing_api_key",
      },
    });
    return;
  }

  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!validKeys.has(token)) {
    res.status(401).json({
      error: {
        message: "Invalid API key",
        type: "authentication_error",
        code: "invalid_api_key",
      },
    });
    return;
  }

  next();
}

/**
 * Check if auth is enabled
 */
export function isAuthEnabled(): boolean {
  return validKeys !== null;
}
