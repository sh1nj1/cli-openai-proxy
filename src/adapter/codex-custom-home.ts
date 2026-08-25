/**
 * CODEX_HOME for the `paperclip/codex_custom` adapter.
 *
 * The codex CLI has no flag or env var for pointing at a custom OpenAI-compatible
 * endpoint: a `[model_providers.<id>]` table in `$CODEX_HOME/config.toml`, selected
 * by a top-level `model_provider`, is the only mechanism. So a gateway provisioned
 * through /v1/auth has to land in a config file before the run starts.
 *
 * It lands in a fresh home for each run, kept OUT of the Paperclip-managed
 * company tree, and that placement carries the whole design:
 *
 *  - `codex_local` shares one managed home whose `auth.json` is a symlink to the
 *    host's `~/.codex` login. Writing a gateway into that home would make the two
 *    adapters fight over one file every run.
 *  - A home the codex adapter classifies as managed is refused before launch when
 *    it has no `auth.json` and no OPENAI_API_KEY (`evaluateCodexCredentialReadiness`).
 *    A custom provider needs neither — it reads its bearer token from the env var
 *    its table names — so satisfying that gate would mean writing a key to disk for
 *    a check that does not apply. An unmanaged home skips it entirely.
 *
 * Each home belongs to exactly one child process. This binds that process's
 * gateway configuration to the same credential snapshot that supplied its key;
 * another completion cannot rewrite its config.toml between adapter setup and
 * Codex reading it.
 */

import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";
import { CODEX_CUSTOM_API_KEY_ENV } from "../auth/adapters/codex-custom-api-key.js";

/** TOML table name for the provisioned gateway, and the `model_provider` value. */
export const CODEX_CUSTOM_PROVIDER_ID = "custom_gateway";

/**
 * Values codex accepts for `model_reasoning_effort`.
 *
 * Kept as a literal list rather than passed through, because codex does not
 * validate this key: an unknown value is copied verbatim into the request's
 * `reasoning.effort`, and the upstream endpoint rejects it as a bare
 * "Invalid Responses API request" — the same opaque 400 this file exists to
 * stop callers from having to decode.
 */
export const CODEX_REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number];

/**
 * Effort a run gets when the request names none.
 *
 * Not codex's own fallback, which is "none": codex derives effort from built-in
 * metadata for the model, and no gateway model is in that table ("Model metadata
 * for `<id>` not found"). "none" then reaches the wire as a `reasoning` block
 * with no effort, which endpoints serving reasoning-mandatory models reject
 * outright ("Reasoning is mandatory for this endpoint and cannot be disabled",
 * surfaced by OpenRouter as a 400 "Server tool request failed" when codex's
 * web_search tool is in the same request). "medium" is codex's own default for
 * the models it does know, so it is what a caller who says nothing expects.
 *
 * Applying it to non-reasoning models costs nothing: codex sends `reasoning`
 * on every request whatever this key says — omitting it only drops the nested
 * `effort`, never the block — so a model that tolerated the run before still
 * has to accept `reasoning`, and one that rejects the field was already failing.
 */
export const DEFAULT_CODEX_REASONING_EFFORT: CodexReasoningEffort = "medium";

/** Narrow a caller-supplied effort, ignoring anything codex would refuse. */
export function coerceCodexReasoningEffort(value: unknown): CodexReasoningEffort | undefined {
  return typeof value === "string" && (CODEX_REASONING_EFFORTS as readonly string[]).includes(value)
    ? (value as CodexReasoningEffort)
    : undefined;
}

// TOML requires root-level keys to appear before the first table header, while
// the provider table must not swallow whatever root keys the rest of the file
// has — so the managed content is split into a block prepended to the file and
// one appended to it. Same split, and same reason, as the codex adapter's own
// PAPERCLIP_CODEX_PROVIDERS merge.
const ROOT_BEGIN = "# >>> cli-openai-proxy codex_custom provider (root) -- managed, do not edit >>>";
const ROOT_END = "# <<< cli-openai-proxy codex_custom provider (root) <<<";
const TABLE_BEGIN = "# >>> cli-openai-proxy codex_custom provider (table) -- managed, do not edit >>>";
const TABLE_END = "# <<< cli-openai-proxy codex_custom provider (table) <<<";

const blockRe = (begin: string, end: string): RegExp =>
  new RegExp(`${escapeRegExp(begin)}[\\s\\S]*?${escapeRegExp(end)}\\n?`, "g");

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Built from a string so this source file carries no literal control characters.
const TOML_ESCAPE_RE = new RegExp('[\\\\"\\u0000-\\u001f\\u007f]', "g");

const TOML_SHORT_ESCAPES: Record<string, string> = {
  "\\": "\\\\",
  '"': '\\"',
  "\b": "\\b",
  "\t": "\\t",
  "\n": "\\n",
  "\f": "\\f",
  "\r": "\\r",
};

/** TOML 1.0 basic strings must escape backslash, quote, C0 controls, and DEL. */
function tomlString(value: string): string {
  const escaped = value.replace(
    TOML_ESCAPE_RE,
    (char) => TOML_SHORT_ESCAPES[char] ?? `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return `"${escaped}"`;
}

/**
 * Where this adapter's codex home lives.
 *
 * Under the Paperclip instance root so a workspace-scoped run (whose HOME points
 * at the agent workspace) still resolves the same user-level directory, but
 * outside `companies/`, which is the subtree the codex adapter treats as its own
 * to seed (`isManagedCodexHomePath`).
 */
export function resolveCodexCustomHome(runId: string, paperclipHome?: string): string {
  const instanceRoot = resolvePaperclipInstanceRootForAdapter(
    paperclipHome ? { homeDir: paperclipHome } : {},
  );
  return path.join(instanceRoot, "cli-openai-proxy", "codex-custom-homes", runId);
}

/**
 * Merge the provisioned gateway into an existing config.toml, replacing any
 * block a previous run wrote. The adapter may add its managed MCP block after
 * this setup, so content outside our markers remains untouched.
 *
 * Content INSIDE the markers is dropped, which is what should happen to the one
 * thing that lands there: codex records a `[projects."<cwd>"]` trust entry after
 * each run, and its TOML editor inserts it ahead of the file's trailing comments
 * — i.e. inside this block. Every run gets a fresh temp cwd, so those entries are
 * never read again and would otherwise grow the file without bound.
 *
 * `wire_api` is pinned to "responses" rather than exposed as a setting because
 * the codex CLI (>= 0.145) refuses to load a config that asks for "chat" —
 * accepting the value would only let a caller produce a file codex rejects.
 */
export function renderCodexCustomConfigToml(
  existing: string,
  baseUrl: string,
  reasoningEffort: CodexReasoningEffort = DEFAULT_CODEX_REASONING_EFFORT,
): string {
  const preserved = existing
    .replace(blockRe(ROOT_BEGIN, ROOT_END), "")
    .replace(blockRe(TABLE_BEGIN, TABLE_END), "")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");

  const root = [
    ROOT_BEGIN,
    `model_provider = ${tomlString(CODEX_CUSTOM_PROVIDER_ID)}`,
    `model_reasoning_effort = ${tomlString(reasoningEffort)}`,
    ROOT_END,
  ].join("\n");
  const table = [
    TABLE_BEGIN,
    `[model_providers.${CODEX_CUSTOM_PROVIDER_ID}]`,
    `name = ${tomlString("Custom gateway (provisioned via /v1/auth)")}`,
    `base_url = ${tomlString(baseUrl)}`,
    // Indirection, not the literal key: codex reads this env var per request, so
    // the secret stays in the child's environment and never reaches this file.
    `env_key = ${tomlString(CODEX_CUSTOM_API_KEY_ENV)}`,
    `wire_api = ${tomlString("responses")}`,
    TABLE_END,
  ].join("\n");

  return `${[root, ...(preserved ? [preserved] : []), table].join("\n\n")}\n`;
}

/**
 * Create this run's home and point its config.toml at `baseUrl`. Returns the home
 * so the caller can hand it to the adapter as CODEX_HOME. `runId` is generated by
 * the runner and is unique per invocation, so no concurrent child can mutate the
 * file another child will read.
 */
export async function prepareCodexCustomHome(
  baseUrl: string,
  runId: string,
  paperclipHome?: string,
  reasoningEffort: CodexReasoningEffort = DEFAULT_CODEX_REASONING_EFFORT,
): Promise<string> {
  const home = resolveCodexCustomHome(runId, paperclipHome);
  await fs.mkdir(home, { recursive: true });
  const configPath = path.join(home, "config.toml");
  const existing = await fs.readFile(configPath, "utf8").catch(() => "");
  const staged = `${configPath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(staged, renderCodexCustomConfigToml(existing, baseUrl, reasoningEffort), { mode: 0o600 });
    await fs.rename(staged, configPath);
  } catch (err) {
    await fs.rm(staged, { force: true }).catch(() => {});
    throw err;
  }
  return home;
}
