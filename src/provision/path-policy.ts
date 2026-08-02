import path from "path";

/** Maximum path length that can be persisted in the provisioning lockfile. */
export const MAX_MANAGED_PATH_LENGTH = 1024;

/**
 * Parse a lockfile path into its canonical `/`-separated components.
 * Backslashes remain literal filename characters on Unix; Windows rejects
 * them because they would be interpreted as separators by the filesystem.
 */
export function managedPathParts(value: unknown): string[] | null {
  if (
    typeof value !== "string"
    || !value
    || value.length > MAX_MANAGED_PATH_LENGTH
    || value.includes("\0")
    || path.isAbsolute(value)
    || (path.sep === "\\" && value.includes("\\"))
  ) {
    return null;
  }
  const parts = value.split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== "..") ? parts : null;
}
