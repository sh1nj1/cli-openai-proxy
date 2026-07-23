/**
 * Materializes OpenAI `image_url` content parts so the downstream CLI adapters
 * can see them. Runs BEFORE openaiToCli, so every adapter (claude, codex, ...)
 * is common by construction — extractText/messagesToPrompt stay image-unaware.
 *
 * Each `image_url` part is replaced in place with a `text` part holding a
 * markdown image link. data: URLs are decoded to a per-request temp file whose
 * absolute path is linked (all CLI lanes read absolute paths); http(s) URLs are
 * passed through verbatim without a server-side fetch (no SSRF surface).
 */

import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { OpenAIChatMessage, OpenAIContentPart } from "../types/openai.js";

/** Thrown for client-side image problems (unsupported type, too large, malformed). */
export class ImageValidationError extends Error {}

export interface MaterializeResult {
  messages: OpenAIChatMessage[];
  cleanup: () => Promise<void>;
}

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

// Decoded-byte ceiling; oversized payloads are a client error, not silent truncation.
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

function toMarkdownLink(target: string): OpenAIContentPart {
  // A bare markdown destination ends at the first unbalanced ')' and cannot hold
  // whitespace, so a URL like ".../cat).png" would truncate the link and the CLI
  // would never see the image. Wrap such targets in CommonMark's <...> delimited
  // form (escaping the chars still special there). Safe targets — our own temp
  // paths, plain URLs — stay bare so the emitted prompt matches the tested output.
  if (/[()<>\s]/.test(target)) {
    const escaped = target.replace(/[\\<>]/g, "\\$&");
    return { type: "text", text: `![image](<${escaped}>)` };
  }
  return { type: "text", text: `![image](${target})` };
}

export async function materializeImages(
  messages: OpenAIChatMessage[]
): Promise<MaterializeResult> {
  let tmpDir: string | undefined;
  let count = 0;

  const cleanup = async (): Promise<void> => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  };

  const materializeDataUrl = async (url: string): Promise<string> => {
    const comma = url.indexOf(",");
    if (comma === -1) {
      throw new ImageValidationError("Malformed data URL: missing comma separator");
    }
    const header = url.slice("data:".length, comma); // e.g. "image/png;base64"
    const segments = header.split(";");
    const mime = segments[0].toLowerCase();
    if (!segments.slice(1).some((s) => s.toLowerCase() === "base64")) {
      throw new ImageValidationError("Only base64-encoded data URLs are supported");
    }
    const ext = MIME_EXT[mime];
    if (!ext) {
      throw new ImageValidationError(`Unsupported image type: ${mime || "unknown"}`);
    }
    // Buffer.from(..., "base64") silently drops invalid chars and returns a
    // truncated/empty buffer instead of throwing, which would write a bogus file
    // and start the runner. Reject anything that is not canonical base64 up front.
    const payload = url.slice(comma + 1).replace(/\s/g, "");
    if (payload.length === 0 || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) {
      throw new ImageValidationError("Malformed base64 image data");
    }
    const bytes = Buffer.from(payload, "base64");
    if (bytes.length === 0) {
      throw new ImageValidationError("Malformed base64 image data");
    }
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new ImageValidationError(
        `Image exceeds ${MAX_IMAGE_BYTES} byte limit (${bytes.length} bytes)`
      );
    }
    if (!tmpDir) {
      tmpDir = await mkdtemp(join(tmpdir(), "claude-max-img-"));
    }
    const filePath = join(tmpDir, `${count++}.${ext}`);
    await writeFile(filePath, bytes);
    return filePath;
  };

  const materializePart = async (url: string): Promise<OpenAIContentPart> => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      return toMarkdownLink(url); // pass through; agent CLI fetches if it chooses
    }
    if (url.startsWith("data:")) {
      return toMarkdownLink(await materializeDataUrl(url));
    }
    throw new ImageValidationError(`Unsupported image URL scheme: ${url.slice(0, 16)}`);
  };

  try {
    const out: OpenAIChatMessage[] = [];
    for (const msg of messages) {
      if (!Array.isArray(msg.content)) {
        out.push(msg);
        continue;
      }
      const parts: OpenAIContentPart[] = [];
      for (const part of msg.content) {
        if (part.type === "image_url") {
          // Request bodies aren't runtime-typed: a missing/empty url would fall
          // through and be dropped silently by extractText, and a non-string url
          // would throw on .startsWith → generic 500. Reject both as 400 here.
          const url = part.image_url?.url;
          if (typeof url !== "string" || url.length === 0) {
            throw new ImageValidationError("image_url.url must be a non-empty string");
          }
          parts.push(await materializePart(url));
        } else {
          parts.push(part);
        }
      }
      out.push({ ...msg, content: parts });
    }
    return { messages: out, cleanup };
  } catch (err) {
    await cleanup(); // never leak temp files when the batch fails partway
    throw err;
  }
}
