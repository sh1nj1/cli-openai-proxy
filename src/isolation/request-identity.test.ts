import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { Request, Response } from "express";
import { resetCapturedProxySecrets } from "../config.js";
import {
  initRequestIdentity,
  mappedCompletionKeys,
  requestIdentity,
  requestUsesMappedIdentity,
  resolveRequestIdentity,
  requireRequestIdentity,
  resetRequestIdentityForTests,
} from "./request-identity.js";

function fakeRequest(headers: Record<string, string>, path = "/v1/chat/completions"): Request {
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    method: "POST",
    path,
    originalUrl: path,
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
    delete process.env.PROXY_REQUIRE_IDENTITY_V2;
  });

  afterEach(() => {
    resetCapturedProxySecrets();
    resetRequestIdentityForTests();
    delete process.env.USER_API_KEYS;
    delete process.env.USER_IDENTITY_HMAC_SECRET;
    delete process.env.PROXY_REQUIRE_IDENTITY_V2;
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
    assert.deepEqual(requestIdentity(request), {
      tenantId: "tenant-a",
      userId: "user-a",
      workspaceId: "user-a",
      workspaceScoped: false,
    });
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

  test("binds HMAC identity to the original path without its query string", () => {
    const secret = "identity-secret-that-is-long-enough";
    process.env.USER_IDENTITY_HMAC_SECRET = secret;
    initRequestIdentity();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const payload = ["v1", "POST", "/v1/chat/completions", timestamp, "tenant-a", "user-a"].join("\n");
    const signature = createHmac("sha256", secret).update(payload).digest("hex");
    const request = fakeRequest({
      "x-cli-proxy-tenant-id": "tenant-a",
      "x-cli-proxy-user-id": "user-a",
      "x-cli-proxy-identity-timestamp": timestamp,
      "x-cli-proxy-identity-signature": signature,
    }, "/");
    request.originalUrl = "/v1/chat/completions?stream=true";

    assert.deepEqual(resolveRequestIdentity(request), {
      tenantId: "tenant-a",
      userId: "user-a",
      workspaceId: "user-a",
      workspaceScoped: false,
    });
  });

  test("requires a v2 signature for an explicit workspace and binds the workspace", () => {
    const secret = "identity-secret-that-is-long-enough";
    process.env.USER_IDENTITY_HMAC_SECRET = secret;
    initRequestIdentity();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const base = {
      "x-cli-proxy-tenant-id": "tenant-a",
      "x-cli-proxy-user-id": "user-a",
      "x-cli-proxy-workspace-id": "agent-12",
      "x-cli-proxy-identity-timestamp": timestamp,
    };
    const v2Payload = [
      "v2", "POST", "/v1/chat/completions", timestamp, "tenant-a", "user-a", "agent-12",
    ].join("\n");
    const signature = createHmac("sha256", secret).update(v2Payload).digest("hex");
    assert.deepEqual(resolveRequestIdentity(fakeRequest({
      ...base,
      "x-cli-proxy-identity-signature": signature,
    })), {
      tenantId: "tenant-a",
      userId: "user-a",
      workspaceId: "agent-12",
      workspaceScoped: true,
    });

    assert.equal(resolveRequestIdentity(fakeRequest({
      ...base,
      "x-cli-proxy-workspace-id": "agent-11",
      "x-cli-proxy-identity-signature": signature,
    })), null, "workspace tampering must invalidate the signature");

    const v1Payload = ["v1", "POST", "/v1/chat/completions", timestamp, "tenant-a", "user-a"].join("\n");
    assert.equal(resolveRequestIdentity(fakeRequest({
      ...base,
      "x-cli-proxy-identity-signature": createHmac("sha256", secret).update(v1Payload).digest("hex"),
    })), null, "an explicit workspace cannot downgrade to v1");
    assert.equal(resolveRequestIdentity(fakeRequest({
      ...base,
      "x-cli-proxy-workspace-id": "",
      "x-cli-proxy-identity-signature": createHmac("sha256", secret).update(v1Payload).digest("hex"),
    })), null, "an empty-but-present workspace header cannot downgrade to v1");
  });

  test("rejects workspace path traversal and can require signed v2 identities", () => {
    const secret = "identity-secret-that-is-long-enough";
    process.env.USER_IDENTITY_HMAC_SECRET = secret;
    const timestamp = String(Math.floor(Date.now() / 1000));
    for (const workspaceId of ["../agent", "/absolute", ".hidden", "agent/name", "agent..name", "%2e%2e"]) {
      resetCapturedProxySecrets();
      process.env.USER_IDENTITY_HMAC_SECRET = secret;
      initRequestIdentity();
      const payload = [
	"v2", "POST", "/v1/chat/completions", timestamp, "tenant-a", "user-a", workspaceId,
      ].join("\n");
      assert.equal(resolveRequestIdentity(fakeRequest({
	"x-cli-proxy-tenant-id": "tenant-a",
	"x-cli-proxy-user-id": "user-a",
	"x-cli-proxy-workspace-id": workspaceId,
	"x-cli-proxy-identity-timestamp": timestamp,
	"x-cli-proxy-identity-signature": createHmac("sha256", secret).update(payload).digest("hex"),
      })), null, `workspace traversal must be rejected: ${workspaceId}`);
    }

    resetCapturedProxySecrets();
    process.env.USER_IDENTITY_HMAC_SECRET = secret;
    process.env.PROXY_REQUIRE_IDENTITY_V2 = "1";
    initRequestIdentity();
    const v1Payload = ["v1", "POST", "/v1/chat/completions", timestamp, "tenant-a", "user-a"].join("\n");
    assert.equal(resolveRequestIdentity(fakeRequest({
      "x-cli-proxy-tenant-id": "tenant-a",
      "x-cli-proxy-user-id": "user-a",
      "x-cli-proxy-identity-timestamp": timestamp,
      "x-cli-proxy-identity-signature": createHmac("sha256", secret).update(v1Payload).digest("hex"),
    })), null);
    delete process.env.PROXY_REQUIRE_IDENTITY_V2;
  });

  test("fails closed on malformed mapping configuration", () => {
    process.env.USER_API_KEYS = JSON.stringify([{ key: "short", tenantId: "tenant-a" }]);
    assert.throws(() => initRequestIdentity(), /requires key, tenantId, and userId/);
  });

  test("rejects malformed, non-array, non-object, and duplicate mapping entries", () => {
    process.env.USER_API_KEYS = "{";
    assert.throws(() => initRequestIdentity(), /valid JSON/);

    resetCapturedProxySecrets();
    process.env.USER_API_KEYS = JSON.stringify({});
    assert.throws(() => initRequestIdentity(), /JSON array/);

    resetCapturedProxySecrets();
    process.env.USER_API_KEYS = JSON.stringify(["not-an-object"]);
    assert.throws(() => initRequestIdentity(), /entry must be an object/);

    resetCapturedProxySecrets();
    process.env.USER_API_KEYS = JSON.stringify([
      { key: "user-key-12345678", tenantId: "tenant-a", userId: "user-a" },
      { key: "user-key-12345678", tenantId: "tenant-b", userId: "user-b" },
    ]);
    assert.throws(() => initRequestIdentity(), /duplicate key/);
  });

  test("rejects a short HMAC secret and stale or malformed signatures", () => {
    process.env.USER_IDENTITY_HMAC_SECRET = "too-short";
    assert.throws(() => initRequestIdentity(), /at least 32 bytes/);

    resetCapturedProxySecrets();
    process.env.USER_IDENTITY_HMAC_SECRET = "identity-secret-that-is-long-enough";
    initRequestIdentity();
    const stale = String(Math.floor(Date.now() / 1000) - 301);
    const staleRequest = fakeRequest({
      "x-cli-proxy-tenant-id": "tenant-a",
      "x-cli-proxy-user-id": "user-a",
      "x-cli-proxy-identity-timestamp": stale,
      "x-cli-proxy-identity-signature": "0".repeat(64),
    });
    assert.equal(resolveRequestIdentity(staleRequest), null);
    assert.equal(resolveRequestIdentity(fakeRequest({
      "x-cli-proxy-tenant-id": "tenant-a",
      "x-cli-proxy-user-id": "user-a",
      "x-cli-proxy-identity-timestamp": "invalid",
      "x-cli-proxy-identity-signature": "invalid",
    })), null);
  });

  test("exposes mapped keys and refuses identity lookup before middleware", () => {
    process.env.USER_API_KEYS = JSON.stringify([
      { key: "user-key-12345678", tenantId: "tenant-a", userId: "user-a" },
    ]);
    initRequestIdentity();
    assert.deepEqual(mappedCompletionKeys(), ["user-key-12345678"]);
    assert.equal(requestUsesMappedIdentity(fakeRequest({ authorization: "Bearer user-key-12345678" })), true);
    assert.equal(requestUsesMappedIdentity(fakeRequest({ authorization: "Bearer another-key" })), false);
    assert.throws(() => requestIdentity(fakeRequest({})), /middleware did not run/);
  });
});
