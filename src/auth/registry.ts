/**
 * Engine → auth-flow registry. Mirrors paperclip-registry's role for runs: one
 * place that maps a caller-visible engine name to the CLI-specific machinery,
 * so routes stay engine-agnostic and a new CLI is one entry.
 */

import { CodexApiKeySession, commandRunner } from "./adapters/codex-api-key.js";
import { CodexDeviceAuthSession } from "./adapters/codex-device-auth.js";
import { ClaudeApiKeySession } from "./adapters/claude-api-key.js";
import { CLAUDE_OAUTH_TOKEN_ENV, ClaudeSetupTokenSession } from "./adapters/claude-setup-token.js";
import { hasInjectableCredential } from "./token-store.js";
import type { EngineAuthDescriptor, EngineAuthStatus } from "./types.js";

const STATUS_TIMEOUT_MS = 15_000;

const firstLine = (text: string): string => text.trim().split("\n")[0]?.trim() ?? "";

/**
 * Claude host credentials live in the OS keychain (macOS) and are unreadable
 * here, so only a provisioned token or an explicit env credential is provable.
 * Everything else is reported as unknown rather than guessed — see EngineAuthStatus.
 */
async function claudeStatus(): Promise<EngineAuthStatus> {
  if (hasInjectableCredential("claude")) {
    return { state: "authenticated", source: "provisioned" };
  }
  if (process.env[CLAUDE_OAUTH_TOKEN_ENV] || process.env.ANTHROPIC_API_KEY) {
    return { state: "authenticated", source: "host", detail: "credential supplied via environment" };
  }
  return {
    state: "unknown",
    detail:
      "No credential provisioned through this API. Claude Code may still be logged in on the host " +
      "(credentials are kept in the OS keychain and cannot be read here).",
  };
}

/**
 * codex exposes a real check, so its status is definitive — but only when the CLI
 * actually answered. A run that timed out or was killed produces no verdict, and
 * reporting that as `unauthenticated` would send the caller through a login flow
 * it may not need (the same reasoning as claudeStatus above).
 */
async function codexStatus(): Promise<EngineAuthStatus> {
  try {
    const result = await commandRunner.run("codex", ["login", "status"], null, STATUS_TIMEOUT_MS);
    // codex reports status on stderr in some versions, stdout in others.
    const detail = firstLine(result.stdout) || firstLine(result.stderr) || undefined;
    if (result.exitCode === 0) return { state: "authenticated", source: "host", detail };
    // A null code means the CLI was signalled rather than exiting on its own, so
    // it never reported anything. runCommand rejects the timeout it causes itself;
    // this covers a kill from outside this process.
    if (result.exitCode === null) {
      return { state: "unknown", detail: detail ?? "`codex login status` was terminated before it reported" };
    }
    return { state: "unauthenticated", detail };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      state: "unknown",
      // A raw "spawn codex ENOENT" reads like a proxy bug; name the actual
      // operator problem (the CLI is missing from the service PATH) instead.
      detail: message.includes("ENOENT") ? "codex CLI not found on the service PATH" : message,
    };
  }
}

const REGISTRY: Record<string, EngineAuthDescriptor> = {
  claude: {
    engine: "claude",
    flows: [
      {
        // paste-code stays first: it was this engine's only flow before api-key
        // existed, and the default is what a caller naming no flow still gets.
        flow: "paste-code",
        // `claude setup-token` prints its token instead of persisting it, so the
        // proxy must hold it and inject it into every run.
        injectsCredential: true,
        createSession: () => new ClaudeSetupTokenSession(),
      },
      {
        flow: "api-key",
        // Same custody as paste-code: the claude CLI has no api-key login
        // command, so the proxy holds the key and injects it as ANTHROPIC_API_KEY.
        injectsCredential: true,
        createSession: () => new ClaudeApiKeySession(),
      },
    ],
    checkStatus: claudeStatus,
  },
  codex: {
    engine: "codex",
    flows: [
      // api-key stays first: it was this engine's only flow before device-code
      // existed, and the default is what a caller naming no flow still gets.
      { flow: "api-key", createSession: () => new CodexApiKeySession() },
      // ChatGPT subscription login. Both flows end in ~/.codex, written by the CLI.
      { flow: "device-code", createSession: () => new CodexDeviceAuthSession() },
    ],
    checkStatus: codexStatus,
  },
};

export const AUTH_ENGINE_IDS: string[] = Object.keys(REGISTRY);

function lookup(engine: string): EngineAuthDescriptor | null {
  return Object.hasOwn(REGISTRY, engine) ? REGISTRY[engine]! : null;
}

/**
 * Mutable holder wrapping the lookup. Callers go through this object so tests can
 * substitute a fake engine: ESM module namespace properties are read-only, so a
 * plain object property is the only injection seam (same pattern as runnerFactory).
 */
export const engineRegistry: {
  resolve: (engine: string) => EngineAuthDescriptor | null;
  ids: () => string[];
} = {
  resolve: lookup,
  ids: () => AUTH_ENGINE_IDS,
};

export function resolveEngine(engine: string): EngineAuthDescriptor | null {
  return engineRegistry.resolve(engine);
}
