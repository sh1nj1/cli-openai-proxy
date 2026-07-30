import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { Request, Response } from "express";
import { resetCapturedProxySecrets } from "../config.js";
import {
  initRequestIdentity,
  requestIdentity,
  requireRequestIdentity,
  resetRequestIdentityForTests,
} from "./request-identity.js";

function fakeRequest(headers: Record<string, string>, path = "/v1/chat/completions"): Request {
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    method: "POST",
    path,
    headers: normalized,
    header(name: string) {
      return normalized[name.toLowerCase()];
    },
  } as unknown as Request;
}

function fakeResponse(): Response & { statusCode: number; payload?: unknown } {
  const response: {
    statusCode: number;
    payload?: unknown;
    status(code: number): typeof response;
    json(payload: unknown): typeof response;
  } = {
    statusCode: 200,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.payload = payload;
      return this;
    },
  };
  return response as unknown as Response & { statusCode: number; payload?: unknown };
}

describe("request identity", () => {
  beforeEach(() => {
    resetCapturedProxySecrets();
    resetRequestIdentityForTests();
    delete process.env.USER_API_KEYS;
    delete process.env.USER_IDENTITY_HMAC_SECRET;
  });

  afterEach(() => {
    resetCapturedProxySecrets();
    resetRequestIdentityForTests();
    delete process.env.USER_API_KEYS;
    delete process.env.USER_IDENTITY_HMAC_SECRET;
  });

  test("maps an opaque user API key to a trusted stable identity", () => {
    process.env.USER_API_KEYS = JSON.stringify([
      { key: "user-key-12345678", tenantId: "tenant-a", userId: "user-a" },
    ]);
    assert.deepEqual(initRequestIdentity(), { mappedKeyCount: 1, signedHeadersEnabled: false });
    assert.equal("USER_API_KEYS" in process.env, false, "mapping secrets must not reach CLI children");

    const request = fakeRequest({ authorization: "Bearer user-key-12345678" });
    const response = fakeResponse();
    let nexted = false;
    requireRequestIdentity(request, response, () => { nexted = true; });

    assert.equal(nexted, true);
    assert.deepEqual(requestIdentity(request), { tenantId: "tenant-a", userId: "user-a" });
  });

  test("accepts an HMAC-bound identity and rejects tampering", () => {
    const secret = "identity-secret-that-is-long-enough";
    process.env.USER_IDENTITY_HMAC_SECRET = secret;
    initRequestIdentity();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const payload = ["v1", "POST", "/v1/chat/completions", timestamp, "tenant-a", "user-a"].join("\n");
    const signature = createHmac("sha256", secret).update(payload).digest("hex");
    const headers = {
      "x-cli-proxy-tenant-id": "tenant-a",
      "x-cli-proxy-user-id": "user-a",
      "x-cli-proxy-identity-timestamp": timestamp,
      "x-cli-proxy-identity-signature": signature,
    };

    const valid = fakeRequest(headers);
    let nexted = false;
    requireRequestIdentity(valid, fakeResponse(), () => { nexted = true; });
    assert.equal(nexted, true);

    const tampered = fakeRequest({ ...headers, "x-cli-proxy-user-id": "user-b" });
    const response = fakeResponse();
    requireRequestIdentity(tampered, response, () => assert.fail("tampered identity must not pass"));
    assert.equal(response.statusCode, 401);
  });

  test("fails closed on malformed mapping configuration", () => {
    process.env.USER_API_KEYS = JSON.stringify([{ key: "short", tenantId: "tenant-a" }]);
    assert.throws(() => initRequestIdentity(), /requires key, tenantId, and userId/);
  });
});
