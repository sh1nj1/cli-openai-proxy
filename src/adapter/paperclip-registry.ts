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
}

const CLAUDE_LOCAL_SPEC: PaperclipModelSpec = {
  adapterType: "claude_local",
  execute: claudeLocalExecute as AdapterExecute,
  baseConfig: { engine: "cli", command: "claude" },
  promptInjection: "task-context",
  outputMode: "stream-json",
  cliFlags: ["--include-partial-messages", "--no-session-persistence"],
  authEngine: "claude",
};

const REGISTRY: Record<string, PaperclipModelSpec> = {
  "paperclip/claude_local": CLAUDE_LOCAL_SPEC,
  "paperclip/codex_local": {
    adapterType: "codex_local",
    execute: codexLocalExecute as AdapterExecute,
    // codex reads its own approval-bypass key; claude's dangerouslySkipPermissions
    // is ignored by buildCodexExecArgs. Without this codex blocks on approvals headless.
    baseConfig: { engine: "cli", command: "codex", dangerouslyBypassApprovalsAndSandbox: true },
    // codex ignores paperclipTaskMarkdown (prompt comes from rendered promptTemplate),
    // rejects claude-only flags, and streams its own `codex exec --json` NDJSON, which
    // PaperclipRunner parses live (a content delta per completed agent_message block).
    promptInjection: "prompt-template",
    outputMode: "codex-jsonl",
    // PaperclipRunner runs every adapter in a fresh /tmp/paperclip-run-* dir, which
    // is deliberately not a git repo. buildCodexExecArgs only adds --skip-git-repo-check
    // for its own sandbox lane, not for local `codex exec`, so declare it here (codex
    // appends extraArgs verbatim) to keep local runs from tripping the git-repo guard.
    cliFlags: ["--skip-git-repo-check"],
    authEngine: "codex",
  },
};

export const PAPERCLIP_MODEL_IDS: string[] = Object.keys(REGISTRY);

/** Prefix reserved for explicitly named Paperclip adapters. */
export const PAPERCLIP_MODEL_PREFIX = "paperclip/";

/** Adapter used when a request names no model at all. */
export const DEFAULT_MODEL = "paperclip/claude_local";

/**
 * Model to suggest to a host whose Claude CLI state preflight has just measured.
 *
 * Preflight only probes Claude, so a `false` here does not prove any other CLI
 * works — it only proves this one does not, which is enough to stop handing the
 * user a first request that is guaranteed to fail. Only advisory, one-shot
 * output uses this (setup's default model, the startup example); request routing
 * keeps `DEFAULT_MODEL` unconditionally, because a startup probe goes stale the
 * moment the user installs or logs into the CLI.
 */
export function defaultModelForHost(claudeOk: boolean): string {
  if (claudeOk) return DEFAULT_MODEL;
  return (
    PAPERCLIP_MODEL_IDS.find((id) => REGISTRY[id].authEngine !== "claude") ?? DEFAULT_MODEL
  );
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
