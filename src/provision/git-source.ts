/** Shared validation and normalization for manifest-provided git sources. */

export const GIT_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export function isGitObjectId(value: unknown): value is string {
  return typeof value === "string" && GIT_OBJECT_ID_PATTERN.test(value);
}

/** Conservative equivalent of `git check-ref-format --branch`, without a subprocess. */
export function isValidGitBranch(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 255) return false;
  if (value === "@" || value.startsWith("-") || value.startsWith("/")
    || value.endsWith("/") || value.endsWith(".") || value.includes("..")
    || value.includes("@{") || value.includes("//")
    || /[\x00-\x20\x7f~^:?*\[\\]/.test(value)) return false;
  return value.split("/").every((part) => part && !part.startsWith(".") && !part.endsWith(".lock"));
}

export function isValidGitRevision(value: unknown): value is string {
  return isGitObjectId(value) || isValidGitBranch(value);
}

export function isCanonicalGitPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024
    && !/[\x00-\x1f\x7f\\]/.test(value)
    && !value.startsWith("/") && !value.endsWith("/")
    && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export interface GitHubTreeSource {
  url: string;
  rev: string;
  path?: string;
}

/**
 * Convert a GitHub browser directory URL into clone URL + branch + subpath.
 * The browser form has no delimiter for slash-containing branch names, so this
 * shorthand intentionally treats the first segment after `/tree/` as the ref.
 */
export function parseGitHubTreeUrl(rawUrl: string): GitHubTreeSource | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com"
    || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash) return null;

  let segments: string[];
  try {
    segments = parsed.pathname.split("/").slice(1).map((part) => decodeURIComponent(part));
  } catch {
    return null;
  }
  if (segments.length < 4 || segments[2] !== "tree") return null;
  const [owner, repository, , rev, ...pathParts] = segments;
  if (!owner || !repository || !rev || owner.includes("/") || repository.includes("/") || rev.includes("/")) {
    return null;
  }
  const subpath = pathParts.join("/");
  return {
    url: `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository.replace(/\.git$/, ""))}.git`,
    rev,
    ...(subpath ? { path: subpath } : {}),
  };
}
