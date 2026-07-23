import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { materializeImages, ImageValidationError } from "./image-materializer.js";
import type { OpenAIChatMessage } from "../types/openai.js";

// "hello" as raw bytes, base64-encoded. The materializer decodes bytes verbatim;
// it does not parse image structure, so any payload exercises the write path.
const HELLO_B64 = Buffer.from("hello").toString("base64");
const pngDataUrl = `data:image/png;base64,${HELLO_B64}`;

describe("materializeImages", () => {
  it("leaves string content untouched and returns a no-op cleanup", async () => {
    const messages: OpenAIChatMessage[] = [{ role: "user", content: "just text" }];
    const { messages: out, cleanup } = await materializeImages(messages);
    assert.equal(out[0].content, "just text");
    await cleanup(); // must not throw
  });

  it("writes a data-URL image to a temp file and replaces the part with a markdown link", async () => {
    const messages: OpenAIChatMessage[] = [
      { role: "user", content: [{ type: "image_url", image_url: { url: pngDataUrl } }] },
    ];
    const { messages: out, cleanup } = await materializeImages(messages);
    const parts = out[0].content as any[];
    assert.equal(parts.length, 1);
    assert.equal(parts[0].type, "text");
    const m = /^!\[image\]\((.+)\)$/.exec(parts[0].text);
    assert.ok(m, `expected markdown image link, got: ${parts[0].text}`);
    const filePath = m![1];
    assert.ok(filePath.endsWith(".png"), `expected .png path, got ${filePath}`);
    assert.ok(existsSync(filePath), "materialized file should exist");
    assert.equal(readFileSync(filePath).toString(), "hello");
    await cleanup();
    assert.ok(!existsSync(filePath), "cleanup should remove the materialized file");
  });

  it("derives .jpg extension from image/jpeg", async () => {
    const messages: OpenAIChatMessage[] = [
      { role: "user", content: [{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${HELLO_B64}` } }] },
    ];
    const { messages: out, cleanup } = await materializeImages(messages);
    const parts = out[0].content as any[];
    const filePath = /\((.+)\)$/.exec(parts[0].text)![1];
    assert.ok(filePath.endsWith(".jpg"), `expected .jpg, got ${filePath}`);
    await cleanup();
  });

  it("preserves surrounding text parts in place", async () => {
    const messages: OpenAIChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "before" },
          { type: "image_url", image_url: { url: pngDataUrl } },
          { type: "text", text: "after" },
        ],
      },
    ];
    const { messages: out, cleanup } = await materializeImages(messages);
    const parts = out[0].content as any[];
    assert.equal(parts.length, 3);
    assert.equal(parts[0].text, "before");
    assert.match(parts[1].text, /^!\[image\]\(.+\.png\)$/);
    assert.equal(parts[2].text, "after");
    await cleanup();
  });

  it("passes http(s) image URLs through as inline links without downloading", async () => {
    const url = "https://example.com/cat.png";
    const messages: OpenAIChatMessage[] = [
      { role: "user", content: [{ type: "image_url", image_url: { url } }] },
    ];
    const { messages: out, cleanup } = await materializeImages(messages);
    const parts = out[0].content as any[];
    assert.equal(parts[0].type, "text");
    assert.equal(parts[0].text, `![image](${url})`);
    await cleanup();
  });

  it("rejects unsupported MIME types with a 400-style validation error", async () => {
    const messages: OpenAIChatMessage[] = [
      { role: "user", content: [{ type: "image_url", image_url: { url: `data:image/tiff;base64,${HELLO_B64}` } }] },
    ];
    await assert.rejects(() => materializeImages(messages), ImageValidationError);
  });

  it("rejects images larger than the size limit", async () => {
    // 21MB of decoded bytes (limit is 20MB)
    const big = Buffer.alloc(21 * 1024 * 1024, 0x41).toString("base64");
    const messages: OpenAIChatMessage[] = [
      { role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${big}` } }] },
    ];
    await assert.rejects(() => materializeImages(messages), ImageValidationError);
  });

  it("rejects non-base64 data URLs", async () => {
    const messages: OpenAIChatMessage[] = [
      { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png,notbase64" } }] },
    ];
    await assert.rejects(() => materializeImages(messages), ImageValidationError);
  });

  it("rejects malformed base64 payloads instead of writing a bogus file", async () => {
    // Buffer.from is permissive: "!!!!" decodes to an empty buffer rather than throwing,
    // so without validation the proxy would write a 0-byte file and start the runner.
    for (const bad of ["!!!!", "not*valid*base64", "AB", "abc"]) {
      const messages: OpenAIChatMessage[] = [
        { role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${bad}` } }] },
      ];
      await assert.rejects(
        () => materializeImages(messages),
        ImageValidationError,
        `expected rejection for payload ${JSON.stringify(bad)}`
      );
    }
  });

  it("accepts base64 payloads containing whitespace/newlines", async () => {
    // Real data URLs sometimes wrap base64 across lines; whitespace must not be treated as malformed.
    const wrapped = HELLO_B64.slice(0, 2) + "\n  " + HELLO_B64.slice(2);
    const messages: OpenAIChatMessage[] = [
      { role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${wrapped}` } }] },
    ];
    const { messages: out, cleanup } = await materializeImages(messages);
    const parts = out[0].content as any[];
    const filePath = /\((.+)\)$/.exec(parts[0].text)![1];
    assert.equal(readFileSync(filePath).toString(), "hello");
    await cleanup();
  });

  it("rejects an image_url part with a missing or empty url instead of silently dropping it", async () => {
    // A falsy url would otherwise fall through unchanged and be dropped by extractText — a silent no-op.
    const cases: unknown[] = [undefined, "", { type: "image_url" }];
    for (const bad of cases) {
      const part =
        bad && typeof bad === "object" ? bad : { type: "image_url", image_url: { url: bad } };
      const messages: OpenAIChatMessage[] = [{ role: "user", content: [part as any] }];
      await assert.rejects(
        () => materializeImages(messages),
        ImageValidationError,
        `expected rejection for ${JSON.stringify(bad)}`
      );
    }
  });

  it("rejects a non-string image_url.url with a validation error rather than a 500", async () => {
    // A truthy non-string url would reach materializePart and throw on .startsWith → generic 500.
    const messages: OpenAIChatMessage[] = [
      { role: "user", content: [{ type: "image_url", image_url: { url: 12345 as any } }] },
    ];
    await assert.rejects(() => materializeImages(messages), ImageValidationError);
  });

  it("cleans up temp files even when a later image in the batch fails validation", async () => {
    // First image is valid (gets written), second is unsupported → must reject AND not leak the first file.
    let leaked = "";
    const messages: OpenAIChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: pngDataUrl } },
          { type: "image_url", image_url: { url: `data:image/tiff;base64,${HELLO_B64}` } },
        ],
      },
    ];
    await assert.rejects(async () => {
      const r = await materializeImages(messages);
      leaked = "should not reach here";
      await r.cleanup();
    }, ImageValidationError);
    assert.equal(leaked, "", "must reject before returning");
  });
});
