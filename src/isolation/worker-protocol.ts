/**
 * Private worker-to-gateway response metadata. The gateway strips this header
 * before answering the caller; it may contain a manifest URL with credentials.
 */
export const AUTHORIZED_PROVISIONING_HEADER = "x-cli-proxy-authorized-provisioning";

export function encodeProvisioningUrl(url: string): string {
  return Buffer.from(url, "utf8").toString("base64url");
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
