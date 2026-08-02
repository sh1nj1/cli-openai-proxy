import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

// 0 = no timeout: let `claude -p` run until it exits on its own. Combined with
// the unbounded background-wait ceiling below, the CLI stays alive until its
// subagents finish, then exits normally — so no external clock should cut it
// short. Set TIMEOUT to a positive ms value to re-impose an upper bound.
export const DEFAULT_TIMEOUT_MS = 0;

// Since v2.1.182, `claude -p` caps how long it waits for background subagents
// to finish at 10 minutes by default, then exits — cutting off longer runs.
// 0 = wait until subagents finish (no ceiling).
export const DEFAULT_BG_WAIT_CEILING_MS = 0;

const KEEPALIVE_INTERVAL_MS = 15000;
export { KEEPALIVE_INTERVAL_MS };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PKG_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(path.resolve(__dirname, "../package.json"), "utf-8")).version || "unknown";
  } catch { return "unknown"; }
})();

export function getTimeoutMs(): number {
  const raw = process.env.TIMEOUT;
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

/**
 * Env vars that authenticate callers TO the proxy or carry proxy-only registry
 * credentials. They mean nothing to the CLIs it spawns.
 *
 * Completion runs launch an agentic CLI with permissions skipped, so an ordinary
 * caller can just ask the model to print its environment. Inherited, AUTH_ADMIN_KEYS
 * would hand that caller the higher-privilege key gating the credential-mutating
 * /v1/auth routes — defeating its separation from API_KEYS — and API_KEYS would
 * hand it every other caller's completion key.
 */
export const PROXY_ONLY_SECRET_VARS = [
  "API_KEYS",
  "AUTH_ADMIN_KEYS",
  "USER_API_KEYS",
  "USER_IDENTITY_HMAC_SECRET",
  "PROVISION_MANIFEST_URL",
] as const;

/** What each secret was at boot, so a re-init survives its own removal from the env. */
const captured = new Map<string, string>();

/**
 * Read a proxy-only secret and remove it from the process environment.
 *
 * Filtering at each spawn site is not sufficient on its own: the Paperclip
 * adapters build their child env as `{...process.env, ...config.env}` inside a
 * dependency this repo does not control, and any future run path would have to
 * remember to filter. Both values are captured into module state at boot, so the
 * variable is dead weight afterwards — deleting it is what makes the guarantee
 * hold for every spawn, present and future.
 *
 * Repeat calls answer from the capture, so initialization is idempotent. A value
 * present in the environment still wins: an operator who re-sets the variable
 * between two inits means to change the keys, and honouring that costs nothing.
 */
export function takeProxySecret(name: (typeof PROXY_ONLY_SECRET_VARS)[number]): string | undefined {
  const fromEnv = process.env[name];
  if (fromEnv !== undefined) {
    delete process.env[name];
    captured.set(name, fromEnv);
    return fromEnv;
  }
  // Deleting makes the variable unreadable to the *next* take as well, so an
  // in-process restart (startServer → stopServer → startServer) would otherwise
  // re-init from an environment this function itself emptied — silently
  // disabling completion auth. The capture is the value from here on.
  return captured.get(name);
}

/** Forget captured secrets. Tests only — nothing in a running proxy un-configures a key. */
export function resetCapturedProxySecrets(): void {
  captured.clear();
}

/**
 * Overrides that blank the proxy-only secrets, for a spawn site that does NOT
 * build the child env itself. The Paperclip adapters merge `{...process.env,
 * ...config.env}` internally, so the only way to reach that env from here is to
 * shadow the inherited value. Blank rather than absent: `config.env` is typed
 * Record<string, string>, and an empty value carries no secret either way.
 */
export function blankedProxySecrets(): Record<string, string> {
  return Object.fromEntries(PROXY_ONLY_SECRET_VARS.map((name) => [name, ""]));
}

/** Operator's declaration that completion callers may read provisioned credentials. */
export const TRUST_COMPLETION_CALLERS_VAR = "AUTH_TRUST_COMPLETION_CALLERS";

/**
 * Whether the operator has declared completion callers to be inside the same
 * trust boundary as the admin who provisions credentials.
 *
 * A credential we hold can only reach its CLI through the child's environment,
 * and that environment is readable by whoever wrote the prompt: the CLI runs with
 * `--dangerously-skip-permissions`, and even though it scrubs its own token from
 * the environment it gives its tools, `ps` reports the environment a process was
 * *exec'd* with, which no runtime deletion undoes. So an ordinary completion
 * caller can recover a provisioned token, and no amount of filtering here changes
 * that. The exposure is real and unavoidable — it is therefore a decision for the
 * operator to make explicitly rather than one to inherit by upgrading.
 *
 * Unset means "not declared", not "false": defaulting to open would hand every
 * caller a reusable OAuth credential on the strength of an env var nobody set.
 */
export function trustsCompletionCallers(): boolean {
  const raw = process.env[TRUST_COMPLETION_CALLERS_VAR];
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

// Ceiling passed to the CLI as CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS.
// A user-set env value wins; otherwise default to no ceiling (0). Note 0 is a
// valid value (unlimited), so the guard is >= 0, not > 0.
export function getBgWaitCeilingMs(): number {
  const raw = process.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS;
  if (raw === undefined || raw === "") return DEFAULT_BG_WAIT_CEILING_MS;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_BG_WAIT_CEILING_MS;
}

export function userWorkerModeEnabled(): boolean {
  const raw = process.env.USER_WORKER_MODE;
  if (raw === undefined) return false;
  return ["1", "true", "yes", "enabled"].includes(raw.trim().toLowerCase());
}

export function getProvisionerEndpoint(platform = process.platform): string {
  const configured = process.env.USER_WORKER_PROVISIONER_ENDPOINT?.trim();
  if (configured) return configured;
  return platform === "win32"
    ? "\\\\.\\pipe\\cli-openai-proxy-provisioner"
    : "/run/cli-openai-proxy/provisioner.sock";
}

export function getWorkerConnectTimeoutMs(): number {
  const raw = process.env.USER_WORKER_CONNECT_TIMEOUT_MS;
  if (!raw) return 15_000;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 15_000;
}
