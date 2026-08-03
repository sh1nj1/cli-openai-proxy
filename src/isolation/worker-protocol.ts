/**
 * Private worker-to-gateway response metadata. The gateway strips this header
 * before answering the caller; it may contain a manifest URL with credentials.
 */
export const AUTHORIZED_PROVISIONING_HEADER = "x-cli-proxy-authorized-provisioning";
/** Gateway-issued ordering identity, echoed by the worker with an authorized URL. */
export const PROVISIONING_GENERATION_HEADER = "x-cli-proxy-provisioning-generation";
/** Gateway-selected auth-session lifetime shared with an isolated worker. */
export const PROVISIONING_SESSION_TTL_HEADER = "x-cli-proxy-provisioning-session-ttl-ms";
/** Exact prior gateway binding that the worker disposed while starting a session. */
export const SUPERSEDED_PROVISIONING_GENERATION_HEADER = "x-cli-proxy-superseded-provisioning-generation";
/** Gateway-only signal that a worker may advertise the relative auth UI path. */
export const AUTH_UI_AVAILABLE_HEADER = "x-cli-proxy-auth-ui-available";
/** Leaves ample room under Node's default aggregate HTTP header limit. */
export const MAX_AUTHORIZED_PROVISIONING_HEADER_BYTES = 8 * 1024;

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function encodeProvisioningUrl(url: string): string {
  return Buffer.from(url, "utf8").toString("base64url");
}

export function provisioningUrlFitsHeader(url: string): boolean {
  return Buffer.byteLength(encodeProvisioningUrl(url), "ascii") <= MAX_AUTHORIZED_PROVISIONING_HEADER_BYTES;
}

export function decodeProvisioningUrl(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    return new URL(decoded).toString();
  } catch {
    return undefined;
  }
}

export function decodeProvisioningGeneration(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && UUID_V7.test(value) ? value.toLowerCase() : undefined;
}

export function decodeProvisioningSessionTtl(value: string | string[] | undefined): number | undefined {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return undefined;
  const ttlMs = Number(value);
  return Number.isSafeInteger(ttlMs) ? ttlMs : undefined;
}
