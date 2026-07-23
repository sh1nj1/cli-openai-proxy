# Paperclip adapters behind the OpenAI endpoint

Models named `paperclip/<adapterType>` route each request through a Paperclip
agent adapter's `execute()` (reusing the published `@paperclipai/adapter-*`
packages) instead of the built-in direct Claude spawn. Registered adapters:

| Model id                 | Paperclip package                   | Notes                            |
|--------------------------|-------------------------------------|----------------------------------|
| `paperclip/claude_local` | `@paperclipai/adapter-claude-local` | Claude Code CLI, `engine: "cli"` |

Requirements: `claude` CLI on PATH and authenticated. Option 1 is **stateless**
(no session resume).

## Notes & limitations

- **The `<adapterType>` selects the adapter, not the Claude model tier.** For
  `paperclip/*` ids the underlying Claude model currently resolves to the
  `opus` default (the id after `paperclip/` isn't a `sonnet`/`haiku` alias), so
  the tier is not selectable through the model id in Option 1.
- A transitive dependency of the ACP lane (`@agentclientprotocol/claude-agent-acp`)
  declares `engines.node >= 22`. This proxy's floor stays Node `>=20` and there
  is no `engine-strict`, so `npm install` on Node 20 only emits an `EBADENGINE`
  warning; the ACP lane is never exercised (`engine: "cli"` always wins).
- Client disconnect mid-run is honored once the adapter has spawned its child;
  a disconnect in the brief window before spawn does not yet cancel the run
  (tracked follow-up — resolved holistically by the Option 2 cancellation work).

## How it works

`src/server/routes.ts` is agent-agnostic: it drives an `EventEmitter` emitting
`content_delta` / `assistant` / `result` / `error` / `close` and maps those to
OpenAI SSE. A one-line factory (`runnerFactory.create(model)`) picks the runner
by model id:

- `paperclip/<adapterType>` → `PaperclipRunner`, which calls the adapter's
  `execute(ctx)` with `config.engine: "cli"` (the adapter defaults to ACP; the
  CLI/stream-json lane requires pinning it) and injects the raw prompt via
  `config.promptTemplate`. It tees `ctx.onLog("stdout", …)` through the shared
  `StreamJsonParser` and re-emits the identical events.
- everything else → the built-in `ClaudeSubprocess` (direct `claude` spawn).

Because both runners satisfy the same `AgentRunner` contract, the proven
SSE/keepalive/orphan-kill route layer is unchanged.

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
