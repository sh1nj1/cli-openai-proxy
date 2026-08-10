/**
 * Registry mapping OpenAI model ids to Paperclip adapter specs. The route layer
 * only knows the common AgentRunner contract; CLI spawn/parsing/termination stay
 * owned by the published adapter packages.
 */
import { execute as claudeLocalExecute } from "@paperclipai/adapter-claude-local/server";
import { execute as codexLocalExecute } from "@paperclipai/adapter-codex-local/server";
import {
  PaperclipRunner,
  type AdapterExecute,
  type PromptInjection,
  type OutputMode,
} from "./paperclip-runner.js";
import type { AgentRunner } from "./agent-runner.js";
import { commandRuns } from "../cli/command.js";

export interface PaperclipModelSpec {
  adapterType: string;
  execute: AdapterExecute;
  baseConfig: Record<string, unknown>;
  /** How this adapter receives the raw prompt (default "task-context"). */
  promptInjection: PromptInjection;
  /** How this adapter reports output (default "stream-json"). */
  outputMode: OutputMode;
  /** Adapter base CLI flags. claude-code flags for claude; [] for adapters that reject them. */
  cliFlags: string[];
  /** Engine id in the /v1/auth registry, so an auth failure names the login flow to run. */
  authEngine: string;
  /**
   * Which CLI a run through this adapter spawns and whose credential it spends,
   * phrased to follow the adapter id (`<id> runs <credentialNote>.`). Setup prints
   * one line per advertised adapter, so a host is never told the wrong subscription
   * pays for the model it was handed.
   */
  credentialNote: string;
  /**
   * `<cli-model>` suffixes to offer at setup, for a host that selects models
   * from an enumerated list instead of passing the id through (Clawdbot's
   * `agents.defaults.models` is an allowlist, and it has no prefix form).
   *
   * A suggestion, not a catalog: the setup prompt is editable, request routing
   * still hands the CLI whatever suffix it is given, and a stale entry costs an
   * edit at setup rather than a failed request. Family aliases only — they
   * follow the CLI to each new model, which is why codex, whose `--model` takes
   * full ids that turn over, suggests none.
   */
  suggestedCliModels: string[];
  /**
   * True when running this adapter needs more than the CLI being installed — a
   * gateway provisioned through /v1/auth. Such an adapter is never the fallback
   * suggested to a host that has only proved its CLI runs, because a fresh host
   * has provisioned nothing.
   */
  requiresProvisionedGateway?: boolean;
}

const CLAUDE_LOCAL_SPEC: PaperclipModelSpec = {
  adapterType: "claude_local",
  execute: claudeLocalExecute as AdapterExecute,
  baseConfig: { engine: "cli", command: "claude" },
  promptInjection: "task-context",
  outputMode: "stream-json",
  cliFlags: ["--include-partial-messages", "--no-session-persistence"],
  authEngine: "claude",
  credentialNote: "the Claude Code CLI on your Claude Max subscription",
  suggestedCliModels: ["fable", "opus", "sonnet", "haiku"],
};

/**
 * Shared by both codex adapters: same CLI, same stdout dialect, same flags. Only
 * the credential each one spends differs, so keeping one base makes that the only
 * visible difference instead of a diff to read twice.
 */
const CODEX_BASE = {
  execute: codexLocalExecute as AdapterExecute,
  // codex reads its own approval-bypass key; claude's dangerouslySkipPermissions
  // is ignored by buildCodexExecArgs. Without this codex blocks on approvals headless.
  baseConfig: { engine: "cli", command: "codex", dangerouslyBypassApprovalsAndSandbox: true },
  // codex ignores paperclipTaskMarkdown (prompt comes from rendered promptTemplate),
  // rejects claude-only flags, and streams its own `codex exec --json` NDJSON, which
  // PaperclipRunner parses live (a content delta per completed agent_message block).
  promptInjection: "prompt-template" as PromptInjection,
  outputMode: "codex-jsonl" as OutputMode,
  // PaperclipRunner runs every adapter in a fresh /tmp/paperclip-run-* dir, which
  // is deliberately not a git repo. buildCodexExecArgs only adds --skip-git-repo-check
  // for its own sandbox lane, not for local `codex exec`, so declare it here (codex
  // appends extraArgs verbatim) to keep local runs from tripping the git-repo guard.
  cliFlags: ["--skip-git-repo-check"],
  // `codex --model` takes full ids only, and they turn over faster than this
  // package ships; the adapter's own default is the entry that stays correct.
  suggestedCliModels: [],
};

const REGISTRY: Record<string, PaperclipModelSpec> = {
  "paperclip/claude_local": CLAUDE_LOCAL_SPEC,
  "paperclip/codex_local": {
    ...CODEX_BASE,
    adapterType: "codex_local",
    authEngine: "codex",
    credentialNote: "the codex CLI on whatever `codex login` signed in with (ChatGPT plan or OpenAI API key)",
  },
  "paperclip/codex_custom": {
    ...CODEX_BASE,
    adapterType: "codex_custom",
    authEngine: "codex_custom",
    credentialNote:
      "the codex CLI against the OpenAI-compatible gateway provisioned for the codex_custom engine " +
      "(POST /v1/auth/codex_custom/sessions), on that gateway's own API key",
    // The gateway's catalog is the gateway's business, and the CLI's own default
    // model almost certainly is not in it — so a request should name one:
    // paperclip/codex_custom/<provider>/<model>.
    requiresProvisionedGateway: true,
  },
};

export const PAPERCLIP_MODEL_IDS: string[] = Object.keys(REGISTRY);

/** Prefix reserved for explicitly named Paperclip adapters. */
export const PAPERCLIP_MODEL_PREFIX = "paperclip/";

/** Adapter used when a request names no model at all. */
export const DEFAULT_MODEL = "paperclip/claude_local";

/**
 * One line per advertised adapter, naming the CLI and credential its runs spend.
 *
 * Derived from the registry for the same reason the advertised model list is: a
 * hand-kept copy in the plugin would keep describing whichever adapter it was
 * written for, which is how a codex-only host came to be told its requests ran
 * on a Claude Max subscription.
 */
export function adapterCredentialNotes(): string[] {
  return PAPERCLIP_MODEL_IDS.map((id) => `${id} runs ${REGISTRY[id].credentialNote}.`);
}

/**
 * Model ids to offer a host that has to enumerate what it can select.
 *
 * Every adapter, plus the CLI models it suggests — so the `paperclip/<adapter>/
 * <cli-model>` form the docs teach is selectable without the user first learning
 * that the host needs the id spelled out.
 */
export function suggestedSetupModelIds(): string[] {
  return PAPERCLIP_MODEL_IDS.flatMap((id) => [
    id,
    ...REGISTRY[id].suggestedCliModels.map((cliModel) => `${id}/${cliModel}`),
  ]);
}

/** "paperclip/claude_local[/opus]" -> "Claude Local" */
export function adapterLabel(id: string): string {
  const adapterType = resolvePaperclipModel(id)?.spec.adapterType ?? id;
  return adapterType
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Model to suggest to a host whose Claude CLI state preflight has just measured.
 *
 * A failed Claude preflight is enough to stop handing the user a first request
 * that is guaranteed to fail, but it says nothing about any other CLI — so the
 * alternative is probed before it is named, rather than swapping one absent CLI
 * for another. With nothing runnable left, the suggestion stays `DEFAULT_MODEL`:
 * that is the CLI whose install and login hints are the ones being printed.
 *
 * Only advisory, one-shot output uses this (setup's default model, the startup
 * example); request routing keeps `DEFAULT_MODEL` unconditionally, because a
 * startup probe goes stale the moment the user installs or logs into a CLI.
 */
export async function defaultModelForHost(
  claudeOk: boolean,
  canRun: (command: string) => Promise<boolean> = commandRuns,
): Promise<string> {
  if (claudeOk) return DEFAULT_MODEL;

  for (const id of PAPERCLIP_MODEL_IDS) {
    const spec = REGISTRY[id];
    if (spec.authEngine === "claude") continue;
    // A runnable CLI is not enough for these; suggesting one to a fresh host
    // would swap a login hint for a provisioning hint the caller never asked for.
    if (spec.requiresProvisionedGateway) continue;
    const command = String(spec.baseConfig.command ?? "");
    if (command && (await canRun(command))) return id;
  }

  return DEFAULT_MODEL;
}

export interface ResolvedModel {
  spec: PaperclipModelSpec;
  /** Everything after `paperclip/<adapter>/`. Absent means the CLI's default model. */
  cliModel?: string;
}

/**
 * Thrown when a `paperclip/<adapterType>` model is requested but no adapter is
 * registered for it. Surfacing this (instead of silently running Claude) is the
 * whole point: `paperclip/*` must resolve to a Paperclip adapter or fail loudly.
 */
export class UnknownPaperclipModelError extends Error {
  constructor(
    public readonly model: string,
    public readonly knownIds: string[],
  ) {
    const known = knownIds.length > 0 ? knownIds.join(", ") : "(none registered)";
    super(
      `Unknown model "${model}". Expected paperclip/<adapter>[/<cli-model>]. ` +
        `Registered adapters: ${known}. The <cli-model> part is passed to the CLI verbatim; ` +
        `omit it to use the CLI's default model.`,
    );
    this.name = "UnknownPaperclipModelError";
  }
}

/**
 * Split a model id into an adapter and a CLI model string.
 *
 * There is exactly one syntax: `paperclip/<adapterType>[/<cliModel...>]`. The adapter
 * key matches exactly (a prefix match would route `codex_local_x` to the codex CLI),
 * and everything after it is taken as the model string unvalidated — which models
 * exist is the CLI's call, not this proxy's.
 */
export function resolvePaperclipModel(model: string): ResolvedModel | null {
  if (!model.startsWith(PAPERCLIP_MODEL_PREFIX)) return null;

  const rest = model.slice(PAPERCLIP_MODEL_PREFIX.length);
  const slash = rest.indexOf("/");
  const adapterKey = slash === -1 ? rest : rest.slice(0, slash);

  const spec = REGISTRY[PAPERCLIP_MODEL_PREFIX + adapterKey];
  if (!spec) return null;

  const cliModel = slash === -1 ? "" : rest.slice(slash + 1).trim();
  return cliModel ? { spec, cliModel } : { spec };
}

/**
 * Build a runner for a model id.
 *
 * An unresolvable id throws. Any fallback would resurrect the old behavior where a
 * requested model was silently ignored, so an unknown id becomes a 404 the caller sees.
 */
export function createRunner(model: string): AgentRunner {
  const resolved = resolvePaperclipModel(model);
  if (!resolved) {
    throw new UnknownPaperclipModelError(model, PAPERCLIP_MODEL_IDS);
  }
  const { spec, cliModel } = resolved;
  return new PaperclipRunner(spec.execute, spec.baseConfig, {
    model: cliModel,
    promptInjection: spec.promptInjection,
    outputMode: spec.outputMode,
    cliFlags: spec.cliFlags,
    engine: spec.authEngine,
  });
}

/**
 * Mutable holder wrapping `createRunner`. routes.ts calls through this object
 * (rather than the bare function) so tests can substitute the factory: ESM
 * module namespace properties are read-only/non-configurable, so reassigning
 * `registry.createRunner` directly is not possible; a plain object property
 * can be swapped freely.
 */
export const runnerFactory = { create: createRunner };
