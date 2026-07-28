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
 * Env vars to merge into every agent run. Provisioned credentials must reach the
 * CLI subprocess somehow, and env is the only channel that works for a CLI which
 * does not persist its own token — so this is applied on BOTH run paths (direct
 * ClaudeSubprocess and PaperclipRunner). Empty when nothing was provisioned, so
 * a host already logged in through the CLI keeps its existing behavior.
 */
export function getProvisionedAuthEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const cred of credentials.values()) {
    env[cred.envVar] = cred.value;
  }
  return env;
}
