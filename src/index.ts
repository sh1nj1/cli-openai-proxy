/**
 * Claude Code CLI Provider Plugin for Clawdbot
 *
 * Serves the local coding CLIs registered as Paperclip adapters (Claude Code,
 * codex) over an OpenAI-compatible API, so a caller spends the subscription each
 * CLI is already logged into instead of an API key with OAuth scope restrictions.
 */

import {
  initializeGatewaySecurity,
  startServer,
  stopServer,
  getServer,
} from "./server/index.js";
import { verifyClaude, verifyAuth } from "./cli/claude.js";
import { commandRuns } from "./cli/command.js";
import { runPreflight } from "./server/preflight.js";
import {
  DEFAULT_MODEL,
  defaultModelForHost,
  adapterCredentialNotes,
  adapterLabel,
  resolvePaperclipModel,
  suggestedSetupModelIds,
} from "./adapter/paperclip-registry.js";

// Provider constants
export const PROVIDER_ID = "claude-code-cli";
const PROVIDER_LABEL = "Claude Code CLI";
const DEFAULT_PORT = 3456;

/** "paperclip/claude_local/opus" -> "Claude Local opus (Paperclip)" */
function modelName(id: string): string {
  const cliModel = resolvePaperclipModel(id)?.cliModel;
  return `${adapterLabel(id)}${cliModel ? ` ${cliModel}` : ""} (Paperclip)`;
}

/**
 * Build model definitions for Clawdbot config
 */
function buildModelDefinition(id: string) {
  return {
    id,
    name: modelName(id),
    api: "openai-completions",
    // The CLI model is the id's own suffix, so no fixed capability can be claimed here.
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
  };
}

/** Split a comma-separated model list; blank entries are dropped, not rejected. */
export function parseSetupModelIds(raw: string): string[] {
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

/**
 * Reject at setup what the proxy would 404 at request time — the config this
 * setup writes is the one the first completion runs against.
 */
export function validateSetupModelIds(raw: string): string | undefined {
  const ids = parseSetupModelIds(raw);
  if (ids.length === 0) return "Enter at least one model id";
  const unknown = ids.filter((id) => resolvePaperclipModel(id) === null);
  if (unknown.length > 0) {
    return `Not a registered adapter: ${unknown.join(", ")}. Expected paperclip/<adapter>[/<cli-model>].`;
  }
  return undefined;
}

export interface LocalAuthSetupDeps {
  verifyClaude: typeof verifyClaude;
  verifyAuth: typeof verifyAuth;
  /** Presence probe for a non-Claude adapter's CLI before it is suggested. */
  commandRuns: typeof commandRuns;
  startServer: (opts: { port: number }) => Promise<unknown>;
}

const DEFAULT_SETUP_DEPS: LocalAuthSetupDeps = {
  verifyClaude,
  verifyAuth,
  commandRuns,
  startServer,
};

/**
 * Interactive setup for the `local` auth method.
 *
 * Claude is checked but not required: this provider also advertises non-Claude
 * adapters (paperclip/codex_local), so failing here would lock a codex-only
 * host out of models it is being offered. Missing Claude becomes a note, which
 * is the same policy the standalone server applies at startup — hence the
 * shared `runPreflight`. A Claude-targeted request on such a host still fails
 * cleanly at request time.
 */
export async function runLocalAuthSetup(
  ctx: any,
  deps: LocalAuthSetupDeps = DEFAULT_SETUP_DEPS
): Promise<{ port: number; auth: any }> {
  // The probes below launch CLI children. Capture gateway-only credentials
  // first so plugin-host startup has the same secret boundary as standalone.
  initializeGatewaySecurity();
  const spin = ctx.prompter.progress("Checking Claude CLI...");

  try {
    const { claudeOk, warnings } = await runPreflight({
      verifyClaude: deps.verifyClaude,
      verifyAuth: deps.verifyAuth,
      log: (msg) => spin.message(msg.trim()),
    });

    // The provider is configured with this before its first request runs, so it
    // follows the host: a Claude default on a host that just failed the Claude
    // preflight would fail that first request until the user switched by hand.
    const defaultAdapterId = await defaultModelForHost(claudeOk, deps.commandRuns);
    const defaultModel = `${PROVIDER_ID}/${defaultAdapterId}`;

    if (!claudeOk) {
      const claudeDefault = `${PROVIDER_ID}/${DEFAULT_MODEL}`;
      await ctx.prompter.note(
        [
          ...warnings,
          // Only claims a switch that was actually made — and says how to undo it,
          // since this default is persisted while the probe behind it is not.
          defaultModel === claudeDefault
            ? `No other CLI answered either, so the default stays ${defaultModel}.`
            : `Default model set to ${defaultModel} instead; switch back to ${claudeDefault} once Claude works.`,
          "Install: npm install -g @anthropic-ai/claude-code",
          "Authenticate: claude auth login",
        ].join("\n"),
        "Claude unavailable"
      );
    }

    const portInput = await ctx.prompter.text({
      message: "Local server port",
      initialValue: String(DEFAULT_PORT),
      validate: (v: string) => {
        const p = parseInt(v, 10);
        if (isNaN(p) || p < 1 || p > 65535) {
          return "Enter a valid port (1-65535)";
        }
        return undefined;
      },
    });
    const port = parseInt(portInput, 10);

    // Clawdbot selects models from what its config enumerates — `agents.defaults.models`
    // is an allowlist and takes exact keys only — so a `<cli-model>` suffix that is
    // never written here cannot be picked, however cleanly the proxy resolves it.
    const modelsInput = await ctx.prompter.text({
      message: "Models to register (comma-separated)",
      initialValue: suggestedSetupModelIds().join(", "),
      validate: validateSetupModelIds,
    });
    const chosen = parseSetupModelIds(modelsInput);
    // The default is written to the host config whatever this list says, and the
    // allowlist would then reject the provider's own default.
    const modelIds = chosen.includes(defaultAdapterId) ? chosen : [defaultAdapterId, ...chosen];

    spin.message("Starting server...");
    await deps.startServer({ port });
    spin.stop("Claude CLI provider ready");

    const baseUrl = `http://127.0.0.1:${port}/v1`;

    return {
      port,
      auth: {
        profiles: [
          {
            profileId: `${PROVIDER_ID}:local`,
            credential: {
              type: "token",
              provider: PROVIDER_ID,
              token: "local", // Dummy token - CLI handles auth
            },
          },
        ],
        configPatch: {
          models: {
            providers: {
              [PROVIDER_ID]: {
                baseUrl,
                apiKey: "local",
                api: "openai-completions",
                authHeader: false,
                models: modelIds.map(buildModelDefinition),
              },
            },
          },
          agents: {
            defaults: {
              models: Object.fromEntries(
                modelIds.map((id) => [`${PROVIDER_ID}/${id}`, {}])
              ),
            },
          },
        },
        defaultModel,
        // Per adapter, not per provider: every advertised model stays selectable
        // whatever the default is, and they do not spend the same credential.
        notes: [
          ...adapterCredentialNotes(),
          `Default: ${defaultModel}. Any registered model can be selected per request.`,
          `Registered: ${modelIds.join(", ")}.`,
          // The proxy takes any suffix; this host only takes what it was told about.
          `Other CLI models work the same way — add paperclip/<adapter>/<cli-model> to models.providers.${PROVIDER_ID} and agents.defaults.models to select one here.`,
          "Each CLI keeps its own credentials; none are exposed to this provider.",
          `Local server running at http://127.0.0.1:${port}`,
          "Keep the server running to use this provider.",
        ],
      },
    };
  } catch (err) {
    spin.stop("Setup failed");
    throw err;
  }
}

/**
 * Empty plugin config schema (no user configuration needed)
 */
function emptyPluginConfigSchema() {
  return {
    type: "object" as const,
    properties: {},
    additionalProperties: false,
  };
}

/**
 * Plugin definition
 */
const claudeCodeCliPlugin = {
  id: "claude-code-cli-provider",
  name: "Claude Code CLI Provider",
  // Names no single CLI: which ones are served is the adapter registry's call,
  // and this string is read before any host has been probed.
  description:
    "Use the CLI logins already on this machine, no API key (bypasses OAuth restrictions)",
  configSchema: emptyPluginConfigSchema(),

  register(api: any) {
    let serverPort = DEFAULT_PORT;

    // Register the provider
    api.registerProvider({
      id: PROVIDER_ID,
      label: PROVIDER_LABEL,
      docsPath: "/providers/claude-code-cli",
      aliases: ["claude-cli", "claude-max"],
      envVars: [], // No env vars needed - uses Claude CLI auth

      auth: [
        {
          id: "local",
          label: "Local Claude CLI",
          hint: "Uses the CLI logins already on this machine; setup lists what each model spends",
          kind: "custom",

          run: async (ctx: any) => {
            const { port, auth } = await runLocalAuthSetup(ctx);
            serverPort = port;
            return auth;
          },
        },
      ],
    });

    // Handle plugin unload
    api.on("plugin:unload", async () => {
      const server = getServer();
      if (server) {
        console.log("[ClaudeCodeCLI] Stopping server on plugin unload");
        await stopServer();
      }
    });

    // Register CLI command for manual server control
    api.registerCli?.((cli: any) => {
      cli
        .command("claude-cli:start [port]")
        .description("Start the Claude CLI proxy server")
        .action(async (port: string) => {
          const p = parseInt(port || String(DEFAULT_PORT), 10);
          await startServer({ port: p });
          console.log(`Server started on port ${p}`);
        });

      cli
        .command("claude-cli:stop")
        .description("Stop the Claude CLI proxy server")
        .action(async () => {
          await stopServer();
          console.log("Server stopped");
        });

      cli
        .command("claude-cli:status")
        .description("Check Claude CLI proxy server status")
        .action(() => {
          const server = getServer();
          if (server) {
            console.log(`Server is running on port ${serverPort}`);
          } else {
            console.log("Server is not running");
          }
        });
    });

    console.log("[ClaudeCodeCLI] Plugin registered");
  },
};

export default claudeCodeCliPlugin;

// Also export server utilities for standalone use
export { startServer, stopServer, getServer } from "./server/index.js";
export { verifyClaude, verifyAuth } from "./cli/claude.js";
export { usageTracker } from "./usage/tracker.js";
export type { UsageSummary, RequestRecord } from "./usage/tracker.js";
