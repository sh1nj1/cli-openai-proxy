# CLI Streaming Protocols

Reference for the wire formats the proxy parses from its CLI subprocesses:
Claude Code's `stream-json` (parsed by `src/adapter/stream-json-parser.ts`,
typed in `src/types/claude-cli.ts`) and Codex's `exec --json` NDJSON (parsed by
`src/adapter/codex-jsonl-parser.ts`). How each adapter delivers the prompt and
which flags it passes is the adapter strategy's job — see
[docs/paperclip-adapters.md](docs/paperclip-adapters.md).

## Claude Code CLI (`stream-json`)

Flags used by the `paperclip/claude_local` lane:

```bash
claude --print \
  --output-format stream-json \
  --verbose \
  --include-partial-messages \
  --no-session-persistence \
  --dangerously-skip-permissions \
  [--append-system-prompt <text>] \
  [--model <alias|full-id>]
```

### Key Flags

| Flag | Description |
|------|-------------|
| `--print` | Non-interactive mode, required for piping |
| `--output-format stream-json` | JSON line output (requires `--verbose`) |
| `--verbose` | Required for stream-json output |
| `--include-partial-messages` | Emits `stream_event` messages with token deltas |
| `--no-session-persistence` | Don't save sessions to disk — runs are stateless |
| `--dangerously-skip-permissions` | Approvals bypassed (why `API_KEYS` matters on non-loopback binds) |
| `--append-system-prompt` | Carries the request's concatenated system/developer messages |
| `--model <alias>` | Family alias (`fable`, `opus`, `sonnet`, `haiku`) or a full id. The CLI owns this list; omitted when the model id has no `<cli-model>` suffix |

### Output Message Types

Each stdout line is one JSON message.

#### 1. System Init (`type: "system", subtype: "init"`)

Sent at session start with full context:

```json
{
  "type": "system",
  "subtype": "init",
  "cwd": "/tmp/paperclip-run-XXXXXX",
  "session_id": "72db4887-c10b-4445-89fa-26e4fc184df9",
  "tools": ["Task", "Bash", "Read", "Edit", ...],
  "mcp_servers": [...],
  "model": "claude-sonnet-4-5-20250929",
  "permissionMode": "bypassPermissions",
  "slash_commands": [...],
  "uuid": "1121b09e-d912-4fd7-91b6-ff72a513e8e4"
}
```

#### 2. Hook Messages (`type: "system", subtype: "hook_*"`)

```json
{
  "type": "system",
  "subtype": "hook_started",
  "hook_id": "...",
  "hook_name": "SessionStart:startup",
  "hook_event": "SessionStart",
  "session_id": "..."
}
```

```json
{
  "type": "system",
  "subtype": "hook_response",
  "hook_id": "...",
  "output": "...",
  "exit_code": 0,
  "outcome": "success"
}
```

#### 3. Stream Events (`type: "stream_event"`)

With `--include-partial-messages`, token-level deltas arrive as Anthropic
streaming events wrapped in a `stream_event` envelope. `content_block_delta`
events are what the proxy turns into SSE chunks:

```json
{
  "type": "stream_event",
  "event": {
    "type": "content_block_delta",
    "index": 0,
    "delta": { "type": "text_delta", "text": "Hello" }
  },
  "session_id": "...",
  "uuid": "..."
}
```

Other `event.type` values (`message_start`, `content_block_start`,
`content_block_stop`, `message_delta`, `message_stop`) frame the deltas.

#### 4. Assistant Message (`type: "assistant"`)

The complete model response (also emitted when partial messages are off):

```json
{
  "type": "assistant",
  "message": {
    "model": "claude-sonnet-4-5-20250929",
    "id": "msg_01Avr9xkb5daf79U5oDRrHQ9",
    "type": "message",
    "role": "assistant",
    "content": [
      {"type": "text", "text": "Hello!"}
    ],
    "stop_reason": null,
    "usage": {
      "input_tokens": 2,
      "output_tokens": 1,
      "cache_creation_input_tokens": 42255
    }
  },
  "session_id": "...",
  "uuid": "..."
}
```

#### 5. Result Message (`type: "result"`)

Final message with stats:

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "duration_ms": 3613,
  "duration_api_ms": 5187,
  "num_turns": 1,
  "result": "The final text response",
  "session_id": "72db4887-c10b-4445-89fa-26e4fc184df9",
  "total_cost_usd": 0.15939125,
  "usage": {
    "input_tokens": 2,
    "output_tokens": 13,
    "cache_creation_input_tokens": 42255,
    "cache_read_input_tokens": 0
  },
  "modelUsage": {
    "claude-sonnet-4-5-20250929": {
      "inputTokens": 2,
      "outputTokens": 13,
      "costUSD": 0.15865725
    }
  }
}
```

`usage`/`modelUsage` feed the proxy's usage tracker; `total_cost_usd` is the
CLI-reported cost, and what it represents depends on how the CLI is
authenticated. Under a subscription login (Claude Pro/Max) it is an informational
API-rate equivalent, not a bill. But when the CLI runs with `ANTHROPIC_API_KEY` —
a host credential the proxy recognizes (`src/auth/registry.ts`) and that
completion subprocesses inherit — the run is API-key backed and the figure can
reflect real API billing.

## Codex CLI (`exec --json` NDJSON)

The `paperclip/codex_local` lane runs `codex exec --json --skip-git-repo-check`
and parses its NDJSON stdout. Codex prints each message as one JSONL line only
once that message is fully generated — there are no token deltas — so the proxy
emits one content delta per completed `agent_message` block. The canonical
result text (non-streaming responses, JSON-mode extraction) is codex's final
`agent_message`, surfaced as the normalized `result.summary`. See
[docs/paperclip-adapters.md](docs/paperclip-adapters.md) for the full
granularity and fallback rules.

## Message Flow Through the Proxy

```
OpenAI client request (POST /v1/chat/completions)
        │
        ▼
┌───────────────────────────┐
│ openai-to-cli             │
│ messages[] → prompt (+    │
│ system prompt)            │
└───────────────────────────┘
        │
        ▼ PaperclipRunner (adapter execute, fresh temp cwd)
┌───────────────────────────┐
│ CLI subprocess            │
│ claude / codex            │
└───────────────────────────┘
        │
        ├──▼ stdout (JSON lines / NDJSON)
        │ ┌─────────────────────────────────┐
        │ │ StreamJsonParser /              │
        │ │ CodexJsonlParser                │
        │ │ - emit content deltas           │
        │ │ - codex only: filter to         │
        │ │   completed agent_message items │
        │ │ - claude only: forward all      │
        │ │   events unfiltered (routes.ts  │
        │ │   keeps text deltas only) +     │
        │ │   in-band terminal result       │
        │ │   (text + usage stats)          │
        │ └─────────────────────────────────┘
        │             │
        └──▼ execute() resolves
          ┌─────────────────────────────────┐
          │ AdapterExecutionResult          │
          │ (adapter-normalized)            │
          │ - codex: final answer + usage   │
          │ - both: errors/timeout/signal   │
          └─────────────────────────────────┘
                      │
                      ▼ PaperclipRunner events → routes.ts
                        (streaming: builds SSE chunks inline;
                         cli-to-openai supplies only the terminal
                         done/usage chunks and the non-streaming
                         cliResultToOpenai conversion)
OpenAI response (SSE chunks + [DONE], or one chat.completion)
```

The parsers own live stdout only. For the Claude lane the terminal `result`
message (final text + usage) arrives in-band through stdout, so
`StreamJsonParser` surfaces it directly. For the Codex lane
`CodexJsonlParser` surfaces only completed `agent_message` text; the terminal
result, usage accounting, and error classification come from the adapter's
normalized `AdapterExecutionResult`, which `PaperclipRunner` processes after
`execute()` resolves (`emitCodexTerminal()`). Failure classification for both
lanes is also driven by this resolved result.

## Important Notes

1. **Auth is the CLI's** (for ordinary local login): each CLI uses its own
   logged-in credential automatically and the proxy does not touch it. The
   exception is the remote [auth provisioning flow](docs/cli-auth-provisioning.md),
   whose persistence model differs per engine: a Claude credential captured
   through `/v1/auth` (a `setup-token` OAuth token or an Anthropic API key) is
   held in proxy memory (`token-store.ts`) and — only when the operator sets
   `AUTH_TRUST_COMPLETION_CALLERS=1` — injected into the completion subprocess
   environment; a `codex_custom` gateway key is held the same way (with the
   gateway URL it authenticates against, which the proxy renders into a
   `config.toml` of its own); a Codex API key is instead forwarded to
   `codex login --with-api-key`, which persists it under `~/.codex` itself, so
   no in-memory holding or trust flag is involved.
2. **Stateless**: no `--session-id`/`--resume` is used; every request is a
   fresh run in a fresh temp directory.
3. **Tools**: the CLIs may invoke their own tools (Bash, Read, Edit, …) during
   a run; where tool events get dropped differs per lane. `CodexJsonlParser`
   filters in the parser (only completed `agent_message` items are surfaced),
   but `StreamJsonParser` forwards every parsed message and every
   `content_block_delta` unfiltered — for the Claude lane it is the route
   layer that omits tool events, by reading only `delta.text` when building
   OpenAI chunks (`routes.ts`). The non-streaming
   response carries only the final text, but a streaming Codex run forwards
   each completed `agent_message` block as a content delta — so concatenating
   the SSE stream can include intermediate narrative, not just the final
   answer.
