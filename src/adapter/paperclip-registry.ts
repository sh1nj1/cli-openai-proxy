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

export function resolvePaperclipModel(model: string): PaperclipModelSpec | null {
  return REGISTRY[model] ?? null;
}

/** Pick the runner for a request's model. Both satisfy AgentRunner. */
export function createRunner(model: string): AgentRunner {
  const spec = resolvePaperclipModel(model);
  if (spec) {
    return new PaperclipRunner(spec.execute, spec.baseConfig);
  }
  return new ClaudeSubprocess();
}
