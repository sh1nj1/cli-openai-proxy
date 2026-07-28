import { test, describe } from "node:test";
import assert from "node:assert";
import { extractOsc8Links, findVerificationUrl, stripAnsi } from "./terminal-scrape.js";

const AUTHORIZE = "https://claude.com/oauth/authorize?client_id=abc&state=xyz&code=true";
const osc8 = (url: string, label = "link") => `\x1b]8;id=1;${url}\x1b\\${label}\x1b]8;;\x1b\\`;

describe("terminal-scrape", () => {
  test("stripAnsi removes CSI cursor moves and OSC sequences", () => {
    assert.strictEqual(stripAnsi("Paste\x1b[8Gcode\x1b[0m here"), "Pastecode here");
    assert.strictEqual(stripAnsi(osc8("https://x.test", "label")), "label");
  });

  test("extractOsc8Links returns hyperlink targets in order, deduplicated", () => {
    const buffer = `${osc8("https://a.test")}\n${osc8("https://b.test")}\n${osc8("https://a.test")}`;
    assert.deepStrictEqual(extractOsc8Links(buffer), ["https://a.test", "https://b.test"]);
  });

  test("extractOsc8Links accepts BEL-terminated links", () => {
    assert.deepStrictEqual(extractOsc8Links(`\x1b]8;;https://bel.test\x07text`), ["https://bel.test"]);
  });

  // The visible text is hard-wrapped across terminal columns; only the hyperlink
  // target survives intact. This is the whole reason the OSC-8 path exists.
  test("finds the URL from the hyperlink target even when the displayed text wraps", () => {
    const wrapped = "https://claude.com/oauth/aut\r\nhorize?client_id=abc&state=x\r\nyz&code=true";
    const buffer = `Browser didn't open? Use the url below:\n${osc8(AUTHORIZE, wrapped)}\n`;
    assert.strictEqual(findVerificationUrl(buffer), AUTHORIZE);
  });

  test("ignores links that the accept predicate rejects", () => {
    const buffer = `${osc8("https://docs.claude.com/help")}\n${osc8(AUTHORIZE)}`;
    assert.strictEqual(
      findVerificationUrl(buffer, (u) => u.includes("/oauth/authorize")),
      AUTHORIZE,
    );
  });

  test("falls back to a plain-text URL when no OSC-8 link is present", () => {
    assert.strictEqual(
      findVerificationUrl(`Open ${AUTHORIZE} to continue`, (u) => u.includes("/oauth/authorize")),
      AUTHORIZE,
    );
  });

  test("returns null before any URL has been printed", () => {
    assert.strictEqual(findVerificationUrl("Starting login...\n", (u) => u.includes("/oauth/authorize")), null);
  });
});
