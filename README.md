# cli-openai-proxy

**Turn your $200/mo Claude Max subscription into a full OpenAI-compatible API. Stop paying per token.**

Your Claude Max subscription includes unlimited* Claude usage through the CLI. This proxy wraps that CLI and exposes a standard OpenAI API, so any tool — Continue.dev, Cursor, custom apps, OpenClaw — can use your Max subscription instead of expensive API keys.

> \* Subject to Anthropic's fair use policy

## The Math

| Approach | Monthly Cost | Notes |
|----------|-------------|-------|
| Claude API (Opus) | $15/M in + $75/M out | Adds up fast |
| Claude Max | $200/mo flat | CLI only, no third-party API |
| **This Proxy** | **$0 extra** | Uses your existing Max subscription |

**Heavy users save $500-2000+/month.** If you're already paying for Max, this is free money.

## Quick Start

```bash
# Install globally
npm install -g cli-openai-proxy

# Start the proxy (requires Claude CLI authenticated)
cli-openai-proxy &

# Test it
curl http://localhost:3456/v1/models
```

Or clone and run:

```bash
git clone https://github.com/sh1nj1/cli-openai-proxy.git
cd cli-openai-proxy
npm install && npm run build
npm start
```

## How It Works

```
Your App (any OpenAI client)
    |
    v
cli-openai-proxy (this)  <-- localhost:3456
    |
    v
Claude Code CLI (subprocess)
    |
    v
Your Max subscription (OAuth)
    |
    v
Anthropic API --> Response --> OpenAI format --> Your App
```

Anthropic blocks OAuth tokens from direct third-party API use. But the CLI can use them. This proxy bridges that gap.

## Paperclip adapters

Beyond the built-in direct Claude path, this proxy can run requests through
[Paperclip](https://github.com/paperclipai/paperclip) agent adapters when the
model is named `paperclip/<adapterType>` (e.g. `paperclip/claude_local`). See
[docs/paperclip-adapters.md](docs/paperclip-adapters.md).

## Features

- **OpenAI-compatible API** — Drop-in replacement for any OpenAI client
- **Streaming** — Real-time token streaming via SSE
- **Image input** — OpenAI `image_url` parts (base64 data URLs) are materialized to temp files and passed to the CLI as inline links, so the agent can see them; works across all adapters (Claude and `paperclip/*`)
- **Usage tracking** — See token counts, cost savings, and request history
- **API key auth** — Optional Bearer token auth for team/shared use
- **Multiple models** — Opus, Sonnet, and Haiku
- **Session management** — Conversation context across requests
- **Auto-start** — macOS LaunchAgent for always-on service
- **Credential-aware** — Uses `spawn()` (no shell interpolation) and removes proxy access keys from CLI child environments

## Usage Tracking (New in v1.2)

See exactly how much you're saving:

```bash
# Get usage summary
curl http://localhost:3456/v1/usage

# Response:
{
  "totalRequests": 847,
  "totalInputTokens": 12500000,
  "totalOutputTokens": 3200000,
  "estimatedApiCostSavedUsd": 427.50,
  "avgResponseMs": 2340,
  "byModel": {
    "opus": { "requests": 523, "estimatedCostUsd": 389.20 },
    "sonnet": { "requests": 324, "estimatedCostUsd": 38.30 }
  },
  "maxSubscriptionCostUsd": 200
}

# Recent requests
curl http://localhost:3456/v1/usage/recent?limit=10
```

## API Key Authentication (New in v1.2)

Secure your proxy for team use:

```bash
# Start with API keys
API_KEYS=sk-team-abc123,sk-team-def456 cli-openai-proxy

# Clients must include Bearer token
curl http://localhost:3456/v1/chat/completions \
  -H "Authorization: Bearer sk-team-abc123" \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-opus-4", "messages": [{"role": "user", "content": "Hello!"}]}'
```

When `API_KEYS` is not set, auth is disabled (backwards compatible).

## Remote CLI Auth Provisioning

Log the underlying `claude` / `codex` CLIs in over HTTP instead of shelling into
the host — so a remote UI can recover from an auth failure on its own. Off unless
`AUTH_ADMIN_KEYS` is set (its own key set, separate from `API_KEYS`):

```bash
API_KEYS=sk-team-abc123 \
AUTH_ADMIN_KEYS=sk-admin-xyz789 \
AUTH_TRUST_COMPLETION_CALLERS=1 \
cli-openai-proxy

# codex: submit an API key
curl -X POST -H "Authorization: Bearer sk-admin-xyz789" \
  http://localhost:3456/v1/auth/codex/sessions

# claude: get an OAuth URL back, then submit the code from it
curl -X POST -H "Authorization: Bearer sk-admin-xyz789" \
  http://localhost:3456/v1/auth/claude/sessions
```

`AUTH_TRUST_COMPLETION_CALLERS=1` is required only for Claude provisioning. It
declares that every completion-key holder is trusted with the provisioned OAuth
credential; without it, the Claude session request returns `403
caller_trust_not_declared`.

A completion whose CLI is unauthenticated answers `401` with
`code: "engine_unauthenticated"` and the `engine` to re-authenticate, so a client
can trigger the right flow automatically.

See [docs/cli-auth-provisioning.md](docs/cli-auth-provisioning.md).

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check + usage summary |
| `/v1/models` | GET | List available models |
| `/v1/chat/completions` | POST | Chat completions (streaming & non-streaming) |
| `/v1/usage` | GET | Usage stats and cost savings |
| `/v1/usage/recent` | GET | Recent request log |
| `/v1/auth/engines` | GET | Auth flow per engine (needs `AUTH_ADMIN_KEYS`) |
| `/v1/auth/{engine}/status` | GET | Whether that CLI is authenticated |
| `/v1/auth/{engine}/sessions` | POST | Start a login flow |
| `/v1/auth/{engine}/sessions/{id}` | GET / POST / DELETE | Poll / submit / abandon |
| `/v1/auth/{engine}/credential` | DELETE | Forget a provisioned credential |

## Models

| Model ID | Maps To | API Price (saved) |
|----------|---------|------------------|
| `claude-opus-4-6` | Claude Opus 4.6 | $15/$75 per M tokens |
| `claude-opus-4` | Claude Opus 4 | $15/$75 per M tokens |
| `claude-sonnet-4` | Claude Sonnet 4 | $3/$15 per M tokens |
| `claude-haiku-4` | Claude Haiku 4 | $0.25/$1.25 per M tokens |

Provider-prefixed IDs also work: `anthropic/claude-opus-4-6`, `claude-max/claude-opus-4-6`, etc.

## Integration Examples

### Continue.dev / Cursor

```json
{
  "models": [{
    "title": "Claude (Max)",
    "provider": "openai",
    "model": "claude-opus-4",
    "apiBase": "http://localhost:3456/v1",
    "apiKey": "not-needed"
  }]
}
```

### Python (OpenAI SDK)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3456/v1",
    api_key="not-needed"
)

response = client.chat.completions.create(
    model="claude-opus-4",
    messages=[{"role": "user", "content": "Hello!"}]
)
```

### OpenClaw

Built-in support — just configure the `claude-max` provider pointing to `localhost:3456`.

### cURL

```bash
# Non-streaming
curl -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-opus-4", "messages": [{"role": "user", "content": "Hello!"}]}'

# Streaming
curl -N -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-opus-4", "messages": [{"role": "user", "content": "Hello!"}], "stream": true}'
```

## Auto-Start on macOS

```bash
# Create LaunchAgent
cat > ~/Library/LaunchAgents/com.cli-openai-proxy.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.cli-openai-proxy</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/path/to/cli-openai-proxy/dist/server/standalone.js</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
EOF

launchctl load ~/Library/LaunchAgents/com.cli-openai-proxy.plist
```

## Prerequisites

1. **Claude Max subscription** ($200/mo) — [claude.ai](https://claude.ai)
2. **Claude Code CLI** installed and authenticated:
   ```bash
   npm install -g @anthropic-ai/claude-code
   claude auth login
   ```

## Architecture

```
src/
├── adapter/          # OpenAI <-> CLI format conversion
├── server/           # Express server, routes, auth
├── session/          # Conversation session management
├── subprocess/       # Claude CLI process management
├── usage/            # Token tracking and cost analytics
└── types/            # TypeScript type definitions
```

## Security

- `spawn()` instead of shell execution (no injection attacks)
- Completion and admin access keys are held in memory and removed from CLI child environments
- Codex provisioning receives an API key over HTTP and forwards it to `codex login` over stdin; the CLI persists it in `~/.codex`
- Claude provisioning extracts the `setup-token` OAuth credential, retains it in proxy memory, and injects it only when the completion-caller trust boundary is explicitly accepted
- Optional API key auth for shared deployments

## Important Disclaimer

Normal completions use the official Claude Code CLI (`claude --print`) as a
subprocess; the proxy does not reverse-engineer private APIs or bypass
authentication. The optional remote-auth API does handle credentials: it
forwards Codex API keys to `codex login` and extracts Claude's `setup-token`
OAuth credential for in-memory injection into later Claude runs. Review the
[credential exposure and trust model](docs/cli-auth-provisioning.md#a-provisioned-claude-credential-is-visible-to-completion-callers)
before enabling it.

That said, please review [Anthropic's Terms of Service](https://www.anthropic.com/terms) before using this tool. Anthropic's policies on third-party tooling may change. Use at your own discretion and risk.

## Contributing

PRs welcome. Please include tests.

## Credits

Originally created by [Atal Ashutosh](https://github.com/atalovesyou) as
[atalovesyou/claude-max-api-proxy](https://github.com/atalovesyou/claude-max-api-proxy).
This repository continues that work with multi-CLI adapters (Claude Code, Codex,
Paperclip), streaming, usage tracking, and remote auth provisioning.

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Atal Ashutosh.
