/**
 * "Is this Claude CLI failure a missing-credentials failure?" for the DIRECT
 * ClaudeSubprocess path.
 *
 * The Paperclip path gets this classification for free — the adapter returns
 * errorCode "claude_auth_required" and adapter-error.ts maps it. The direct path
 * has no adapter, so it must recognise the CLI's own wording itself. The pattern
 * is kept deliberately in step with @paperclipai/adapter-claude-local's, which
 * is not importable: the package's `exports` map exposes only ./server, and its
 * login detector is not re-exported there.
 */

/**
 * Matches the ways the CLI says "log in first". `invalid api key` alone is not
 * enough — it also appears in ordinary assistant text about API keys — so it
 * only counts when a login instruction follows nearby.
 */
const CLAUDE_AUTH_REQUIRED_RE =
  /(?:not\s+logged\s+in|please\s+log\s+in|please\s+run\s+(?:`?claude\s+login`?|\/login)|login\s+required|requires\s+login|unauthorized|authentication\s+required|oauth\s+token\s+(?:expired|revoked|invalid)|invalid\s+api\s+key[\s\S]{0,120}(?:\/login|claude\s+login|log\s+in))/i;

/**
 * Callers MUST gate this on an already-failed run (`is_error`, or a nonzero
 * exit). On its own the pattern would match a successful completion that merely
 * discusses logins, which would turn a valid answer into a 401.
 */
export function isClaudeAuthRequired(...texts: Array<string | null | undefined>): boolean {
  return texts.some((text) => Boolean(text) && CLAUDE_AUTH_REQUIRED_RE.test(text as string));
}
