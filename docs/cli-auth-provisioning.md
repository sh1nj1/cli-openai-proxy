# CLI auth provisioning API

Using this proxy normally means installing `claude` / `codex` on the host **and
logging each of them in locally**. That last step is the one a remote user cannot
do. These endpoints move it over HTTP: a client (e.g. Collavre) can start a login
flow, show the user whatever the CLI needs, and hand the result back — without
shell access to the host.

The intended loop:

1. A completion fails with `401 engine_unauthenticated` naming the engine.
2. The client opens that engine's flow (`POST /v1/auth/{engine}/sessions`).
3. The user completes it (opens a URL, or pastes a key).
4. The client submits the result; the next completion works.

## Enabling it

Disabled unless `AUTH_ADMIN_KEYS` is set. These endpoints mutate host
credentials and accept secrets in request bodies, so they use their **own** key
set, separate from the completion-facing `API_KEYS`:

```bash
API_KEYS=sk-team-abc123 \
AUTH_ADMIN_KEYS=sk-admin-xyz789 \
claude-max-api
```

With it unset, every `/v1/auth/*` route answers `404 auth_provisioning_disabled`
— upgrading the proxy never exposes a login endpoint by itself. A completion key
is not accepted here, and an admin key is not accepted for completions.

| Env | Meaning |
| --- | --- |
| `AUTH_ADMIN_KEYS` | Comma-separated admin keys. Unset = feature off. |
| `AUTH_SESSION_TTL_MS` | Session lifetime before reaping (default `600000`). |

## Flows

Each engine declares the shape of its login, so the client branches its UI on
`flow` rather than on the engine name:

| Engine | `flow` | CLI command | Credential ends up |
| --- | --- | --- | --- |
| `codex` | `api-key` | `codex login --with-api-key` (key over stdin) | in `~/.codex`, written by the CLI |
| `claude` | `paste-code` | `claude setup-token` | in proxy memory, injected per run |

**`api-key`** — no verification URL. Submit the key; the CLI stores it itself.

**`paste-code`** — `claude setup-token` prints an OAuth URL and then blocks
waiting for the code the user gets back from it. Its redirect target is
Anthropic's *hosted* callback (`platform.claude.com/oauth/code/callback`), not
localhost, which is what makes it work remotely: the user can complete it on any
device and read the code off the page.

Two consequences worth knowing:

- The CLI only renders that UI on a real terminal, so the proxy drives it under a
  pty (`node-pty`) and holds the child process alive between the start and submit
  requests. An abandoned session is therefore a live process — hence the TTL
  reaper and the one-session-per-engine rule.
- `setup-token` **does not persist anything**. It prints the token and expects
  the caller to export `CLAUDE_CODE_OAUTH_TOKEN`. The proxy holds that token **in
  memory only** and injects it into every CLI run. Nothing is written to disk, and
  a proxy restart drops it — re-running the flow is the recovery path.

## Endpoints

All require `Authorization: Bearer <AUTH_ADMIN_KEYS entry>`.

### `GET /v1/auth/engines`

```json
{ "object": "list", "data": [
  { "engine": "claude", "flow": "paste-code" },
  { "engine": "codex",  "flow": "api-key" }
] }
```

### `GET /v1/auth/{engine}/status`

`state` is `authenticated` | `unauthenticated` | `unknown`.

`unknown` is not a failure. Claude Code keeps host credentials in the OS
keychain, which the proxy cannot read, so "not provisioned through this API" is
no evidence of being logged out — reporting it as `unauthenticated` would send a
client into a login flow it does not need. `codex` exposes a real check and is
therefore definitive.

### `POST /v1/auth/{engine}/sessions` → `201`

Starts an attempt, superseding any existing one for that engine.

The engine's single session slot is claimed before the CLI is asked for its URL,
so two overlapping starts cannot both take it. The loser is answered `409
session_superseded` and its CLI child is killed immediately — retry to get the
slot back.

```json
{
  "sessionId": "9ceb7f66-…",
  "engine": "claude",
  "flow": "paste-code",
  "status": "pending",
  "verificationUrl": "https://claude.com/cai/oauth/authorize?…",
  "instructions": "Open the URL, approve access, then submit the code…",
  "expiresAt": "2026-07-28T04:38:04.786Z"
}
```

`verificationUrl` is present only for `paste-code`.

### `POST /v1/auth/{engine}/sessions/{sessionId}`

Body takes `value` (aliases: `code`, `api_key`, `apiKey`):

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"code":"abc123#state"}' \
  http://127.0.0.1:3456/v1/auth/claude/sessions/9ceb7f66-…
```

Answers `200` with the session, `status` now `authorized` or `failed`. A rejected
credential is a completed attempt, not a transport error, so it is a `200`
carrying `error: { message, code }` — only malformed requests (`400`) and unknown
sessions/engines (`404`) are 4xx.

### `GET /v1/auth/{engine}/sessions/{sessionId}`

Poll a pending session. Completed and cancelled sessions are forgotten, so they
answer `404 unknown_session`.

### `DELETE /v1/auth/{engine}/sessions/{sessionId}`

Abandon, killing any held CLI child.

### `DELETE /v1/auth/{engine}/credential`

Forget a credential this API provisioned: `{ "engine": "claude", "cleared": true }`.
Only affects credentials the proxy holds — a CLI that persists its own is left
alone, since logging that out is the CLI's own concern.

## The completion-side signal

A run whose CLI has no usable credentials answers `401` with:

```json
{ "error": {
  "message": "Invalid API key. Please run /login to authenticate.",
  "type": "invalid_request_error",
  "code": "engine_unauthenticated",
  "engine": "codex"
} }
```

`engine_unauthenticated` is deliberately distinct from `invalid_api_key` (which
means the *caller's* key is wrong), and `engine` names which flow to open. In
streaming mode the same object arrives in-band on the SSE stream, since the 200
header has already been flushed.

Both run paths emit it. `paperclip/*` models get the classification from the
adapter (`errorCode: "claude_auth_required"`); the default `claude-*` models run
the CLI directly, with no adapter, so the proxy matches the CLI's own
"please log in" wording — but only on a run that already failed (`is_error`, or a
nonzero exit), so an ordinary answer that discusses logins is never turned into a
401. A failure whose wording is not recognised keeps its previous shape rather
than being guessed at, so a client should still treat a repeated failure without
this code as "check the host".

## Scope and limits

- **Auth is per host, not per caller.** `codex` credentials are host-global, and
  the proxy holds a single provisioned credential per engine. Every caller shares
  one identity per engine. Treat one proxy as one identity.
- **`paste-code` sessions do not survive a restart**, by design — nothing is
  persisted. The client restarts the flow.
- The proxy passes `BROWSER=none` to `claude setup-token`: this flow
  authenticates a *remote* user, and on a host with a logged-in browser session a
  locally opened browser can approve the request before that user ever sees the
  URL. Best-effort — the printed URL remains the contract.
