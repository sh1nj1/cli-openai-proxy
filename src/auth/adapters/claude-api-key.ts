/**
 * claude — "api-key" flow.
 *
 * Unlike codex, the claude CLI has no `login --with-api-key`: it reads
 * ANTHROPIC_API_KEY from its environment instead. So the key is returned as a
 * StoredCredential for the proxy to hold and inject into runs — the same
 * custody model as setup-token, gated by the same trust declaration.
 *
 * The key is validated against the Anthropic API before it is accepted:
 * nothing downstream ever re-checks it, so the "authorized" this flow reports
 * is the only verdict the caller gets. Only a definitive HTTP answer counts as
 * a verdict — an unreachable API is reported as such, never as a bad key.
 */

import {
  AuthProvisioningError,
  type AuthStartResult,
  type AuthSubmitResult,
  type EngineAuthSession,
} from "../types.js";

export const CLAUDE_API_KEY_ENV = "ANTHROPIC_API_KEY";

const DEFAULT_TIMEOUT_MS = 30_000;
// The cheapest authenticated endpoint: answers 401/403 for a bad key without
// spending tokens. The key travels in a header, never in the URL, so it cannot
// end up in an access log.
const VALIDATION_URL = "https://api.anthropic.com/v1/models?limit=1";
const ANTHROPIC_VERSION = "2023-06-01";

export interface KeyVerdict {
  valid: boolean;
  /** Present when invalid: why, phrased without ever quoting the key. */
  detail?: string;
}

/** Resolves with a verdict, rejects when no verdict could be reached. */
export type ValidateKeyFn = (key: string, signal: AbortSignal) => Promise<KeyVerdict>;

/**
 * Validate a key with one authenticated request. Only 401/403 (rejected) and
 * 2xx/429 (accepted — 429 means authentication already succeeded) are verdicts;
 * everything else rejects, because a network hiccup says nothing about the key.
 */
export function fetchValidator(fetchFn: typeof fetch = fetch): ValidateKeyFn {
  return async (key, signal) => {
    let response: Response;
    try {
      response = await fetchFn(VALIDATION_URL, {
        headers: { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION },
        signal,
      });
    } catch (err) {
      // An abort is the session's own doing (cancel or timeout); let it map the
      // reason instead of blaming the network here.
      if (signal.aborted) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new AuthProvisioningError(
        `Could not reach the Anthropic API to validate the key: ${message}`,
        "validation_unavailable",
      );
    }
    if (response.status === 401 || response.status === 403) {
      return { valid: false, detail: `Anthropic rejected the API key (HTTP ${response.status})` };
    }
    if (response.ok || response.status === 429) return { valid: true };
    throw new AuthProvisioningError(
      `The Anthropic API answered HTTP ${response.status} while validating the key`,
      "validation_unavailable",
    );
  };
}

export interface ClaudeApiKeyOptions {
  validate?: ValidateKeyFn;
  timeoutMs?: number;
}

export class ClaudeApiKeySession implements EngineAuthSession {
  /** Armed for the whole session so a cancel that lands before submit still wins. */
  private readonly aborter = new AbortController();

  constructor(private readonly options: ClaudeApiKeyOptions = {}) {}

  async start(): Promise<AuthStartResult> {
    return {
      instructions:
        "Submit an Anthropic API key. It is validated against the Anthropic API, then held " +
        `in proxy memory and injected into claude runs as ${CLAUDE_API_KEY_ENV}.`,
    };
  }

  async submit(apiKey: string): Promise<AuthSubmitResult> {
    const key = apiKey.trim();
    if (!key) throw new AuthProvisioningError("API key is empty", "empty_api_key");

    const validate = this.options.validate ?? fetchValidator();
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Not AbortSignal.timeout: its internal timer does not hold the event loop
    // open, so a validator waiting only on the signal could see the process
    // drain and exit before the deadline ever fires. A plain setTimeout does.
    const timeoutAborter = new AbortController();
    const timer = setTimeout(() => timeoutAborter.abort(), timeoutMs);

    let verdict: KeyVerdict;
    try {
      verdict = await validate(key, AbortSignal.any([this.aborter.signal, timeoutAborter.signal]));
    } catch (err) {
      // Cancellation first: cancelling also aborts the combined signal, and
      // "cancelled" is the more truthful reason of the two.
      if (this.aborter.signal.aborted) {
        throw new AuthProvisioningError("Login was cancelled", "session_cancelled");
      }
      if (timeoutAborter.signal.aborted) {
        throw new AuthProvisioningError(
          `Key validation did not finish within ${timeoutMs}ms`,
          "validation_timeout",
        );
      }
      if (err instanceof AuthProvisioningError) throw err;
      throw new AuthProvisioningError(
        err instanceof Error ? err.message : String(err),
        "validation_unavailable",
      );
    } finally {
      clearTimeout(timer);
    }

    // A validator that ignores the signal can still return a verdict after
    // cancellation. Refusing it here is what keeps a superseded submit from
    // handing the session manager a credential to store.
    if (this.aborter.signal.aborted) {
      throw new AuthProvisioningError("Login was cancelled", "session_cancelled");
    }

    if (!verdict.valid) {
      throw new AuthProvisioningError(
        verdict.detail ?? "Anthropic rejected the API key",
        "invalid_api_key",
      );
    }
    return { credential: { envVar: CLAUDE_API_KEY_ENV, value: key } };
  }

  cancel(): void {
    // Aborts an in-flight validation. Cancelling after it settled is a no-op on
    // the request, but still latches so a late verdict is not accepted.
    this.aborter.abort();
  }
}
