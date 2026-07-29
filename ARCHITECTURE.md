# cli-openai-proxy — Architecture

A module-by-module map of the codebase. For design rationale (model namespace,
error policy, security model), see [DESIGN.md](DESIGN.md); for adapter
strategies, see [docs/paperclip-adapters.md](docs/paperclip-adapters.md).

## Module Map

```
src/
├── config.ts             # Env-driven config: timeout, version, proxy-secret capture
├── index.ts              # Library exports + provider-plugin default export
├── adapter/              # OpenAI <-> CLI translation and execution
│   ├── paperclip-registry.ts   # model id -> adapter spec; createRunner(); 404 policy
│   ├── paperclip-runner.ts     # AgentRunner impl over @paperclipai adapter execute()
│   ├── agent-runner.ts         # AgentRunner/RunnerOptions contract (EventEmitter)
│   ├── openai-to-cli.ts        # messages[] -> single prompt + system prompt
│   ├── cli-to-openai.ts        # CLI events -> chat.completion(.chunk), usage, JSON mode
│   ├── stream-json-parser.ts   # Claude `--output-format stream-json` line parser
│   ├── codex-jsonl-parser.ts   # `codex exec --json` NDJSON parser
│   ├── image-materializer.ts   # image_url parts -> temp files / inline links
│   └── adapter-error.ts        # CLI failures -> OpenAI-style error bodies
├── auth/                 # Remote CLI login provisioning (optional feature)
│   ├── registry.ts             # auth engines (claude, codex) and their flows
│   ├── session-manager.ts      # provisioning session lifecycle + TTL
│   ├── pty.ts                  # drives interactive CLI logins in a pseudo-tty
│   ├── terminal-scrape.ts      # extracts prompts/URLs from pty output
│   ├── token-store.ts          # in-memory credential holder (never persisted)
│   └── adapters/               # per-engine flows: claude-setup-token, codex-api-key
├── cli/
│   ├── claude.ts               # verifyClaude / verifyAuth presence+login probes
│   └── command.ts              # commandRuns() generic CLI presence probe
├── server/
│   ├── standalone.ts           # bin entry: preflight, config banner, startServer
│   ├── index.ts                # Express app wiring: middleware order, routes, lifecycle
│   ├── routes.ts               # /v1/chat/completions, /v1/models, /v1/usage, /health
│   ├── auth.ts                 # API_KEYS bearer auth for /v1/*
│   ├── auth-routes.ts          # /v1/auth/* provisioning API (AUTH_ADMIN_KEYS gated)
│   └── preflight.ts            # shared startup/setup Claude checks (non-fatal)
├── usage/
│   ├── tracker.ts              # per-request records + summary; ~/.cli-openai-proxy/
│   └── run-usage.ts            # extracts billable usage from CLI results
└── types/
    ├── openai.ts               # OpenAI request/response/chunk types
    └── claude-cli.ts           # Claude CLI stream-json message types + guards
```

## Request Lifecycle

1. `standalone.ts` (or a library caller) starts the server; `createApp()` wires
   middleware in a deliberate order: CORS → `API_KEYS` auth → admin auth for
   `/v1/auth/*` → JSON body parser (30MB) → routes. Auth runs before body
   parsing so rejected requests are never buffered.
2. `routes.ts#handleChatCompletions` validates the body, materializes images,
   and converts messages to a prompt (`openai-to-cli.ts`).
3. `paperclip-registry.ts#createRunner` resolves
   `paperclip/<adapter>[/<cli-model>]` to an adapter spec and builds a
   `PaperclipRunner`; an unknown id throws and surfaces as `404
   model_not_found`.
4. `PaperclipRunner.start()` calls the adapter package's `execute()` with a
   fresh `/tmp/paperclip-run-*` working directory, tees CLI stdout through the
   adapter's parser (`StreamJsonParser` or `CodexJsonlParser`), and re-emits
   the common event set.
5. `routes.ts` maps events to the wire: SSE chunks + opt-in usage chunk
   (`stream_options.include_usage`) + `[DONE]` for streaming, one
   `chat.completion` for non-streaming. Client disconnects kill
   the subprocess (including its process group, even pre-spawn).
6. `usage/tracker.ts` bills the run and serves the `/v1/usage` dashboards.

## Runner Event Contract

The route layer is adapter-agnostic; every runner emits:

| Event | Payload | Consumed for |
|-------|---------|--------------|
| `content_delta` | text fragment | SSE `chat.completion.chunk`s |
| `assistant` | full assistant message | non-streaming fallback text |
| `result` | terminal CLI result (usage, cost, summary) | final response, usage billing |
| `error` | `Error` (adapter-aware) | OpenAI-style error body, 401-on-auth-failure |
| `close` | exit code | response finalization |
| `raw` / `message` | raw CLI lines / parsed messages | debugging |

## HTTP Surface

| Route | Auth | Purpose |
|-------|------|---------|
| `POST /v1/chat/completions` | `API_KEYS` (if set) | Chat, streaming + non-streaming |
| `GET /v1/models` | `API_KEYS` (if set) | Registered adapter ids (same registry that routes requests) |
| `GET /v1/usage`, `/v1/usage/recent` | `API_KEYS` (if set) | Usage summary / recent requests |
| `GET /health` | none | Liveness |
| `/v1/auth/*` (engines, status, sessions, credential) | `AUTH_ADMIN_KEYS` | [Remote CLI auth provisioning](docs/cli-auth-provisioning.md) |

## Data & State

- **Usage records**: `~/.cli-openai-proxy/` (a legacy `~/.claude-max-proxy/`
  directory is migrated there on first load).
- **Provisioned credentials**: in proxy memory only (`auth/token-store.ts`);
  codex API keys are handed to `codex login` which persists them in `~/.codex`.
- **Everything else is stateless**: no session transcripts, fresh workdir per
  run, no model catalog.
