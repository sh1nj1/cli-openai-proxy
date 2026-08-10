/**
 * CODEX_HOME for the `paperclip/codex_custom` adapter.
 *
 * The codex CLI has no flag or env var for pointing at a custom OpenAI-compatible
 * endpoint: a `[model_providers.<id>]` table in `$CODEX_HOME/config.toml`, selected
 * by a top-level `model_provider`, is the only mechanism. So a gateway provisioned
 * through /v1/auth has to land in a config file before the run starts.
 *
 * It lands in a home of this adapter's own, kept OUT of the Paperclip-managed
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
 * The adapter still rewrites this config.toml each run to publish its managed MCP
 * servers, and it preserves whatever it does not own — which is why the provider
 * block is written between markers and merged into the existing file rather than
 * replacing it.
 */

import fs from "fs/promises";
import path from "path";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";
import { CODEX_CUSTOM_API_KEY_ENV } from "../auth/adapters/codex-custom-api-key.js";

/** TOML table name for the provisioned gateway, and the `model_provider` value. */
export const CODEX_CUSTOM_PROVIDER_ID = "custom_gateway";

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
export function resolveCodexCustomHome(paperclipHome?: string): string {
  const instanceRoot = resolvePaperclipInstanceRootForAdapter(
    paperclipHome ? { homeDir: paperclipHome } : {},
  );
  return path.join(instanceRoot, "cli-openai-proxy", "codex-custom-home");
}

/**
 * Merge the provisioned gateway into an existing config.toml, replacing any
 * block a previous run wrote. Content outside the markers is preserved verbatim:
 * the codex adapter appends its own managed MCP block to this same file, and a
 * blind overwrite would drop it.
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
export function renderCodexCustomConfigToml(existing: string, baseUrl: string): string {
  const preserved = existing
    .replace(blockRe(ROOT_BEGIN, ROOT_END), "")
    .replace(blockRe(TABLE_BEGIN, TABLE_END), "")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");

  const root = [ROOT_BEGIN, `model_provider = ${tomlString(CODEX_CUSTOM_PROVIDER_ID)}`, ROOT_END].join("\n");
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
 * Create the home if needed and point its config.toml at `baseUrl`. Returns the
 * home so the caller can hand it to the adapter as CODEX_HOME.
 *
 * Rewritten every run rather than once at provisioning time: the file is derived
 * state, and a run must not inherit the gateway of a credential that has since
 * been replaced or forgotten.
 */
export async function prepareCodexCustomHome(baseUrl: string, paperclipHome?: string): Promise<string> {
  const home = resolveCodexCustomHome(paperclipHome);
  await fs.mkdir(home, { recursive: true });
  const configPath = path.join(home, "config.toml");
  const existing = await fs.readFile(configPath, "utf8").catch(() => "");
  await fs.writeFile(configPath, renderCodexCustomConfigToml(existing, baseUrl), { mode: 0o600 });
  return home;
}
