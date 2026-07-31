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
│   ├── auth.ts                 # API_KEYS bearer auth (skips /health and /v1/auth/*)
│   ├── auth-routes.ts          # /v1/auth/* provisioning API (AUTH_ADMIN_KEYS gated)
│   ├── worker-standalone.ts     # socket-activated per-user worker entry point
│   └── provisioner-standalone.ts # root Linux account provisioner entry point
├── isolation/
│   ├── request-identity.ts      # mapped keys / signed immutable user identity
│   ├── worker-proxy.ts          # stream-preserving gateway -> worker forwarding
│   ├── provisioner-client.ts    # platform IPC adapter boundary
│   └── linux-user-provisioner.ts # useradd, mapping, systemd socket lifecycle
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

With `USER_WORKER_MODE=enabled`, user-scoped routes first resolve a trusted
`tenantId + userId`, ask the platform provisioner for a worker endpoint, and
forward the HTTP stream. The same route stack then runs inside the user's
socket-activated worker, so image files, CLI processes, credentials, and usage
are all created under that user's UID and HOME. See
[docs/linux-user-workers.md](docs/linux-user-workers.md).

## Runner Event Contract

The route layer is adapter-agnostic; the events it consumes are:

| Event | Payload | Consumed for |
|-------|---------|--------------|
| `content_delta` | text fragment | SSE `chat.completion.chunk`s |
| `result` | terminal CLI result (usage, cost, summary) | final response, usage billing |
| `error` | `Error` (adapter-aware) | OpenAI-style error body — non-streaming maps it to an HTTP status (`401` on auth failure); streaming has already flushed `200` and writes it in-band as an SSE `error` event |
| `close` | exit code | response finalization |
| `raw` / `message` / `assistant` | raw CLI lines / parsed messages | debugging only — not consumed by routes (`assistant` is emitted by the Claude runner only) |

A `result` before `close` is mandatory: `handleNonStreamingResponse` builds its
response solely from `result` and returns a 500 if the runner closes without
one. A new adapter must emit `result`; emitting only `assistant` is not a
substitute.

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
- **In-flight auth provisioning sessions**: while a `/v1/auth/:engine/sessions`
  flow is pending, `auth/session-manager.ts` holds it in module-level maps
  (`byId`, `byEngine`, plus a `starting` reservation) and may keep a live CLI
  child running until the code is submitted. Sessions are dropped on
  submission, cancellation, TTL expiry (default 10 min, `AUTH_SESSION_TTL_MS`),
  or server shutdown — and, being memory-only, do not survive a restart.
- **Everything else is stateless on the proxy side**: fresh workdir per run,
  no session resume, no model catalog. Claude runs write no transcript
  (`--no-session-persistence`); Codex is not passed `--ephemeral`, so the
  Codex CLI may persist its own session files under `~/.codex`.
