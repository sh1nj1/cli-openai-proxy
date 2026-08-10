import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CODEX_CUSTOM_API_KEY_ENV,
  CodexCustomApiKeySession,
  fetchGatewayProbe,
  normalizeGatewayBaseUrl,
  type ProbeGatewayFn,
} from "./codex-custom-api-key.js";
import { AuthProvisioningError } from "../types.js";

const accept: ProbeGatewayFn = async () => ({ accepted: true });

function codeOf(fn: () => Promise<unknown>): Promise<string> {
  return fn().then(
    () => assert.fail("expected a rejection"),
    (err) => {
      assert.ok(err instanceof AuthProvisioningError, `not an AuthProvisioningError: ${err}`);
      return err.code;
    },
  );
}

test("strips the trailing slash the CLI would double", () => {
  // codex builds "<base>/responses".
  assert.equal(normalizeGatewayBaseUrl("https://openrouter.ai/api/v1/"), "https://openrouter.ai/api/v1");
  assert.equal(normalizeGatewayBaseUrl("  https://openrouter.ai/api/v1  "), "https://openrouter.ai/api/v1");
});

test("refuses URLs that would misroute the key rather than repairing them", async () => {
  const cases: Array<[string, string]> = [
    ["", "missing_base_url"],
    ["openrouter.ai/api/v1", "invalid_base_url"],
    ["ftp://openrouter.ai/v1", "invalid_base_url"],
    // The key rides to this URL as a bearer token on every request.
    ["http://openrouter.ai/api/v1", "insecure_base_url"],
    ["https://user:pw@openrouter.ai/api/v1", "invalid_base_url"],
    // "<base>/responses" would drop everything after the "?".
    ["https://openrouter.ai/api/v1?key=x", "invalid_base_url"],
    ["https://openrouter.ai/api/v1#frag", "invalid_base_url"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(await codeOf(async () => normalizeGatewayBaseUrl(input)), expected, `for ${input || "(empty)"}`);
  }
});

test("allows plaintext http on loopback, where it cannot leave the machine", () => {
  assert.equal(normalizeGatewayBaseUrl("http://127.0.0.1:4599/v1"), "http://127.0.0.1:4599/v1");
  assert.equal(normalizeGatewayBaseUrl("http://localhost:4599/v1"), "http://localhost:4599/v1");
});

test("stores the key with the gateway it authenticates against", async () => {
  const session = new CodexCustomApiKeySession({ probe: accept });

  const result = await session.submit(" sk-test ", { baseUrl: "https://openrouter.ai/api/v1/" });

  assert.deepEqual(result.credential, {
    envVar: CODEX_CUSTOM_API_KEY_ENV,
    value: "sk-test",
    gateway: { baseUrl: "https://openrouter.ai/api/v1" },
  });
});

test("refuses a key with no gateway: it does not say where to spend it", async () => {
  const session = new CodexCustomApiKeySession({ probe: accept });

  assert.equal(await codeOf(() => session.submit("sk-test")), "missing_base_url");
  assert.equal(await codeOf(() => session.submit("   ", { baseUrl: "https://x.example/v1" })), "empty_api_key");
});

test("a definitive gateway rejection fails the submission", async () => {
  const session = new CodexCustomApiKeySession({
    probe: async () => ({ accepted: false, detail: "The gateway rejected the API key (HTTP 401)" }),
  });

  assert.equal(await codeOf(() => session.submit("bad", { baseUrl: "https://x.example/v1" })), "invalid_api_key");
});

test("an unreachable gateway is reported as such, never as a bad key", async () => {
  const session = new CodexCustomApiKeySession({
    probe: async () => { throw new AuthProvisioningError("nope", "gateway_unreachable"); },
  });

  assert.equal(await codeOf(() => session.submit("sk", { baseUrl: "https://x.example/v1" })), "gateway_unreachable");
});

test("a probe slower than the timeout does not hang the request", async () => {
  const session = new CodexCustomApiKeySession({
    timeoutMs: 5,
    probe: (_base, _key, signal) =>
      new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))),
  });

  assert.equal(await codeOf(() => session.submit("sk", { baseUrl: "https://x.example/v1" })), "gateway_unreachable");
});

test("a verdict that lands after cancel is refused, not stored", async () => {
  // A superseded submit must not hand the session manager a credential.
  const session = new CodexCustomApiKeySession({ probe: accept });
  session.cancel();

  assert.equal(await codeOf(() => session.submit("sk", { baseUrl: "https://x.example/v1" })), "session_cancelled");
});

test("probe treats 401/403 as a verdict and everything else as none", async () => {
  const seen: Array<{ url: string; auth: string | null }> = [];
  const fakeFetch = (status: number): typeof fetch =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: String(url),
        auth: new Headers(init?.headers).get("authorization"),
      });
      return new Response(null, { status });
    }) as unknown as typeof fetch;

  const rejected = await fetchGatewayProbe(fakeFetch(401))(
    "https://x.example/v1", "sk", new AbortController().signal,
  );
  assert.equal(rejected.accepted, false);
  assert.deepEqual(seen[0], { url: "https://x.example/v1/models", auth: "Bearer sk" });

  // OpenRouter serves /models unauthenticated, so a 200 proves the URL is live
  // but says nothing about the key — which is not a reason to reject it.
  for (const status of [200, 404, 500]) {
    const verdict = await fetchGatewayProbe(fakeFetch(status))(
      "https://x.example/v1", "sk", new AbortController().signal,
    );
    assert.equal(verdict.accepted, true, `HTTP ${status} must not be read as a bad key`);
  }
});

test("probe never echoes a transport error that could quote the key", async () => {
  const leaky = (async () => { throw new Error("bad header value: sk-secret-123"); }) as unknown as typeof fetch;

  const err = await fetchGatewayProbe(leaky)("https://x.example/v1", "sk-secret-123", new AbortController().signal)
    .then(() => assert.fail("expected a rejection"), (e: unknown) => e as Error);

  assert.ok(!err.message.includes("sk-secret-123"), `leaked the key: ${err.message}`);
  assert.match(err.message, /Could not reach the gateway/);
});
