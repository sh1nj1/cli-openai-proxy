import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { takeProxySecret } from "../config.js";
import type { UserIdentity } from "./types.js";

const MAX_ID_LENGTH = 200;
const MAX_CLOCK_SKEW_SECONDS = 300;
const STABLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;
const identityByRequest = new WeakMap<Request, UserIdentity>();
let keyIdentities = new Map<string, UserIdentity>();
let hmacSecret: string | null = null;

function validIdentity(identity: unknown): identity is UserIdentity {
  if (!identity || typeof identity !== "object") return false;
  const value = identity as Record<string, unknown>;
  return (
    typeof value.tenantId === "string"
    && value.tenantId.length <= MAX_ID_LENGTH
    && STABLE_ID_RE.test(value.tenantId)
    && typeof value.userId === "string"
    && value.userId.length <= MAX_ID_LENGTH
    && STABLE_ID_RE.test(value.userId)
  );
}

export function initRequestIdentity(): { mappedKeyCount: number; signedHeadersEnabled: boolean } {
  keyIdentities = new Map();
  const rawMappings = takeProxySecret("USER_API_KEYS");
  if (rawMappings) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawMappings);
    } catch {
      throw new Error("USER_API_KEYS must be valid JSON");
    }
    if (!Array.isArray(parsed)) {
      throw new Error("USER_API_KEYS must be a JSON array");
    }
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") {
        throw new Error("Each USER_API_KEYS entry must be an object");
      }
      const value = entry as Record<string, unknown>;
      const key = value.key;
      const identity = { tenantId: value.tenantId, userId: value.userId };
      if (typeof key !== "string" || key.length < 16 || !validIdentity(identity)) {
        throw new Error("Each USER_API_KEYS entry requires key, tenantId, and userId");
      }
      if (keyIdentities.has(key)) {
        throw new Error("USER_API_KEYS contains a duplicate key");
      }
      keyIdentities.set(key, identity);
    }
  }
  hmacSecret = takeProxySecret("USER_IDENTITY_HMAC_SECRET")?.trim() || null;
  if (hmacSecret && Buffer.byteLength(hmacSecret) < 32) {
    throw new Error("USER_IDENTITY_HMAC_SECRET must contain at least 32 bytes");
  }
  return { mappedKeyCount: keyIdentities.size, signedHeadersEnabled: hmacSecret !== null };
}

export function mappedCompletionKeys(): string[] {
  return [...keyIdentities.keys()];
}

function header(req: Request, name: string): string {
  const value = req.header(name);
  return typeof value === "string" ? value : "";
}

function signedIdentity(req: Request): UserIdentity | null {
  if (!hmacSecret) return null;
  const tenantId = header(req, "x-cli-proxy-tenant-id");
  const userId = header(req, "x-cli-proxy-user-id");
  const timestamp = header(req, "x-cli-proxy-identity-timestamp");
  const signature = header(req, "x-cli-proxy-identity-signature").toLowerCase();
  const identity = { tenantId, userId };
  if (!validIdentity(identity) || !/^\d{10}$/.test(timestamp) || !/^[a-f0-9]{64}$/.test(signature)) {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > MAX_CLOCK_SKEW_SECONDS) return null;
  const payload = ["v1", req.method.toUpperCase(), req.path, timestamp, tenantId, userId].join("\n");
  const expected = createHmac("sha256", hmacSecret).update(payload).digest();
  const actual = Buffer.from(signature, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? identity : null;
}

function bearerToken(req: Request): string {
  return (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
}

export function resolveRequestIdentity(req: Request): UserIdentity | null {
  const userKey = header(req, "x-cli-proxy-user-key") || bearerToken(req);
  const mapped = keyIdentities.get(userKey);
  return mapped ?? signedIdentity(req);
}

export function requireRequestIdentity(req: Request, res: Response, next: NextFunction): void {
  const identity = resolveRequestIdentity(req);
  if (!identity) {
    res.status(401).json({
      error: {
        message: "A mapped user API key or valid signed user identity is required",
        type: "authentication_error",
        code: "user_identity_required",
      },
    });
    return;
  }
  identityByRequest.set(req, identity);
  next();
}

export function requestIdentity(req: Request): UserIdentity {
  const identity = identityByRequest.get(req);
  if (!identity) {
    throw new Error("Request identity middleware did not run");
  }
  return identity;
}

export function resetRequestIdentityForTests(): void {
  keyIdentities = new Map();
  hmacSecret = null;
}
