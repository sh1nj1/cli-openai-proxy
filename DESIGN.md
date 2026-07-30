# cli-openai-proxy — Technical Design

## Overview

cli-openai-proxy serves the agentic coding CLIs installed on a machine (Claude
Code, Codex — registered as [Paperclip](https://github.com/paperclipai/paperclip)
adapters) behind a single OpenAI-compatible HTTP API. Any OpenAI client can
drive them by changing the `model` string; each CLI spends its own vendor
credential — normally the one it is already logged in with on the host, or, for
Claude, a setup token provisioned through `/v1/auth` that the proxy holds in
memory and injects per request when `AUTH_TRUST_COMPLETION_CALLERS` is set (see
[Security Considerations](#security-considerations)). Either way the proxy owns
no vendor account and issues none.

For the module-by-module map of the codebase, see
[ARCHITECTURE.md](ARCHITECTURE.md). For adapter-specific behavior (prompt
injection, streaming granularity, flags), see
[docs/paperclip-adapters.md](docs/paperclip-adapters.md).

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        OPENAI CLIENT                            │
│     (SDK, IDE plugin, Collavre, curl — anything that speaks     │
│              the chat.completions API)                          │
└─────────────────────────────────────────────────────────────────┘
                            │ HTTP POST /v1/chat/completions
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│              cli-openai-proxy (Express, port 3456)              │
│                                                                 │
│  auth middleware (API_KEYS) ─▶ body parse (30MB)                │
│         │                                                       │
│         ▼                                                       │
│  ┌──────────────┐  ┌───────────────────┐  ┌─────────────────┐   │
│  │ routes.ts    │─▶│ image-materializer│─▶│ openai-to-cli   │   │
│  │ (validate)   │  │ (data URLs→files) │  │ (msgs→prompt)   │   │
│  └──────────────┘  └───────────────────┘  └─────────────────┘   │
│         │                                                       │
│         ▼                                                       │
│  ┌───────────────────────┐   ┌────────────────────────────┐     │
│  │ paperclip-registry    │──▶│ PaperclipRunner            │     │
│  │ (model id → adapter)  │   │ (parse, cancel; spawn +    │     │
│  │                       │   │  timeout in execute())     │     │
│  └───────────────────────┘   └────────────────────────────┘     │
│         │                                 │ events              │
│         ▼                                 ▼                     │
│  ┌───────────────────────┐   ┌────────────────────────────┐     │
│  │ routes.ts (SSE inline;│◀──│ StreamJsonParser /         │     │
│  │  cli-to-openai: done/ │   │ CodexJsonlParser           │     │
│  │  usage + non-stream)  │   │ (runner-owned)             │     │
│  └───────────────────────┘   └────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────┘
                            │ subprocess, fresh /tmp/paperclip-run-* cwd
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                       AGENTIC CODING CLI                        │
│  claude --print --output-format stream-json --verbose           │
│         --include-partial-messages --no-session-persistence     │
│         --dangerously-skip-permissions [--model <m>]            │
│                        — or —                                   │
│  codex exec --json --skip-git-repo-check [--model <m>]          │
│                                                                 │
│  Auth: host CLI login — or, for Claude, a /v1/auth-provisioned  │
│        setup token injected per request when the operator sets  │
│        AUTH_TRUST_COMPLETION_CALLERS (no host login needed)     │
└─────────────────────────────────────────────────────────────────┘
```

## Entry Points

- **Standalone server** (`src/server/standalone.ts`, the `cli-openai-proxy`
  bin): runs preflight, prints config, and starts the Express server. This is
  the primary way the proxy is deployed.
- **Library exports** (`src/index.ts`): `startServer`/`stopServer`/`getServer`,
  the CLI verify helpers, and `usageTracker` are exported for programmatic use.
  The default export is a model-provider plugin definition for agent hosts that
  consume OpenAI-compatible providers; it registers the proxy as a provider and
  starts the server during the host's interactive auth setup.

## Model Namespace

`createRunner()` accepts exactly one syntax — `paperclip/<adapter>[/<cli-model>]`
— and throws `UnknownPaperclipModelError` (an OpenAI-style `404
model_not_found`) for anything else, including the bare `claude-*` ids accepted
before 2.0. There is deliberately no fallback: silently running Claude for an
unrecognised id is the behaviour the namespace exists to remove.

- The adapter key matches the registry exactly (`paperclip/claude_local`,
  `paperclip/codex_local`); a prefix match would route `codex_local_x` to the
  codex CLI.
- Everything after the adapter key is passed to the CLI verbatim as its model
  string. Which models exist is the CLI's call, not this proxy's — the proxy
  keeps no model catalog.
- A missing or falsy `model` value (omitted, `""`, `null`) falls back to
  `DEFAULT_MODEL` (`paperclip/claude_local`) via `body.model || DEFAULT_MODEL` —
  an empty string is not rejected, it silently runs the default CLI.
- `GET /v1/models` enumerates the same registry that request routing resolves
  against, so a caller cannot be shown an id that then 404s.

## Request Flow (`src/server/routes.ts`)

1. **Validate**: `messages` must be a non-empty array; otherwise a 400 with an
   OpenAI-style error body.
2. **Materialize images**: `image_url` parts become local temp files (data
   URLs) or inline links (http URLs) before conversion, so every adapter sees
   them uniformly. Per-request temp files are cleaned up when the response
   completes.
3. **Convert**: `openaiToCli()` flattens the message array into a single prompt
   (Claude's `--print` mode takes a prompt, not a conversation). System and
   developer messages are concatenated separately; delivery is per-adapter —
   Claude receives them via `--append-system-prompt`, while Codex (which
   rejects Claude-only flags) gets them prepended to the user prompt through
   the rendered prompt template.
4. **Resolve and run**: `runnerFactory.create(model)` resolves the id through
   the registry and builds a `PaperclipRunner` carrying that adapter's strategy
   (prompt injection, output mode, CLI flags). The route layer only knows the
   `AgentRunner` contract:

   ```typescript
   interface AgentRunner extends EventEmitter {
     start(prompt: string, options: RunnerOptions): Promise<void>;
     kill(signal?: NodeJS.Signals): void;
   }
   ```

   Implementations emit `content_delta`, `result`, `error`, and `close` — the
   full contract the route layer consumes. (The Claude runner additionally
   emits an `assistant` event for debugging only; Codex never emits it and
   routes never subscribe to it, so new adapters must not rely on it.) Only
   subprocess execution and timeout enforcement are delegated to
   the pinned `@paperclipai/*` adapter packages through `execute()`; the runner
   itself owns output parsing (it instantiates `StreamJsonParser` /
   `CodexJsonlParser` and feeds them stdout) and cancellation (`kill()` signals
   the process group directly).
5. **Respond**:
   - *Streaming* (`stream: true`): each `content_delta` becomes an SSE
     `chat.completion.chunk`; the `result` event yields the final chunk, a
     usage chunk only when the caller sent `stream_options.include_usage:
     true`, and `data: [DONE]`. Keepalive comments hold the socket open across
     long agentic runs.
   - *Non-streaming*: the `result` event is converted by `cliResultToOpenai()`
     into a single `chat.completion` response with token usage.
   - The response's `model` field echoes the requested id when the caller
     supplied one — never the model name the CLI reports — because gateways
     route and validate on this field, so it has to stay an id the proxy
     itself accepts. A missing or falsy `model` (absent, `""`, `null`) falls
     back to the default (`body.model || DEFAULT_MODEL`), and the response
     then reports that default, not the caller's literal input.
6. **Track usage**: every run is billed to the usage tracker
   (`~/.cli-openai-proxy/`), which powers `GET /v1/usage` and
   `/v1/usage/recent`.

## Session Behavior

CLI runs are intentionally stateless from the proxy's point of view: each
request gets a fresh temporary working directory (`/tmp/paperclip-run-*`,
deliberately not a git repo) and no session is ever resumed. On-disk
persistence differs by lane, though. Claude runs with
`--no-session-persistence`, so no transcript is written. Codex is invoked
without `--ephemeral` (the registry passes only `--skip-git-repo-check`), so
the Codex CLI may still persist its own session files under `~/.codex` even
though the proxy never reads them back. The OpenAI `user` field is accepted
for contract compatibility but current runners do not map it to CLI sessions.

## Error Handling

| Condition | Response |
|-----------|----------|
| Unknown / non-`paperclip/*` model id | `404 model_not_found` — the caller's mistake, not a server fault |
| Empty or missing `messages` | `400 invalid_messages` |
| Oversized image (decoded > 20MB ceiling) | clean `400` from the image materializer, provided the encoded request still fits under the 30MB JSON body limit; a body so large that `express.json()` rejects it first never reaches the materializer and is currently surfaced as a `500` by the generic error handler |
| CLI not logged in / auth failure | non-streaming: `401` naming the auth engine (`claude`, `codex`) so the caller knows which login flow to run — optionally via the [remote auth API](docs/cli-auth-provisioning.md). Streaming: the SSE response has already flushed a `200` header before the CLI starts, so the classified error (same `type`/`code`/`engine`) arrives in-band as a `data: {"error": ...}` event instead of an HTTP status — clients that trigger reauthentication from HTTP status alone will miss it |
| CLI run failure / timeout | adapter error mapped to an OpenAI-style error body by `adapter-error.ts` |
| Missing Claude CLI at startup | non-fatal: preflight warns and the server still starts, because the proxy also serves other adapters. The preflight checks Claude only (`verifyClaude`/`verifyAuth`); a missing Codex CLI (or any future adapter's CLI) produces no startup diagnostic and surfaces only when the first request targeting it fails cleanly at request time |

## Configuration

All configuration is via environment variables (see `src/config.ts` and the
README):

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` (or argv) | `3456` | Listen port |
| `HOST` | `127.0.0.1` | Bind address (`0.0.0.0` to expose; then set `API_KEYS`) |
| `TIMEOUT` | `0` (unbounded) | Per-run subprocess timeout, also applied as socket inactivity timeout |
| `API_KEYS` | unset (open access) | Comma-separated proxy access keys for the completion, model, and usage endpoints; `/v1/auth/*` is exempt and gated solely by `AUTH_ADMIN_KEYS` |
| `AUTH_ADMIN_KEYS` | unset (feature off) | Enables the remote CLI auth provisioning API |
| `AUTH_TRUST_COMPLETION_CALLERS` | unset | Opt-in trust boundary for injecting provisioned Claude credentials into completion runs |
| `DEBUG` | unset | Request logging |

## Security Considerations

1. **Loopback by default**: the server binds `127.0.0.1` unless `HOST` says
   otherwise. CLIs run with approvals bypassed, so anyone who can call
   `/v1/chat/completions` can run code on the host — set `API_KEYS` on any
   non-loopback bind.
2. **No shell injection**: CLIs are spawned via `spawn()`, never a shell.
3. **Secret hygiene**: proxy access keys (`API_KEYS`, `AUTH_ADMIN_KEYS`) are
   captured when the server initializes (`initAuth()`/`initAuthAdmin()`) and
   removed from the environment that completion subprocesses inherit. This
   guarantee covers completion runs only: the startup preflight
   (`claude --version`) and the pre-server CLI presence probes spawn before
   capture and still inherit the full environment, including these keys.
4. **No credential storage**: each CLI keeps its own credentials. The optional
   auth-provisioning flow keeps a captured Claude `setup-token` credential in
   proxy memory only, and injects it only when
   `AUTH_TRUST_COMPLETION_CALLERS` explicitly accepts that trust boundary
   (see [docs/cli-auth-provisioning.md](docs/cli-auth-provisioning.md)).
5. **Auth before body**: the auth middlewares run before the body parser, so an
   unauthenticated request is rejected without buffering its up-to-30MB body.

## Testing Strategy

Tests are colocated `*.test.ts` files compiled with the source and run with the
Node test runner against `dist/`:

```bash
npm run build
npm test
npm run test:coverage   # CI thresholds: 80% stmts/branches/lines, 85% functions
```

Coverage areas include format converters, the stream parsers, route behavior
(streaming, images, usage), the model registry, auth ordering/restart/shutdown,
and the CLI auth provisioning flows. `runnerFactory` is a mutable holder around
`createRunner` precisely so tests can substitute the runner without spawning
real CLIs.

## Deployment

- **npm**: `npm install -g cli-openai-proxy`, then run `cli-openai-proxy`.
- **Linux service**: `./install.sh` builds the project and registers a
  systemd user service (the script exits on any non-Linux `OSTYPE`); rerun it
  after pulling new code.
- **macOS service**: no installer — create a `launchd` LaunchAgent manually
  following [docs/macos-setup.md](docs/macos-setup.md).

## Future Enhancements

1. **Tool visibility**: expose the CLIs' tool usage as response metadata
   instead of filtering it out.
2. **More adapters**: an adapter whose CLI matches an existing strategy pair —
   stdout in one of the two supported `OutputMode` formats (Claude `stream-json`
   or Codex JSONL) and prompt delivery via one of the two `PromptInjection`
   strategies — is one registry entry away
   (`src/adapter/paperclip-registry.ts`). A CLI outside those pairs also needs
   runner work: a new parser and `OutputMode` member (and possibly a new
   injection strategy) in `PaperclipRunner` before a registry entry can use it.
3. **Token-by-token codex streaming**: requires the ACP engine; the current
   `codex exec --json` lane streams per completed message block.
4. **Model routing**: automatic adapter selection based on request shape.
