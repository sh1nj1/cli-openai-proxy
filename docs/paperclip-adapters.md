# Paperclip adapters behind the OpenAI endpoint

Every request runs through a Paperclip agent adapter's `execute()` using the
published `@paperclipai/adapter-*` packages. A model id is
`paperclip/<adapterType>[/<cliModel>]`: the adapter key selects the adapter and
anything after it is the CLI's model string. Registered adapters:

| Model id                 | Paperclip package                   | Requires (on PATH, authed) | Live streaming        |
|--------------------------|-------------------------------------|----------------------------|-----------------------|
| `paperclip/claude_local` | `@paperclipai/adapter-claude-local` | `claude`                   | token-by-token        |
| `paperclip/codex_local`  | `@paperclipai/adapter-codex-local`  | `codex`                    | per message block     |
| `paperclip/codex_custom` | `@paperclipai/adapter-codex-local`  | `codex` + a gateway provisioned through `/v1/auth/codex_custom` | per message block |

All adapters run `engine: "cli"`. Option 1 is **stateless** (no session resume).

## `codex_local` vs `codex_custom`

Same package, same CLI, same stdout dialect — the difference is which credential
a run spends, and that difference forces two adapter ids rather than one.

Codex has no flag or env var for a custom OpenAI-compatible endpoint: it is a
`[model_providers.<id>]` table in `$CODEX_HOME/config.toml` selected by a
**file-global** `model_provider` key. One codex home therefore selects one
provider, so an adapter that could be either would have to rewrite that key per
request and race itself under concurrency.

`codex_custom` consequently gets its own `CODEX_HOME`
(`<paperclip-instance-root>/cli-openai-proxy/codex-custom-home`, written by
`src/adapter/codex-custom-home.ts`), deliberately outside the Paperclip-managed
`companies/` tree:

- `codex_local` shares the managed company home, whose `auth.json` is a symlink
  to the host's `~/.codex` login. A gateway written into that home would make the
  two adapters fight over one file every run.
- A home the codex adapter classifies as managed is refused before launch when it
  has neither `auth.json` nor `OPENAI_API_KEY`. A custom provider needs neither —
  it reads its bearer token from the env var its table names — so satisfying that
  gate would mean writing a key to disk for a check that does not apply.

The generated `config.toml` pins `wire_api = "responses"`: codex ≥ 0.145 refuses
to load a config asking for Chat Completions, so the gateway must serve OpenAI's
Responses API at `<base_url>/responses`. The key itself never enters the file —
`env_key` points at `CODEX_CUSTOM_API_KEY`, injected per run from memory.

A run with nothing provisioned is refused before the CLI is spawned, as
`401 engine_unauthenticated` naming `codex_custom`, so a client opens the right
login flow instead of reading an opaque stream error.

## Notes & limitations

- **The CLI model is pass-through and unvalidated.** Everything after
  `paperclip/<adapterType>/` becomes the adapter's `config.model` verbatim
  (slashes included), which each adapter turns into its CLI's `--model` flag.
  This proxy keeps no model catalog, so a model the CLI rejects surfaces as the
  CLI's own error rather than a silent fallback. Omit the suffix and the key is
  left off `config` entirely, so the CLI picks its own default model.
- **An id outside `paperclip/<registered-adapter>` is a `404 model_not_found`.**
  The adapter key must match exactly — a prefix match would route
  `paperclip/codex_local_x` to the codex CLI.
- **codex streams at message-block granularity (`codex-jsonl`), not token-by-token.**
  Its live stdout is `codex exec --json` NDJSON, not Claude stream-json, so the
  runner parses it live with a dedicated `CodexJsonlParser` and emits a content
  delta per completed `agent_message` block. codex prints each message as one
  JSONL line only once that message is fully generated (there are no token
  deltas), so a single-message answer arrives as one block while an agentic turn
  with multiple messages streams block-by-block as each completes. Token-by-token
  streaming of the final answer would require the ACP engine (Path 2). If no
  `agent_message` block reaches stdout (e.g. the adapter's ACP fallback), the text
  falls back to the normalized `result.summary`, emitted as a single delta — so
  `--stream` requests always terminate correctly (`finish_reason` + `[DONE]`).
  The live stream shows every block, but the canonical result (non-streaming
  responses and JSON-mode extraction) is codex's final `agent_message`
  (`result.summary`), not the concatenation of blocks: JSON mode runs the text
  through `extractJsonFromText`, which returns the first JSON object, so an
  intermediate status block that happens to be JSON must not shadow the answer.
- **codex renders `promptTemplate`, but the raw prompt reaches it verbatim.**
  A prompt containing `{{ … }}` template delimiters is preserved (unlike a naive
  assignment, where the adapter's `renderTemplate()` would substitute/strip
  them). The runner puts the raw prompt in a context variable and sets
  `promptTemplate = "{{context.collavreRawPrompt}}"`; because `renderTemplate` is
  single-pass and never re-scans the resolved value, the user's own `{{ … }}`
  survive — the same guarantee `claude_local` gets via its non-templated
  `paperclipTaskMarkdown` section.
- The Paperclip packages pull transitive dependencies whose highest floor is
  `acpx@0.12.0` (`engines.node >= 22.13.0`; `@agentclientprotocol/claude-agent-acp`
  requires `>= 22`), so this proxy declares `engines.node >= 22.13.0` to match the
  real install requirement. The ACP lane itself is never exercised at runtime
  (`engine: "cli"` always wins), but the packages are still installed, so the
  engine declaration must reflect them.
- Client disconnect mid-run is honored even in the brief window before the
  adapter spawns its child: `kill()` records the requested signal, and once
  `onSpawn` reports the child identifiers the runner immediately signals the
  just-spawned process/group.

## How it works

`src/server/routes.ts` is agent-agnostic: it drives an `EventEmitter` emitting
`content_delta` / `assistant` / `result` / `error` / `close` and maps those to
OpenAI SSE. A one-line factory (`runnerFactory.create(model)`) picks the runner
by model id:

- `paperclip/<adapterType>` → that adapter, on its CLI's default model.
- `paperclip/<adapterType>/<cliModel>` → that adapter, with `<cliModel>` handed
  to the CLI verbatim.
- everything else → `UnknownPaperclipModelError` → `404 model_not_found`.

Every execution uses the same `AgentRunner` contract, so the
SSE/keepalive/orphan-kill route layer remains adapter-agnostic.

### Per-adapter strategies

Paperclip adapters diverge on three seams, so each registry entry
(`src/adapter/paperclip-registry.ts`) carries a strategy that `PaperclipRunner`
applies:

| Seam            | `claude_local`                          | `codex_local`                              |
|-----------------|-----------------------------------------|--------------------------------------------|
| Prompt input    | `task-context` — raw prompt via non-templated `context.paperclipTaskMarkdown` (delimiters survive) | `prompt-template` — raw prompt in `context.collavreRawPrompt`, referenced once as `{{context.collavreRawPrompt}}` (single-pass render, delimiters survive) |
| CLI base flags  | `--include-partial-messages`, `--no-session-persistence` (+ `--append-system-prompt`) | none — codex rejects claude flags (its arg builder appends `extraArgs` verbatim) |
| Output          | `stream-json` — `onLog` stdout teed through `StreamJsonParser` (token deltas) | `codex-jsonl` — `onLog` stdout teed through `CodexJsonlParser` (a content delta per `agent_message` block); `result.summary` is the terminal/fallback text |

Both parsers emit the same `content_delta` + `result` events the route layer
already consumes, so the SSE layer needs no per-adapter changes. When a
`codex-jsonl` run streams no `agent_message` block, the runner synthesizes a
single delta from `result.summary` (the pre-streaming behavior). Adapter approval
bypass is per-adapter too: codex reads
`dangerouslyBypassApprovalsAndSandbox` (claude's `dangerouslySkipPermissions`
is ignored by codex).

## Collavre integration (no Collavre code changes)

Configure an AI-agent User in Collavre:

- **Vendor:** `OpenAI`
- **Model:** `paperclip/claude_local`
- **Gateway/Base URL:** `http://<proxy-host>:<port>/v1`
- **API key:** leave blank (a `local-gateway` placeholder is injected)

Collavre's `AiClient` sets `config.openai_api_base = gateway_url` and calls
`<gateway_url>/chat/completions` with `assume_model_exists: true`, so the
`paperclip/*` model id is accepted verbatim and streamed back into the
conversation via the existing `ResponseStreamer`.
