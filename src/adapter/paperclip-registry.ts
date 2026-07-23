/**
 * Registry mapping OpenAI model ids of the form `paperclip/<adapterType>` to a
 * Paperclip adapter's execute() + base config, plus the runner factory that
 * routes.ts uses to pick between PaperclipRunner and the direct ClaudeSubprocess.
 */
import { execute as claudeLocalExecute } from "@paperclipai/adapter-claude-local/server";
import { PaperclipRunner, type AgentRunner, type AdapterExecute } from "./paperclip-runner.js";
import { ClaudeSubprocess } from "../subprocess/manager.js";

export interface PaperclipModelSpec {
  adapterType: string;
  execute: AdapterExecute;
  baseConfig: Record<string, unknown>;
}

const REGISTRY: Record<string, PaperclipModelSpec> = {
  "paperclip/claude_local": {
    adapterType: "claude_local",
    execute: claudeLocalExecute as AdapterExecute,
    baseConfig: { engine: "cli", command: "claude" },
  },
};

export const PAPERCLIP_MODEL_IDS: string[] = Object.keys(REGISTRY);

/** Prefix that routes a request to a Paperclip adapter rather than the direct Claude proxy. */
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
 * Pick the runner for a request's model. Both PaperclipRunner and ClaudeSubprocess
 * satisfy AgentRunner.
 *
 * A `paperclip/*` model MUST resolve to a registered Paperclip adapter; an unknown
 * one throws UnknownPaperclipModelError rather than falling back to Claude. Only
 * non-`paperclip/*` models use the direct Claude proxy (this repo's default).
 */
export function createRunner(model: string): AgentRunner {
  const spec = resolvePaperclipModel(model);
  if (spec) {
    return new PaperclipRunner(spec.execute, spec.baseConfig);
  }
  if (model.startsWith(PAPERCLIP_MODEL_PREFIX)) {
    throw new UnknownPaperclipModelError(model, PAPERCLIP_MODEL_IDS);
  }
  return new ClaudeSubprocess();
}

/**
 * Mutable holder wrapping `createRunner`. routes.ts calls through this object
 * (rather than the bare function) so tests can substitute the factory: ESM
 * module namespace properties are read-only/non-configurable, so reassigning
 * `registry.createRunner` directly is not possible; a plain object property
 * can be swapped freely.
 */
export const runnerFactory = { create: createRunner };
