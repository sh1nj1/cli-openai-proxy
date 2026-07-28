/**
 * Remote CLI auth provisioning — shared contract.
 *
 * The proxy wraps agentic CLIs (claude, codex) that each own their own login
 * flow. To authenticate them from a remote UI (Collavre) we expose one API and
 * let a per-engine adapter declare WHICH flow shape it needs, so the caller can
 * branch its UI without knowing anything CLI-specific:
 *
 *  - "api-key":    caller submits a key; no verification URL. Stateless-ish.
 *  - "paste-code": caller opens a verification URL, gets a code back, submits
 *                  it. Requires holding a live CLI process between the two
 *                  requests (the CLI itself blocks on stdin waiting for it).
 */

export type AuthFlow = "api-key" | "paste-code";

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
}

export interface AuthStartResult {
  /** Present only for "paste-code": the URL the user must open. */
  verificationUrl?: string;
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
  submit(input: string): Promise<AuthSubmitResult>;
  cancel(): void;
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

export interface EngineAuthDescriptor {
  engine: string;
  flow: AuthFlow;
  createSession(): EngineAuthSession;
  checkStatus(): Promise<EngineAuthStatus>;
}

/** Raised for caller mistakes (bad code, empty key) so routes can answer 400 not 500. */
export class AuthProvisioningError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "AuthProvisioningError";
  }
}
