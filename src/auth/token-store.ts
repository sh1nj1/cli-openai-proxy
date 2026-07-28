/**
 * In-memory credential store for engines whose CLI hands the credential back to
 * us rather than persisting it (see StoredCredential).
 *
 * Deliberately memory-only: a secret this process never writes to disk cannot
 * leak from disk, and re-authenticating after a restart is exactly the flow this
 * API already provides. The cost is that a proxy restart drops provisioned
 * credentials; engines that persist their own (codex) are unaffected.
 */

import type { StoredCredential } from "./types.js";

const credentials = new Map<string, StoredCredential>();

export function setCredential(engine: string, credential: StoredCredential): void {
  credentials.set(engine, credential);
}

export function hasCredential(engine: string): boolean {
  return credentials.has(engine);
}

export function clearCredential(engine: string): boolean {
  return credentials.delete(engine);
}

/** Test-only reset; production code clears per engine. */
export function clearAllCredentials(): void {
  credentials.clear();
}

/**
 * Env vars to merge into a run of `engine`. Provisioned credentials must reach
 * the CLI subprocess somehow, and env is the only channel that works for a CLI
 * which does not persist its own token — so this is applied on BOTH run paths
 * (direct ClaudeSubprocess and PaperclipRunner).
 *
 * Scoped to one engine, never merged across them: a credential is a secret owned
 * by one vendor's CLI, and returning all of them would launch e.g. the codex
 * child with CLAUDE_CODE_OAUTH_TOKEN in its environment. A caller that cannot
 * name its engine gets nothing rather than a guess.
 *
 * Empty when nothing was provisioned, so a host already logged in through the
 * CLI keeps its existing behavior.
 */
export function getProvisionedAuthEnv(engine: string | undefined): Record<string, string> {
  const cred = engine ? credentials.get(engine) : undefined;
  return cred ? { [cred.envVar]: cred.value } : {};
}
