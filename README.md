# cli-openai-proxy

**One OpenAI-compatible endpoint in front of the agentic coding CLIs you already have installed.**

Claude Code, Codex, and any other [Paperclip](https://github.com/paperclipai/paperclip)
adapter run behind a single `/v1/chat/completions` endpoint. Any OpenAI client —
an SDK, an IDE plugin, [Collavre](#use-with-collavre), your own service — can
drive them, from another machine if you want.

**Bring your own key.** The proxy owns no vendor account and issues no
credentials. Each CLI authenticates exactly as it does when you run it by hand,
with whatever credential *you* gave it — an API key, an OAuth login, a plan that
covers CLI usage. The proxy just spawns the CLI and translates its output. If a
CLI is not logged in, the completion fails with a `401` naming the engine to
re-authenticate; you can also supply the credential over HTTP through the
[remote auth API](#remote-cli-auth-provisioning).

## Why

- **CLI agents, not just chat models.** These are agentic CLIs — they plan, call
  tools, and write files. This exposes that behind an interface every LLM client
  already speaks, instead of a bespoke integration per CLI.
- **One endpoint, several engines.** Switch engines by changing the `model`
  string. Callers need no per-vendor SDK, key, or code path.
- **Remote by design.** Run the proxy on the machine where the CLIs are
  installed and authenticated; call it from anywhere on your network. Remote
  auth provisioning means a client can recover from an expired login without
  anyone shelling into the host.
- **BYOK, on your host.** Credentials stay where you put them. Nothing is
  proxied through a third-party service.

## Quick Start

```bash
# Install globally
npm install -g cli-openai-proxy

# Start it (needs at least one supported CLI installed and logged in)
cli-openai-proxy &

# See the supported model catalog (a static list — not a health check)
curl http://localhost:3456/v1/models
```

Or clone and run:

```bash
git clone https://github.com/sh1nj1/cli-openai-proxy.git
cd cli-openai-proxy
npm install && npm run build
npm start
```

Send a request:

```bash
curl -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "paperclip/codex_local", "messages": [{"role": "user", "content": "Hello!"}]}'
```

## How It Works

```
Your app / Collavre / IDE plugin  (any OpenAI client)
    |
    | POST /v1/chat/completions   { "model": "paperclip/codex_local", ... }
    v
cli-openai-proxy                  <-- 127.0.0.1:3456 by default
    |
    | model id -> Paperclip adapter
    v
Agent CLI as a subprocess         claude | codex | ...
    |
    | your own credential on this host (BYOK)
    v
Vendor backend --> CLI output --> OpenAI format (SSE or JSON) --> Your app
```

Every request runs through a [Paperclip](https://github.com/paperclipai/paperclip)
adapter, in a fresh temporary working directory that is removed afterwards: no
CLI session and no working directory carries over between requests. That is a
*cwd*, not a sandbox — the CLIs run with approvals bypassed, so a request that
tells the agent to touch a path outside its cwd (your home directory, a repo on
disk) still does, and the next request can see it. See
[docs/paperclip-adapters.md](docs/paperclip-adapters.md).

## Engines and Models

| `model` value | Runs | Auth engine |
|---------------|------|-------------|
| `paperclip/claude_local` | Claude Code (`claude`) | `claude` |
| `paperclip/codex_local` | Codex (`codex`) | `codex` |
| `claude-opus-4-6`, `claude-sonnet-4`, `claude-haiku-4`, … | Claude Code, with that model selected | `claude` |

Any model id that is *not* prefixed `paperclip/` goes to the Claude adapter, so
existing OpenAI-style Claude ids keep working — including provider-prefixed
forms (`anthropic/…`, `openai/…`, `claude-code-cli/…`). An unregistered
`paperclip/<name>` returns `404 model_not_found` rather than silently running
something else.

This table — and `GET /v1/models` — is the catalog of what the proxy *accepts*,
not of what this host can currently run. Neither checks whether the underlying
CLI is installed or logged in, so a request can be accepted here and still fail
at execution. For runtime availability, ask
`GET /v1/auth/{engine}/status` (requires `AUTH_ADMIN_KEYS`; see below).

Adding an engine is one registry entry in
[`src/adapter/paperclip-registry.ts`](src/adapter/paperclip-registry.ts) plus its
published adapter package.

## Use with Collavre

Collavre models an AI agent as a user with an LLM vendor and a gateway URL,
which is exactly the shape this proxy fits — no Collavre-side code, no API key.

1. Run the proxy on a host that has the CLIs logged in, bound so Collavre can
   reach it (see [Remote access](#remote-access)).
2. In the agent's settings, set **vendor** to `openai` and **Gateway URL** to
   `http://<host>:3456/v1`.
3. Set the model to the engine you want — e.g. `paperclip/codex_local` or
   `paperclip/claude_local`.
4. Leave the API key empty unless the proxy runs with `API_KEYS`; then use one of
   those keys.

Collavre accepts arbitrary model ids on an OpenAI-compatible gateway, so each
agent can point at a different CLI while sharing one proxy. Because the CLIs are
agentic, a Collavre agent gets real tool use rather than plain completions. Full
walkthrough: [docs/paperclip-adapters.md](docs/paperclip-adapters.md#collavre-integration-no-collavre-code-changes).

## Features

- **OpenAI-compatible API** — drop-in for any OpenAI client
- **Streaming** — SSE deltas as the CLI produces output
- **Image input** — OpenAI `image_url` parts (base64 data URLs) are materialized
  to temp files and handed to the CLI as inline links, so the agent can see them;
  works across all adapters
- **OpenAI-shaped errors** — usage limits become `429 insufficient_quota` (with
  `Retry-After`), an unauthenticated CLI becomes `401 engine_unauthenticated`.
  Those statuses and headers apply to non-streaming requests; a streaming request
  has already flushed `200`, so the same classified error arrives in-band as an
  SSE `{"error": {...}}` object carrying the same `type`/`code`
- **Remote CLI auth provisioning** — log a CLI in over HTTP
- **Usage tracking** — token counts, latency, and request history. The stored
  model label is bucketed to `opus`/`sonnet`/`haiku` for cost estimation, so it
  does not identify which engine served a request
- **API key auth** — optional Bearer tokens for shared deployments
- **Stateless execution** — fresh isolated workspace per request
- **Auto-start** — macOS LaunchAgent for an always-on service

## Configuration

| Env var | Default | Meaning |
|---------|---------|---------|
| `PORT` | `3456` | Listen port (also accepted as the first CLI argument) |
| `HOST` | `127.0.0.1` | Bind address — set `0.0.0.0` for remote access |
| `API_KEYS` | *(unset)* | Comma-separated Bearer tokens for callers. Unset = open access |
| `AUTH_ADMIN_KEYS` | *(unset)* | Separate key set gating `/v1/auth/*`. Unset = those routes are disabled |
| `AUTH_TRUST_COMPLETION_CALLERS` | *(unset)* | Declares completion callers trusted with a provisioned Claude credential |
| `TIMEOUT` | `0` (none) | Per-request ceiling in ms |
| `DEBUG` | *(unset)* | Verbose logging |

### Remote access

`HOST=0.0.0.0` makes the proxy reachable from other machines. Set `API_KEYS`
whenever you do: the CLIs run with approvals bypassed, so an unauthenticated
caller effectively has code execution on the host.

`API_KEYS` authenticates callers but does not encrypt anything. The proxy speaks
plain HTTP, so the Bearer key and every prompt cross the network in the clear —
anyone who can observe the traffic can replay the key. Beyond loopback, put it
behind TLS (a reverse proxy terminating HTTPS) or an encrypted tunnel such as
Tailscale or WireGuard; the plain `http://` examples below assume a trusted link.

```bash
HOST=0.0.0.0 API_KEYS=sk-team-abc123 cli-openai-proxy

curl http://<host>:3456/v1/chat/completions \
  -H "Authorization: Bearer sk-team-abc123" \
  -H "Content-Type: application/json" \
  -d '{"model": "paperclip/claude_local", "messages": [{"role": "user", "content": "Hello!"}]}'
```

## Remote CLI Auth Provisioning

Log the underlying `claude` / `codex` CLIs in over HTTP instead of shelling into
the host — so a remote UI can recover from an auth failure on its own. Off unless
`AUTH_ADMIN_KEYS` is set (its own key set, separate from `API_KEYS`):

```bash
API_KEYS=sk-team-abc123 \
AUTH_ADMIN_KEYS=sk-admin-xyz789 \
AUTH_TRUST_COMPLETION_CALLERS=1 \
cli-openai-proxy

# 1. open a session — codex returns an API-key prompt, claude an OAuth URL
SESSION_ID=$(curl -sX POST -H "Authorization: Bearer sk-admin-xyz789" \
  http://localhost:3456/v1/auth/codex/sessions | jq -r .sessionId)

# 2. submit the API key (claude: the code from the OAuth URL) to finish
curl -X POST -H "Authorization: Bearer sk-admin-xyz789" \
  -H "Content-Type: application/json" \
  -d '{"value": "sk-..."}' \
  http://localhost:3456/v1/auth/codex/sessions/$SESSION_ID
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
| `/v1/models` | GET | Supported model catalog — static, does not check whether a CLI is installed or authenticated |
| `/v1/chat/completions` | POST | Chat completions (streaming & non-streaming) |
| `/v1/usage` | GET | Usage stats |
| `/v1/usage/recent` | GET | Recent request log |
| `/v1/auth/engines` | GET | Auth flow per engine (needs `AUTH_ADMIN_KEYS`) |
| `/v1/auth/{engine}/status` | GET | Whether that CLI is authenticated |
| `/v1/auth/{engine}/sessions` | POST | Start a login flow |
| `/v1/auth/{engine}/sessions/{id}` | GET / POST / DELETE | Poll / submit / abandon |
| `/v1/auth/{engine}/credential` | DELETE | Forget a provisioned credential |

## Integration Examples

### Python (OpenAI SDK)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3456/v1",
    api_key="not-needed",  # or one of API_KEYS
)

response = client.chat.completions.create(
    model="paperclip/codex_local",
    messages=[{"role": "user", "content": "Hello!"}],
)
```

### Continue.dev / Cursor

```json
{
  "models": [{
    "title": "Claude Code CLI",
    "provider": "openai",
    "model": "claude-opus-4-6",
    "apiBase": "http://localhost:3456/v1",
    "apiKey": "not-needed"
  }]
}
```

### OpenClaw

Configure an OpenAI-compatible provider pointing at `localhost:3456`.

### cURL (streaming)

```bash
curl -N -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "paperclip/claude_local", "messages": [{"role": "user", "content": "Hello!"}], "stream": true}'
```

## Usage Tracking

Token counts and latency per request, persisted to `~/.cli-openai-proxy/usage.json`:

```bash
curl http://localhost:3456/v1/usage

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

`estimatedApiCostSavedUsd` and `maxSubscriptionCostUsd` are priced against
Anthropic's published API rates and a fixed $200 figure — leftovers from the
project's Claude-only origins. Treat them as a rough reference for Claude
traffic only; they say nothing about other engines.

## Prerequisites

- **Node.js >= 22.13.0**
- **At least one supported agent CLI**, installed and authenticated with your own
  credential:
  ```bash
  npm install -g @anthropic-ai/claude-code   # then: claude   (log in)
  npm install -g @openai/codex               # then: codex login
  ```

The proxy starts even if a CLI is missing — a request targeting that engine fails
at request time with a clear error, so a codex-only or claude-only host is fine.

## Auto-Start on macOS

```bash
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

See [docs/macos-setup.md](docs/macos-setup.md).

## Architecture

```
src/
├── adapter/          # OpenAI <-> CLI conversion, adapter registry, output parsers
├── auth/             # Remote CLI login flows, pty driver, in-memory token store
├── cli/              # CLI presence checks
├── server/           # Express server, routes, proxy auth
├── usage/            # Token tracking and analytics
└── types/            # TypeScript type definitions
```

## Security

- CLIs are spawned via `spawn()`, never a shell (no injection)
- Every run gets a fresh temporary working directory
- CLIs run with approvals bypassed — **anyone who can call `/v1/chat/completions`
  can run code on the host.** Set `API_KEYS` on any non-loopback bind
- Proxy access keys (`API_KEYS`, `AUTH_ADMIN_KEYS`) are captured at boot and
  removed from the environment CLI children inherit
- Codex provisioning forwards an API key to `codex login` over stdin; the CLI
  persists it in `~/.codex`
- Claude provisioning captures the `setup-token` OAuth credential, keeps it in
  proxy memory only, and injects it only when the completion-caller trust
  boundary is explicitly accepted

## Important Disclaimer

Completions run the official vendor CLIs as subprocesses; the proxy does not
reverse-engineer private APIs or bypass authentication. The optional remote-auth
API does handle credentials — review the
[credential exposure and trust model](docs/cli-auth-provisioning.md#a-provisioned-claude-credential-is-visible-to-completion-callers)
before enabling it.

Each vendor sets its own terms for how its CLI may be used, including from
automation. Review the terms for the CLIs you enable
([Anthropic](https://www.anthropic.com/terms),
[OpenAI](https://openai.com/policies/terms-of-use)) before deploying. Policies on
third-party tooling may change. Use at your own discretion and risk.

## Contributing

PRs welcome. Please include tests.

## Credits

Originally created by [Atal Ashutosh](https://github.com/atalovesyou) as
[atalovesyou/claude-max-api-proxy](https://github.com/atalovesyou/claude-max-api-proxy).
This repository continues that work with multi-CLI adapters (Claude Code, Codex,
Paperclip), streaming, usage tracking, and remote auth provisioning.

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Atal Ashutosh.
