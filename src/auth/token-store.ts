/**
 * In-memory credential store for engines whose CLI hands the credential back to
 * us rather than persisting it (see StoredCredential).
 *
 * Deliberately memory-only: a secret this process never writes to disk cannot
 * leak from disk, and re-authenticating after a restart is exactly the flow this
 * API already provides. The cost is that a proxy restart drops provisioned
 * credentials; engines that persist their own (codex) are unaffected.
 */

import { trustsCompletionCallers } from "../config.js";
import type { StoredCredential } from "./types.js";

const credentials = new Map<string, StoredCredential>();

export function setCredential(engine: string, credential: StoredCredential): void {
  credentials.set(engine, credential);
}

export function hasCredential(engine: string): boolean {
  return credentials.has(engine);
}

/**
 * Whether a stored credential can currently reach its engine.
 *
 * A stored Claude token is not usable merely because it exists: removing the
 * completion-caller trust declaration withholds it from child processes. Keep
 * status checks and environment injection on this same predicate so the API
 * never reports a credential that runs cannot consume.
 */
export function hasInjectableCredential(engine: string): boolean {
  return trustsCompletionCallers() && credentials.has(engine);
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
 * which does not persist its own token.
 *
 * Scoped to one engine, never merged across them: a credential is a secret owned
 * by one vendor's CLI, and returning all of them would launch e.g. the codex
 * child with CLAUDE_CODE_OAUTH_TOKEN in its environment. A caller that cannot
 * name its engine gets nothing rather than a guess.
 *
 * Empty when nothing was provisioned, so a host already logged in through the
 * CLI keeps its existing behavior.
 *
 * Also empty unless the operator declared completion callers trusted: the child
 * this feeds runs with permissions skipped and its exec-time environment is
 * readable via `ps`, so injecting here publishes the credential to whoever wrote
 * the prompt (see trustsCompletionCallers). Enforced at the point of injection,
 * not only at the point of provisioning, so the guarantee does not depend on
 * every future path into the store remembering to ask.
 */
export function getProvisionedAuthEnv(engine: string | undefined): Record<string, string> {
  if (!engine || !hasInjectableCredential(engine)) return {};
  const cred = credentials.get(engine);
  return cred ? { [cred.envVar]: cred.value } : {};
}
