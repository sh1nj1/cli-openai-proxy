/**
 * codex_custom — "api-key" flow for an arbitrary OpenAI-compatible gateway
 * (OpenRouter and friends).
 *
 * Unlike the `codex` engine, nothing here runs `codex login`: that command
 * writes `$CODEX_HOME/auth.json`, which only ever authenticates codex's built-in
 * `openai` provider. A custom provider is selected by a `[model_providers.*]`
 * table in config.toml and reads its bearer token from the env var that table's
 * `env_key` names — so the key must stay in proxy memory and be injected per
 * run, the same custody model as the claude flows and gated by the same trust
 * declaration.
 *
 * The submission carries two values because the key alone does not say where to
 * spend it: a `base_url` is required, and both are stored together so forgetting
 * the credential forgets the routing with it.
 */

import {
  AuthProvisioningError,
  type AuthStartResult,
  type AuthSubmitOptions,
  type AuthSubmitResult,
  type EngineAuthSession,
} from "../types.js";

/**
 * Env var the generated `[model_providers.*]` table points `env_key` at. Named
 * for this engine rather than reusing OPENAI_API_KEY so a run that also has a
 * real OpenAI credential in scope cannot silently spend the wrong one.
 */
export const CODEX_CUSTOM_API_KEY_ENV = "CODEX_CUSTOM_API_KEY";

const DEFAULT_TIMEOUT_MS = 30_000;

/** Hosts where plaintext HTTP cannot leave the machine, so http:// is allowed. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Normalize a caller-supplied gateway root into the form codex appends its
 * endpoint path to (`<base>/responses`).
 *
 * Rejects anything that would silently misroute the key rather than repairing
 * it: a query string or fragment does not survive path concatenation, and
 * embedded credentials would put a second secret somewhere we do not manage.
 * Plaintext http is refused off-loopback because the key travels to this URL as
 * a bearer token on every request.
 */
export function normalizeGatewayBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new AuthProvisioningError("`base_url` is empty", "missing_base_url");
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new AuthProvisioningError(
      "`base_url` must be an absolute URL, e.g. https://openrouter.ai/api/v1",
      "invalid_base_url",
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new AuthProvisioningError("`base_url` must use http or https", "invalid_base_url");
  }
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new AuthProvisioningError(
      "`base_url` must use https: the API key is sent to it as a bearer token on every request. " +
        "Plaintext http is accepted only for loopback hosts.",
      "insecure_base_url",
    );
  }
  if (url.username || url.password) {
    throw new AuthProvisioningError(
      "`base_url` must not embed credentials; submit the key as `api_key` instead",
      "invalid_base_url",
    );
  }
  if (url.search || url.hash) {
    throw new AuthProvisioningError(
      "`base_url` must not carry a query string or fragment: the CLI appends `/responses` to it",
      "invalid_base_url",
    );
  }
  // Codex builds "<base>/responses", so a trailing slash would produce "//responses".
  return url.toString().replace(/\/+$/, "");
}

export interface GatewayVerdict {
  /** False only when the gateway definitively rejected the key (401/403). */
  accepted: boolean;
  detail?: string;
}

/** Resolves with a verdict, rejects when the gateway could not be reached at all. */
export type ProbeGatewayFn = (
  baseUrl: string,
  key: string,
  signal: AbortSignal,
) => Promise<GatewayVerdict>;

/**
 * Ask the gateway about the key with one cheap authenticated GET.
 *
 * Deliberately asymmetric: 401/403 is a verdict ("this key is wrong"), and
 * everything else is not. `/models` is public on some gateways (OpenRouter
 * serves it unauthenticated), so a 200 proves the URL is a live OpenAI-compatible
 * root — which is the typo this check is really here to catch — but not that the
 * key is good. Reporting more certainty than that would make the first real
 * completion the place the caller learns otherwise.
 */
export function fetchGatewayProbe(fetchFn: typeof fetch = fetch): ProbeGatewayFn {
  return async (baseUrl, key, signal) => {
    let response: Response;
    try {
      response = await fetchFn(`${baseUrl}/models`, {
        headers: { authorization: `Bearer ${key}` },
        signal,
      });
    } catch (err) {
      // An abort is the session's own doing (cancel or timeout); let it map the
      // reason instead of blaming the gateway here.
      if (signal.aborted) throw err;
      // fetch/Headers errors can quote the rejected header value, so the
      // underlying message could leak the submitted key.
      throw new AuthProvisioningError(
        `Could not reach the gateway at ${baseUrl}`,
        "gateway_unreachable",
      );
    }
    if (response.status === 401 || response.status === 403) {
      return { accepted: false, detail: `The gateway rejected the API key (HTTP ${response.status})` };
    }
    return { accepted: true };
  };
}

export interface CodexCustomApiKeyOptions {
  probe?: ProbeGatewayFn;
  timeoutMs?: number;
}

export class CodexCustomApiKeySession implements EngineAuthSession {
  /** Armed for the whole session so a cancel that lands before submit still wins. */
  private readonly aborter = new AbortController();

  constructor(private readonly options: CodexCustomApiKeyOptions = {}) {}

  async start(): Promise<AuthStartResult> {
    return {
      instructions:
        "Submit an API key together with `base_url`, the OpenAI-compatible API root it " +
        "authenticates against (e.g. https://openrouter.ai/api/v1). The key is held in proxy " +
        `memory only and injected into paperclip/codex_custom runs as ${CODEX_CUSTOM_API_KEY_ENV}. ` +
        "The gateway must serve OpenAI's Responses API: the codex CLI no longer speaks Chat Completions.",
    };
  }

  async submit(apiKey: string, options: AuthSubmitOptions = {}): Promise<AuthSubmitResult> {
    const key = apiKey.trim();
    if (!key) throw new AuthProvisioningError("API key is empty", "empty_api_key");
    if (options.baseUrl === undefined) {
      throw new AuthProvisioningError(
        "`base_url` is required for this engine: a key alone does not say which gateway to spend it at",
        "missing_base_url",
      );
    }
    const baseUrl = normalizeGatewayBaseUrl(options.baseUrl);

    const probe = this.options.probe ?? fetchGatewayProbe();
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Not AbortSignal.timeout: its internal timer does not hold the event loop
    // open, so a probe waiting only on the signal could see the process drain
    // and exit before the deadline ever fires. A plain setTimeout does.
    const timeoutAborter = new AbortController();
    const timer = setTimeout(() => timeoutAborter.abort(), timeoutMs);

    let verdict: GatewayVerdict;
    try {
      verdict = await probe(baseUrl, key, AbortSignal.any([this.aborter.signal, timeoutAborter.signal]));
    } catch (err) {
      // Cancellation first: cancelling also aborts the combined signal, and
      // "cancelled" is the more truthful reason of the two.
      if (this.aborter.signal.aborted) {
        throw new AuthProvisioningError("Login was cancelled", "session_cancelled");
      }
      if (timeoutAborter.signal.aborted) {
        throw new AuthProvisioningError(
          `The gateway did not answer within ${timeoutMs}ms`,
          "gateway_unreachable",
        );
      }
      if (err instanceof AuthProvisioningError) throw err;
      throw new AuthProvisioningError(
        err instanceof Error ? err.message : String(err),
        "gateway_unreachable",
      );
    } finally {
      clearTimeout(timer);
    }

    // A probe that ignores the signal can still answer after cancellation.
    // Refusing it here is what keeps a superseded submit from handing the
    // session manager a credential to store.
    if (this.aborter.signal.aborted) {
      throw new AuthProvisioningError("Login was cancelled", "session_cancelled");
    }

    if (!verdict.accepted) {
      throw new AuthProvisioningError(
        verdict.detail ?? "The gateway rejected the API key",
        "invalid_api_key",
      );
    }
    return { credential: { envVar: CODEX_CUSTOM_API_KEY_ENV, value: key, gateway: { baseUrl } } };
  }

  cancel(): void {
    // Aborts an in-flight probe. Cancelling after it settled is a no-op on the
    // request, but still latches so a late verdict is not accepted.
    this.aborter.abort();
  }
}
