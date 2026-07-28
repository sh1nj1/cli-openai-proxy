/**
 * Engine → auth-flow registry. Mirrors paperclip-registry's role for runs: one
 * place that maps a caller-visible engine name to the CLI-specific machinery,
 * so routes stay engine-agnostic and a new CLI is one entry.
 */

import { CodexApiKeySession, commandRunner } from "./adapters/codex-api-key.js";
import { CLAUDE_OAUTH_TOKEN_ENV, ClaudeSetupTokenSession } from "./adapters/claude-setup-token.js";
import { hasCredential } from "./token-store.js";
import type { EngineAuthDescriptor, EngineAuthStatus } from "./types.js";

const STATUS_TIMEOUT_MS = 15_000;

const firstLine = (text: string): string => text.trim().split("\n")[0]?.trim() ?? "";

/**
 * Claude host credentials live in the OS keychain (macOS) and are unreadable
 * here, so only a provisioned token or an explicit env credential is provable.
 * Everything else is reported as unknown rather than guessed — see EngineAuthStatus.
 */
async function claudeStatus(): Promise<EngineAuthStatus> {
  if (hasCredential("claude")) {
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

/** codex exposes a real check, so its status is definitive. */
async function codexStatus(): Promise<EngineAuthStatus> {
  try {
    const result = await commandRunner.run("codex", ["login", "status"], null, STATUS_TIMEOUT_MS);
    // codex reports status on stderr in some versions, stdout in others.
    const detail = firstLine(result.stdout) || firstLine(result.stderr) || undefined;
    return result.exitCode === 0
      ? { state: "authenticated", source: "host", detail }
      : { state: "unauthenticated", detail };
  } catch (err) {
    return { state: "unknown", detail: err instanceof Error ? err.message : String(err) };
  }
}

const REGISTRY: Record<string, EngineAuthDescriptor> = {
  claude: {
    engine: "claude",
    flow: "paste-code",
    // `claude setup-token` prints its token instead of persisting it, so the
    // proxy must hold it and inject it into every run.
    injectsCredential: true,
    createSession: () => new ClaudeSetupTokenSession(),
    checkStatus: claudeStatus,
  },
  codex: {
    engine: "codex",
    flow: "api-key",
    createSession: () => new CodexApiKeySession(),
    checkStatus: codexStatus,
  },
};

export const AUTH_ENGINE_IDS: string[] = Object.keys(REGISTRY);

function lookup(engine: string): EngineAuthDescriptor | null {
  return REGISTRY[engine] ?? null;
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
