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
    super(`Unknown Paperclip adapter model "${model}". Registered paperclip models: ${known}.`);
    this.name = "UnknownPaperclipModelError";
  }
}

export function resolvePaperclipModel(model: string): PaperclipModelSpec | null {
  return REGISTRY[model] ?? null;
}

/**
 * Pick a Paperclip-backed runner for every request.
 *
 * A `paperclip/*` model MUST resolve to a registered adapter; an unknown one
 * throws rather than silently running Claude. Existing non-paperclip model ids
 * retain the proxy's historical behavior by using the claude_local adapter.
 */
export function createRunner(model: string): AgentRunner {
  const spec = resolvePaperclipModel(model);
  if (spec) {
    return new PaperclipRunner(spec.execute, spec.baseConfig, {
      promptInjection: spec.promptInjection,
      outputMode: spec.outputMode,
      cliFlags: spec.cliFlags,
      engine: spec.authEngine,
    });
  }
  if (model.startsWith(PAPERCLIP_MODEL_PREFIX)) {
    throw new UnknownPaperclipModelError(model, PAPERCLIP_MODEL_IDS);
  }
  return new PaperclipRunner(CLAUDE_LOCAL_SPEC.execute, CLAUDE_LOCAL_SPEC.baseConfig, {
    promptInjection: CLAUDE_LOCAL_SPEC.promptInjection,
    outputMode: CLAUDE_LOCAL_SPEC.outputMode,
    cliFlags: CLAUDE_LOCAL_SPEC.cliFlags,
    engine: CLAUDE_LOCAL_SPEC.authEngine,
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
