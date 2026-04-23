import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isValidSessionId } from "./manager.js";

describe("isValidSessionId", () => {
  it("accepts canonical UUIDs", () => {
    assert.equal(isValidSessionId("550e8400-e29b-41d4-a716-446655440000"), true);
    assert.equal(isValidSessionId("00000000-0000-0000-0000-000000000000"), true);
    assert.equal(isValidSessionId("F47AC10B-58CC-4372-A567-0E02B2C3D479"), true);
  });

  it("rejects non-UUID strings", () => {
    assert.equal(isValidSessionId("session-123"), false);
    assert.equal(isValidSessionId("user@example.com"), false);
    assert.equal(isValidSessionId("not-a-uuid"), false);
    assert.equal(isValidSessionId(""), false);
  });

  it("rejects UUID-like strings with extra content (CLI arg injection)", () => {
    assert.equal(
      isValidSessionId("550e8400-e29b-41d4-a716-446655440000 --evil-flag"),
      false
    );
    assert.equal(
      isValidSessionId("550e8400-e29b-41d4-a716-446655440000\n--evil"),
      false
    );
    assert.equal(
      isValidSessionId(" 550e8400-e29b-41d4-a716-446655440000"),
      false
    );
  });

  it("rejects malformed UUIDs", () => {
    assert.equal(isValidSessionId("550e8400-e29b-41d4-a716-44665544000"), false);
    assert.equal(isValidSessionId("550e8400e29b41d4a716446655440000"), false);
    assert.equal(isValidSessionId("zzzzzzzz-e29b-41d4-a716-446655440000"), false);
  });
});
