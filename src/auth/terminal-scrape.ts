/**
 * Scraping helpers for CLI output captured from a pty.
 *
 * A pty renders for a human: the CLI hard-wraps long URLs across terminal
 * columns and interleaves cursor-movement escapes, so the visible text of a URL
 * is unusable. `claude setup-token` also emits the URL as an OSC-8 hyperlink,
 * whose *target* is unwrapped and escape-free — that is the reliable seam, and
 * why link extraction is preferred over plain-text matching.
 */

// OSC 8 hyperlink: ESC ] 8 ; <params> ; <URI> ST   (ST = ESC \ or BEL)
const OSC8_LINK = /\x1b\]8;[^;]*;([^\x1b\x07]*)(?:\x1b\\|\x07)/g;

// CSI / OSC / single-char escapes. Enough to make prompt matching reliable.
const ANSI = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** Every OSC-8 hyperlink target present in the buffer, in order, deduplicated. */
export function extractOsc8Links(buffer: string): string[] {
  const links: string[] = [];
  for (const match of buffer.matchAll(OSC8_LINK)) {
    const uri = match[1];
    if (uri && !links.includes(uri)) links.push(uri);
  }
  return links;
}

/**
 * The verification URL the user must open, or null if it has not been printed
 * yet. `accept` narrows the match so an unrelated link the CLI also prints (docs,
 * status page) is never handed to the user as the thing to authenticate with.
 *
 * Falls back to a plain-text https URL for CLIs that do not emit OSC-8 — but
 * only an unwrapped one (no whitespace inside), since a wrapped URL would be
 * silently truncated and send the user to a broken page.
 */
export function findVerificationUrl(
  buffer: string,
  accept: (url: string) => boolean = () => true,
): string | null {
  const link = extractOsc8Links(buffer).find((u) => u.startsWith("https://") && accept(u));
  if (link) return link;

  for (const match of stripAnsi(buffer).matchAll(/https:\/\/[^\s'"<>()\\]+/g)) {
    if (accept(match[0])) return match[0];
  }
  return null;
}
