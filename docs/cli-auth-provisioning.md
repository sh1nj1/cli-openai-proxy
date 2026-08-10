# CLI auth provisioning API

Using this proxy normally means installing `claude` / `codex` on the host **and
logging each of them in locally**. That last step is the one a remote user cannot
do. These endpoints move it over HTTP: a client (e.g. Collavre) can start a login
flow, show the user whatever the CLI needs, and hand the result back — without
shell access to the host.

The intended loop:

1. A completion fails with `401 engine_unauthenticated`, naming the engine and
   offering a relative `auth_url` when the UI is enabled.
2. The client opens `auth_url`, or drives that engine's flow directly
   (`POST /v1/auth/{engine}/sessions`).
3. The user completes it (opens a URL, or pastes a key).
4. The client submits the result; the next completion works.

With `AUTH_ADMIN_KEYS` set, open `/auth` on the proxy. It serves the bundled,
dependency-free client and `?engine=codex` preselects an engine only after it
matches the server's engine list. The source file remains available at
[`tools/auth-test.html`](../tools/auth-test.html) for direct local testing against
another base URL.

## Enabling it

Disabled unless `AUTH_ADMIN_KEYS` is set. These endpoints mutate host
credentials and accept secrets in request bodies, so they use their **own** key
set, separate from the completion-facing `API_KEYS`:

```bash
API_KEYS=sk-team-abc123 \
AUTH_ADMIN_KEYS=sk-admin-xyz789 \
cli-openai-proxy
```

With it unset, every `/v1/auth/*` route answers `404 auth_provisioning_disabled`
and `/auth` answers a generic 404 — upgrading the proxy never exposes a login
surface by itself. A completion key is not accepted here, and an admin key is not
accepted for completions.

The UI itself is intentionally loadable without either key because a browser
navigation cannot attach the admin Authorization header. It contains no secret;
the user enters the admin key in a password field, and the page sends it only as
a Bearer header to same-origin `/v1/auth/*` requests. The response is non-cacheable
and uses a nonce CSP, `frame-ancestors 'none'`, and `X-Frame-Options: DENY`.
In per-user worker mode, enter the affected caller's `USER_API_KEYS` key in the
completion/user-key field as well; the page sends it as `X-CLI-Proxy-User-Key`
while keeping the admin key in `Authorization`.
Workers advertise `auth_url` only for requests authenticated by such a mapped
key. Signed-header-only callers do not receive the link because browser requests
cannot recreate the path-bound HMAC identity.

Both key sets are read into memory at startup and **removed from the process
environment**, so neither is inherited by the CLI children a completion spawns.
That matters because those children run with permissions skipped: anything left
in their environment is readable by whoever wrote the prompt, and an ordinary
completion caller could otherwise recover the admin key and use these endpoints.

The captured values persist for the life of the process, so restarting the server
in-process (`stopServer()` then `startServer()`) re-initializes from them rather
than from the environment they were removed from. Re-setting the variable before a
restart still wins, which is how you rotate keys without a new process.

| Env | Meaning |
| --- | --- |
| `AUTH_ADMIN_KEYS` | Comma-separated admin keys. Unset = feature off. |
| `AUTH_TRUST_COMPLETION_CALLERS` | Declares completion callers trusted with provisioned credentials. Required for `claude` — see below. |
| `AUTH_SESSION_TTL_MS` | Session lifetime before reaping (default `600000`). |

## An injected credential is visible to completion callers

Some flows end in a credential no CLI persists: `claude setup-token` prints its
token instead of writing it anywhere, the claude CLI has no api-key login command
at all (it reads `ANTHROPIC_API_KEY` from its environment), and a codex custom
provider reads its bearer token from the env var its `config.toml` table names.
So for `claude` and `codex_custom` the proxy holds the credential and injects it
into the CLI child of every completion. **That child's environment is readable by
whoever wrote the prompt**, so such a credential is recoverable by any caller who
can reach `/v1/chat/completions`.

This is not something the proxy can filter away:

- The child runs with `--dangerously-skip-permissions`, so a prompt can run
  arbitrary commands.
- The CLI does scrub `CLAUDE_CODE_OAUTH_TOKEN` from the environment it hands its
  own tools — but `ps` reports the environment a process was **exec'd** with, and
  no runtime deletion changes that. Do not rely on the scrub.
- Env is the only channel that reaches a CLI which does not persist its own
  credential. Removing the injection removes the feature.

So it is the operator's decision, made explicitly:

```bash
AUTH_TRUST_COMPLETION_CALLERS=1
```

Set it only when every holder of an `API_KEYS` entry is as trusted as the holder
of `AUTH_ADMIN_KEYS` — on a single-operator proxy they are usually the same
person. Without it, `POST /v1/auth/claude/sessions` and
`POST /v1/auth/codex_custom/sessions` answer `403 caller_trust_not_declared`
(refused before you complete a login, so no token is minted), and any credential
already held is withheld from CLI children. For `codex_custom` the gateway URL is
withheld on the same predicate, so a run is never pointed at an endpoint it has
no key for.

`codex` is not gated: both of its flows (`codex login --with-api-key` and
`codex login --device-auth`) persist to `~/.codex` themselves, so nothing of
codex's is injected into an environment this proxy builds.
Note that the file it writes is still readable by a completion caller's shell —
but that is the host's own pre-existing posture, identical to logging in at the
console, and unchanged by this API.

## Flows

Each engine declares the shape of its login, so the client branches its UI on
`flow` rather than on the engine name. An engine may offer several flows; the
first is its default, and `POST …/sessions` picks one by name:

| Engine | `flow` | CLI command | Credential ends up |
| --- | --- | --- | --- |
| `codex` | `api-key` (default) | `codex login --with-api-key` (key over stdin) | in `~/.codex`, written by the CLI |
| `codex` | `device-code` | `codex login --device-auth` | in `~/.codex`, written by the CLI |
| `claude` | `paste-code` (default) | `claude setup-token` | in proxy memory, injected per run — requires `AUTH_TRUST_COMPLETION_CALLERS` |
| `claude` | `api-key` | none — validated against the Anthropic API | in proxy memory, injected per run — requires `AUTH_TRUST_COMPLETION_CALLERS` |
| `codex_custom` | `api-key` | none — probed against the submitted gateway | in proxy memory, injected per run — requires `AUTH_TRUST_COMPLETION_CALLERS` |

**`api-key`** — no verification URL. Submit the key. For codex the CLI stores
it itself (`codex login --with-api-key`). The claude CLI has no such command —
it reads `ANTHROPIC_API_KEY` from its environment — so the proxy validates the
key with one authenticated request to the Anthropic API (`GET /v1/models`; the
key travels in a header, never in the URL) and then holds it in memory like a
`setup-token` credential. Only a definitive HTTP answer is a verdict: `401`/`403`
fail the session with `invalid_api_key`, while an unreachable API fails it with
`validation_unavailable` — never as a bad key.

**`codex_custom`** — the same `codex` CLI pointed at any OpenAI-compatible
gateway (OpenRouter and friends), on that gateway's own key. It is a separate
engine from `codex` because a codex home selects exactly one provider: splitting
them lets `paperclip/codex_local` keep running on your `codex login` while
`paperclip/codex_custom` runs on the gateway.

The submission carries two fields, because the key alone does not say where to
spend it:

```json
{ "api_key": "sk-or-v1-…", "base_url": "https://openrouter.ai/api/v1" }
```

- `base_url` is required (`missing_base_url` otherwise) and must be `https`
  except on loopback — the key rides to it as a bearer token on every request.
  A URL carrying credentials, a query string, or a fragment is refused rather
  than repaired: the CLI appends `/responses` to this value.
- The gateway is probed once with `GET <base_url>/models`. `401`/`403` fails the
  session with `invalid_api_key`; an unreachable host fails it with
  `gateway_unreachable`. Anything else is accepted — some gateways serve
  `/models` publicly, so a `200` proves the URL is a live OpenAI-compatible root
  but says nothing about the key.
- **The gateway must serve OpenAI's Responses API.** Codex ≥ 0.145 refuses to
  load a config asking for Chat Completions, so that is the only wire protocol
  this engine can generate.
- The key is held in memory and injected as `CODEX_CUSTOM_API_KEY`, alongside a
  generated `config.toml` in a `CODEX_HOME` of this adapter's own — kept out of
  the Paperclip-managed tree so it never collides with `codex_local`'s login. The
  file references the env var, so the key itself is never written to disk.

**`device-code`** — the ChatGPT *subscription* login for codex. Plain
`codex login` cannot work remotely: its OAuth redirect targets localhost on the
proxy host, unreachable from the user's browser. Device auth has no redirect —
the CLI prints a verification URL and a one-time `userCode`, the user enters
the code at the URL, and the CLI polls OpenAI until the login is approved.

The direction is the reverse of paste-code: the user carries the code *from*
the session *to* the browser, so nothing is ever submitted back — a POST to the
session answers `400 submission_not_supported`. Instead the session concludes
on its own when the CLI reaches its verdict, and the client polls
`GET …/sessions/{id}` until `status` leaves `pending`. A concluded device-code
session stays readable until its TTL (the poll that discovers the outcome needs
something to read), but releases the engine's session slot immediately.

**`paste-code`** — `claude setup-token` prints an OAuth URL and then blocks
waiting for the code the user gets back from it. Its redirect target is
Anthropic's *hosted* callback (`platform.claude.com/oauth/code/callback`), not
localhost, which is what makes it work remotely: the user can complete it on any
device and read the code off the page.

Two consequences worth knowing:

- The CLI only renders that UI on a real terminal, so the proxy drives it under a
  pty (`node-pty`) and holds the child process alive between the start and submit
  requests. An abandoned session is therefore a live process — hence the TTL
  reaper, the one-session-per-engine rule, and the cleanup on server shutdown.
- `setup-token` **does not persist anything**. It prints the token and expects
  the caller to export `CLAUDE_CODE_OAUTH_TOKEN`. The proxy holds that token **in
  memory only** and injects it into runs **of that engine alone** — a credential
  is one vendor's secret, so the codex CLI is never launched holding a Claude
  token, and vice versa. Nothing is written to disk, and a proxy restart drops it
  — re-running the flow is the recovery path.

## Endpoints

All require `Authorization: Bearer <AUTH_ADMIN_KEYS entry>`.

### `GET /v1/auth/engines`

```json
{ "object": "list", "data": [
  { "engine": "claude", "flows": ["paste-code", "api-key"] },
  { "engine": "codex",  "flows": ["api-key", "device-code"] }
] }
```

`flows` lists every supported flow in order; the first is the default a session
request naming no flow gets. The status endpoint carries the same field.

### `GET /v1/auth/{engine}/status`

`state` is `authenticated` | `unauthenticated` | `unknown`.

`unknown` is not a failure. Claude Code keeps host credentials in the OS
keychain, which the proxy cannot read, so "not provisioned through this API" is
no evidence of being logged out — reporting it as `unauthenticated` would send a
client into a login flow it does not need. `codex` exposes a real check and is
therefore definitive when the CLI answers; a timed-out or externally terminated
check returns `unknown` because it produced no authentication verdict.

A stored Claude token counts as `authenticated` only while
`AUTH_TRUST_COMPLETION_CALLERS` is affirmative. If the operator removes that
declaration, the token remains in memory but is withheld from completion
children, and status returns `unknown` rather than claiming a credential that
runs cannot use. An explicit host credential can still make the status
`authenticated`.

### `POST /v1/auth/{engine}/sessions` → `201`

Starts an attempt, superseding any existing pending one for that engine. The
body may name a `flow` (`{"flow": "device-code"}`); omitted means the engine's
default. A flow the engine does not offer answers `400 unsupported_flow`.

The body may also carry a `provisioning_url`: a manifest the proxy pulls and
applies once this login reaches `authorized`, wiring auth and agent
capabilities in a single request. Ignored unless `PROVISION_SYNC=1`; see
[provisioning.md](provisioning.md).

The engine's single session slot is claimed before the CLI is asked for its URL,
so two overlapping starts cannot both take it. The loser is answered `409
session_superseded` as soon as it is superseded — not after its own URL wait
expires — and its CLI child is killed immediately. Retry to get the slot back.

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

`verificationUrl` is present for `paste-code` and `device-code`; `userCode`
(the one-time code the user enters at the URL) only for `device-code`:

```json
{
  "sessionId": "41d3adfe-…",
  "engine": "codex",
  "flow": "device-code",
  "status": "pending",
  "verificationUrl": "https://auth.openai.com/codex/device",
  "userCode": "YQVF-8EBLA",
  "instructions": "Open the URL, sign in to ChatGPT, and enter the one-time code…",
  "expiresAt": "2026-07-30T09:12:44.120Z"
}
```

### `POST /v1/auth/{engine}/sessions/{sessionId}`

Body takes `value` (aliases: `code`, `api_key`, `apiKey`), plus `base_url`
(alias: `baseUrl`) for engines that route through a caller-chosen gateway —
required by `codex_custom`, ignored by every other engine:

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"code":"abc123#state"}' \
  http://127.0.0.1:3456/v1/auth/claude/sessions/9ceb7f66-…
```

Answers `200` with the session, `status` now `authorized` or `failed`. A rejected
credential is a completed attempt, not a transport error, so it is a `200`
carrying `error: { message, code }` — only malformed requests (`400`) and unknown
sessions/engines (`404`) are 4xx.

One submission drives a session at a time: a second POST that arrives while the
first is still with the CLI is answered `409 session_submitting` rather than
writing a second code into the same pty, or starting a second `codex login` that
races the first to replace the host credential. Retry once the first completes.

### `GET /v1/auth/{engine}/sessions/{sessionId}`

Poll a pending session. Sessions completed by a submit and cancelled sessions
are forgotten, so they answer `404 unknown_session` — the submit response
already carried the outcome. A `device-code` session has no such response, so
its terminal `status` (with `error` on failure) remains readable here until the
session's TTL reaps it.

### `DELETE /v1/auth/{engine}/sessions/{sessionId}`

Abandon, killing any held CLI child — including a `codex login` still running
from a submission in flight, which would otherwise finish and overwrite whatever
credential was installed after it. That submission answers `session_cancelled`.

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

Every completion runs through a Paperclip adapter, so there is one path to this
signal: the adapter classifies the failed run as `errorCode:
"claude_auth_required"`, and the proxy maps that to `engine_unauthenticated`,
naming the engine from the adapter's own auth engine — `paperclip/claude_local`
→ `claude`, `paperclip/codex_local` → `codex`. The proxy never reads the CLI's
wording: the message is passed through verbatim for a human to read, while the
machine-readable part is the adapter's code. A failure the adapter does not
classify that way keeps its own shape (`500`, or `429` for a quota or transient
family) rather than being guessed at, so a client should still treat a repeated
failure without this code as "check the host".

Models are named `paperclip/<adapter>[/<cli-model>]`; an id outside that
namespace answers `404 model_not_found` and so never reaches an engine at all.

## Scope and limits

- **Auth is per host, not per caller.** `codex` credentials are host-global, and
  the proxy holds a single provisioned credential per engine. Every caller shares
  one identity per engine. Treat one proxy as one identity.
- **`paste-code` sessions do not survive a restart**, by design — nothing is
  persisted. The client restarts the flow. `stopServer()` cancels every pending
  session and kills the child it holds, so this holds for an in-process restart
  too: the sessions live in module state, not on the listener, and would
  otherwise stay resolvable and submittable against the next server.
- The proxy passes `BROWSER=none` to `claude setup-token`: this flow
  authenticates a *remote* user, and on a host with a logged-in browser session a
  locally opened browser can approve the request before that user ever sees the
  URL. Best-effort — the printed URL remains the contract.
