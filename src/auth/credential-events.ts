/**
 * "An engine's credential state may have changed" — broadcast to whoever holds a
 * cached view derived from it.
 *
 * Deliberately not part of token-store. The event must also cover logins the CLI
 * persists for itself (a finished `codex login` writes ~/.codex and hands this
 * process nothing), which that store never sees. What every such path shares is
 * only that a status check would now answer differently — which is exactly what
 * a subscriber caches.
 */

/**
 * Subscribers are process-wide singletons, so there is no unsubscribe: a Set
 * keyed on the function makes repeated module imports register once.
 */
const listeners = new Set<() => void>();

export function onCredentialChange(listener: () => void): void {
  listeners.add(listener);
}

export function notifyCredentialChange(): void {
  for (const listener of listeners) listener();
}
