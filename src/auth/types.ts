/**
 * Remote CLI auth provisioning — shared contract.
 *
 * The proxy wraps agentic CLIs (claude, codex) that each own their own login
 * flow. To authenticate them from a remote UI (Collavre) we expose one API and
 * let a per-engine adapter declare WHICH flow shape it needs, so the caller can
 * branch its UI without knowing anything CLI-specific:
 *
 *  - "api-key":     caller submits a key; no verification URL. Stateless-ish.
 *  - "paste-code":  caller opens a verification URL, gets a code back, submits
 *                   it. Requires holding a live CLI process between the two
 *                   requests (the CLI itself blocks on stdin waiting for it).
 *  - "device-code": caller opens a verification URL and types the code the CLI
 *                   printed INTO it — the reverse of paste-code. Nothing is
 *                   submitted back; the CLI polls the vendor and finishes on its
 *                   own, so the caller polls the session for the outcome.
 */

export type AuthFlow = "api-key" | "paste-code" | "device-code";

/**
 * Where a provisioned key is spent, for an engine whose endpoint is not fixed by
 * its vendor. `codex_custom` routes through any OpenAI-compatible gateway, so the
 * key alone does not say who to send it to — the caller supplies both.
 */
export interface CredentialGateway {
  /** OpenAI-compatible API root, without a trailing slash (e.g. https://openrouter.ai/api/v1). */
  baseUrl: string;
}

/**
 * A credential the CLI hands BACK to us instead of persisting itself.
 * `claude setup-token` prints its token and expects the caller to export it —
 * it never writes ~/.claude — so we must hold it and inject it into every run.
 * `codex login --with-api-key` persists to ~/.codex itself and returns nothing.
 */
export interface StoredCredential {
  /** Env var the engine reads this credential from (e.g. CLAUDE_CODE_OAUTH_TOKEN). */
  envVar: string;
  value: string;
  /**
   * Routing provisioned together with the key, for engines that have no fixed
   * endpoint. Kept on the credential rather than in a second store so forgetting
   * one forgets both: a key left behind with no gateway (or the reverse) would be
   * a half-provisioned engine that reports authenticated and cannot run.
   */
  gateway?: CredentialGateway;
}

/**
 * Settings a caller submits alongside the secret. Empty for every vendor-hosted
 * flow; `codex_custom` needs `baseUrl` because the endpoint is the caller's choice.
 */
export interface AuthSubmitOptions {
  baseUrl?: string;
}

export interface AuthStartResult {
  /** Present for "paste-code" and "device-code": the URL the user must open. */
  verificationUrl?: string;
  /** Present only for "device-code": the one-time code the user types at the URL. */
  userCode?: string;
  /** Human-readable next step, safe to render verbatim in the caller's UI. */
  instructions: string;
}

export interface AuthSubmitResult {
  /** Set when the CLI returned a credential for us to hold (see StoredCredential). */
  credential?: StoredCredential;
}

/**
 * One in-flight authentication attempt. For "paste-code" this object owns a live
 * CLI subprocess between start() and submit(), so it MUST be cancel()ed if
 * abandoned — the session manager's reaper guarantees that.
 */
export interface EngineAuthSession {
  start(): Promise<AuthStartResult>;
  /**
   * `options` carries non-secret settings that arrived with the submission. A
   * flow whose endpoint its vendor fixes ignores it entirely.
   */
  submit(input: string, options?: AuthSubmitOptions): Promise<AuthSubmitResult>;
  cancel(): void;
  /**
   * Present only for flows that complete without a submission ("device-code"):
   * the CLI decides the outcome on its own once the user acts at the
   * verification URL. Resolves when it reports success, rejects when it fails —
   * and, because there is no submit request to carry the outcome, the session
   * manager consumes this to move the session to its terminal status.
   */
  wait?(): Promise<AuthSubmitResult>;
}

/**
 * Tri-state on purpose. Claude Code keeps host credentials in the OS keychain,
 * which this process cannot read, so "not provisioned through this API" is NOT
 * evidence of being logged out. Reporting that as `unauthenticated` would tell a
 * caller to re-run a login flow it does not need; `unknown` says "ask by making
 * a request" instead.
 */
export interface EngineAuthStatus {
  state: "authenticated" | "unauthenticated" | "unknown";
  /** Where the credential came from: provisioned via this API, or already on the host. */
  source?: "provisioned" | "host";
  detail?: string;
}

/** One way to log an engine in. An engine may offer several (codex: api-key or device-code). */
export interface EngineFlowDescriptor {
  flow: AuthFlow;
  /**
   * True when this flow hands its credential back for the proxy to inject into
   * completion children (see StoredCredential) — which publishes it to whoever
   * writes a prompt, so provisioning it requires the operator's explicit trust
   * declaration. False for a flow whose CLI persists its own credential: that
   * one never enters a child environment we build.
   */
  injectsCredential?: boolean;
  /**
   * True when the submission must carry `baseUrl` as well as the secret. Advertised
   * so a client renders the extra field from the engine list rather than from a
   * hardcoded engine name — the same reason `flow` is advertised at all.
   */
  requiresBaseUrl?: boolean;
  createSession(): EngineAuthSession;
}

export interface EngineAuthDescriptor {
  engine: string;
  /** Supported login flows. The first is the default when the caller names none. */
  flows: EngineFlowDescriptor[];
  checkStatus(): Promise<EngineAuthStatus>;
}

/** Raised for caller mistakes (bad code, empty key) so routes can answer 400 not 500. */
export class AuthProvisioningError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "AuthProvisioningError";
  }
}
