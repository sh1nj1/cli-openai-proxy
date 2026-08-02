/**
 * Manifest parsing and URL policy.
 *
 * Everything here is validation of REMOTE input: the manifest is fetched from a
 * URL an admin registered, but its contents (and the artifact URLs inside it)
 * are whatever that server chose to send. Parse errors are ProvisionError so
 * routes can answer with a code instead of a stack trace.
 */

import {
  ProvisionError,
  SUPPORTED_PROVISION_TYPES,
  type ProvisionItem,
  type ProvisionManifest,
} from "./types.js";

export const MANIFEST_SCHEMA = "agent-provisioning/v1";

/**
 * Names become directory segments under a type's sandbox, so the charset is the
 * whole traversal defense at this layer: lowercase only (so keys remain unique
 * on case-insensitive filesystems), no separators, no dots, bounded length.
 */
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Route params share the manifest's name rules — one charset, one traversal defense. */
export function isValidItemName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

function invalidItem(index: number, reason: string): ProvisionError {
  return new ProvisionError(`items[${index}]: ${reason}`, "invalid_item");
}

export function parseManifest(raw: unknown): ProvisionManifest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ProvisionError("Manifest must be a JSON object", "invalid_manifest");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.schema !== MANIFEST_SCHEMA) {
    throw new ProvisionError(
      `Manifest schema must be "${MANIFEST_SCHEMA}"`,
      "invalid_manifest",
    );
  }
  if (!Array.isArray(obj.items)) {
    throw new ProvisionError("Manifest must carry an `items` array", "invalid_manifest");
  }

  const seen = new Set<string>();
  const items: ProvisionItem[] = obj.items.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw invalidItem(index, "must be an object");
    }
    const item = entry as Record<string, unknown>;
    if (typeof item.type !== "string" || !item.type.trim()) {
      throw invalidItem(index, "missing `type`");
    }
    if (typeof item.name !== "string" || !NAME_PATTERN.test(item.name)) {
      throw invalidItem(index, "`name` must match [a-z0-9][a-z0-9_-]{0,63}");
    }
    const key = `${item.type}/${item.name}`;
    if (seen.has(key)) throw invalidItem(index, `duplicate item "${key}"`);
    seen.add(key);

    // Only supported types get their artifact fields enforced: an unknown type
    // may carry a shape this version cannot judge, and it only ever reports
    // `unsupported` — it never reaches a download.
    if (SUPPORTED_PROVISION_TYPES.has(item.type)) {
      if (typeof item.url !== "string" || !item.url.trim()) {
        throw invalidItem(index, "missing `url`");
      }
      if (typeof item.sha256 !== "string" || !SHA256_PATTERN.test(item.sha256)) {
        throw invalidItem(index, "`sha256` must be 64 hex chars");
      }
    }
    return {
      type: item.type,
      name: item.name,
      url: typeof item.url === "string" ? item.url : undefined,
      sha256: typeof item.sha256 === "string" ? item.sha256.toLowerCase() : undefined,
    };
  });

  return { schema: MANIFEST_SCHEMA, items };
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * URL policy for both the manifest and every artifact inside it.
 *
 * With no PROVISION_ALLOWLIST, artifacts must come from the manifest's own
 * host — registering a manifest URL is the trust decision, and the default
 * must not let that manifest fan out to arbitrary origins. An explicit
 * allowlist replaces that rule for both kinds of URL. Plain http is refused
 * except on loopback (local testing), since sha256 pinning cannot protect the
 * request that carries the manifest itself.
 */
export function checkUrlAllowed(
  rawUrl: string,
  opts: { manifestUrl?: string; allowlist: string[] | null },
): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ProvisionError(`Not a valid URL: ${rawUrl}`, "invalid_url");
  }
  // Node fetch rejects userinfo, and translating it to Authorization could
  // leak credentials across redirect origins. Signed query URLs remain valid.
  if (url.username || url.password) {
    throw new ProvisionError("URL credentials are not supported", "url_not_allowed");
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(host))) {
    throw new ProvisionError(`Refusing non-https URL: ${rawUrl}`, "url_not_allowed");
  }
  if (opts.allowlist !== null) {
    if (!opts.allowlist.includes(host)) {
      throw new ProvisionError(
        `Host "${host}" is not in PROVISION_ALLOWLIST`,
        "url_not_allowed",
      );
    }
    return;
  }
  if (opts.manifestUrl !== undefined) {
    const manifestHost = new URL(opts.manifestUrl).hostname.toLowerCase();
    if (host !== manifestHost) {
      throw new ProvisionError(
        `Host "${host}" differs from the manifest host "${manifestHost}"; set PROVISION_ALLOWLIST to allow it`,
        "url_not_allowed",
      );
    }
  }
}

const MAX_REDIRECTS = 5;

/** Read a remote body without allowing an endpoint to exhaust process memory. */
export async function readResponseBody(
  response: Response,
  opts: { maxBytes: number; tooLargeCode: string; readErrorCode: string; label: string },
): Promise<Buffer> {
  const body = response.body;
  if (!body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      let step: { done: boolean; value?: Uint8Array };
      try {
	step = await reader.read();
      } catch (err) {
	const reason = err instanceof Error ? err.message : String(err);
	throw new ProvisionError(`${opts.label} read failed: ${reason}`, opts.readErrorCode);
      }
      if (step.done || !step.value) break;
      total += step.value.byteLength;
      if (total > opts.maxBytes) {
	throw new ProvisionError(`${opts.label} exceeds ${opts.maxBytes} bytes`, opts.tooLargeCode);
      }
      chunks.push(Buffer.from(step.value));
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Cancellation is best-effort, but the next transfer must not start while
      // this response is still releasing its stream resources.
    }
  }
  return Buffer.concat(chunks);
}

/**
 * fetch() follows redirects on its own, which would let an allowed host bounce
 * the request to one the policy would refuse. This walks redirects manually and
 * re-applies `checkUrl` to every hop, so the policy holds for the URL actually
 * fetched, not just the one registered.
 */
export async function fetchWithPolicy(
  rawUrl: string,
  opts: { checkUrl: (url: string) => void; timeoutMs: number; failCode: string },
): Promise<Response> {
  let url = rawUrl;
  const signal = AbortSignal.timeout(opts.timeoutMs);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    opts.checkUrl(url);
    let response: Response;
    try {
      response = await fetch(url, { redirect: "manual", signal });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new ProvisionError(`Fetch failed: ${reason}`, opts.failCode);
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    try {
      await response.body?.cancel();
    } catch {
      // Cancellation is best-effort; redirect policy must still be enforced.
    }
    const location = response.headers.get("location");
    if (!location) {
      throw new ProvisionError(`Redirect without a Location header from ${url}`, opts.failCode);
    }
    try {
      url = new URL(location, url).toString();
    } catch {
      throw new ProvisionError(`Redirect from ${url} has an invalid Location header`, opts.failCode);
    }
  }
  throw new ProvisionError(`Too many redirects fetching ${rawUrl}`, opts.failCode);
}

/** PROVISION_ALLOWLIST as lowercased hostnames; unset (null) means same-host-as-manifest. */
export function getAllowlist(): string[] | null {
  const raw = process.env.PROVISION_ALLOWLIST;
  if (raw === undefined || !raw.trim()) return null;
  return raw.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
}
