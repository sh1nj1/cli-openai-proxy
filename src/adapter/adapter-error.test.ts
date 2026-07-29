import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { adapterRunError, openaiErrorFromError } from "./adapter-error.js";

const failed = (over: Partial<AdapterExecutionResult>): AdapterExecutionResult =>
  ({ exitCode: 1, signal: null, timedOut: false, ...over }) as AdapterExecutionResult;

describe("adapter-error: engine auth classification", () => {
  // The caller must be able to tell "the CLI needs logging in" (drive /v1/auth)
  // apart from "your key is wrong" (fix the Authorization header). Both are 401,
  // so only the code distinguishes them.
  test("an unauthenticated CLI is engine_unauthenticated, not invalid_api_key", () => {
    const err = adapterRunError("Please run /login", failed({ errorCode: "claude_auth_required" }), "claude");
    const shape = openaiErrorFromError(err);

    assert.equal(shape.status, 401);
    assert.equal(shape.code, "engine_unauthenticated");
    assert.notEqual(shape.code, "invalid_api_key");
  });

  test("the failing engine is named so the caller knows which login flow to open", () => {
    assert.equal(openaiErrorFromError(
      adapterRunError("x", failed({ errorCode: "claude_auth_required" }), "codex"),
    ).engine, "codex");
  });

  test("engine is omitted for failures that are not an auth problem", () => {
    const quota = adapterRunError("limit", failed({ errorCode: "provider_quota" }), "claude");
    assert.equal(openaiErrorFromError(quota).engine, undefined);
    assert.equal(openaiErrorFromError(quota).status, 429);
  });

  test("a plain Error stays an internal 500 with no engine", () => {
    const shape = openaiErrorFromError(new Error("spawn failed"));
    assert.equal(shape.status, 500);
    assert.equal(shape.engine, undefined);
  });
});
