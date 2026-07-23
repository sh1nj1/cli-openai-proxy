# Paperclip adapters behind the OpenAI endpoint

Models named `paperclip/<adapterType>` route each request through a Paperclip
agent adapter's `execute()` (reusing the published `@paperclipai/adapter-*`
packages) instead of the built-in direct Claude spawn. Registered adapters:

| Model id                 | Paperclip package                   | Requires (on PATH, authed) | Live streaming        |
|--------------------------|-------------------------------------|----------------------------|-----------------------|
| `paperclip/claude_local` | `@paperclipai/adapter-claude-local` | `claude`                   | token-by-token        |
| `paperclip/codex_local`  | `@paperclipai/adapter-codex-local`  | `codex`                    | per message block     |

All adapters run `engine: "cli"`. Option 1 is **stateless** (no session resume).

## Notes & limitations

- **The `<adapterType>` selects the adapter, not a specific model.** For
  `paperclip/claude_local` the underlying Claude model resolves to the `opus`
  default (the id after `paperclip/` isn't a `sonnet`/`haiku` alias). For other
  adapters (e.g. `paperclip/codex_local`) the model id is **not** forwarded at
  all — the adapter uses its own configured default — because the OpenAI model
  id selected the adapter, not a model that adapter would understand. The tier /
  sub-model is not selectable through the model id in Option 1.
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

- `paperclip/<adapterType>` → `PaperclipRunner`, which calls the adapter's
  `execute(ctx)` with `config.engine: "cli"` pinned (adapters default to ACP).
- everything else → the built-in `ClaudeSubprocess` (direct `claude` spawn).

Because both runners satisfy the same `AgentRunner` contract, the proven
SSE/keepalive/orphan-kill route layer is unchanged.

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
