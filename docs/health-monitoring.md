# Health & readiness monitoring

Two endpoints, because "is the gateway alive?" and "can the gateway serve a
request right now?" have different answers, different consumers, and different
correct reactions to a failure.

| Endpoint | Answers | Consumer | Reaction to failure |
|----------|---------|----------|---------------------|
| `GET /health` | Is the process alive? | launchd `KeepAlive`, the docker healthcheck, systemd, the installers' post-install probe | Restart the process |
| `GET /health/ready` | Can it actually serve a completion? | Uptime monitors, Collavre, API clients | A human re-authenticates a CLI |

Neither endpoint requires an API key, so an external monitor can poll them
without holding a completion credential. Both send `Cache-Control: no-store`.

> **Do not point a supervisor at `/health/ready`.** It reports engine state, and
> a logged-out CLI is not something a process restart fixes — wiring it to a
> restart policy turns one expired credential into a restart loop. That is the
> whole reason the two paths are separate.

---

## `GET /health` — liveness

Always `200` if the process can answer at all. It never reflects engine state,
credential state, or anything else a restart cannot fix.

```bash
curl -fsS http://127.0.0.1:3456/health
```

```json
{
  "status": "ok",
  "role": "gateway",
  "uptimeSeconds": 84213
}
```

| Field | Meaning |
|-------|---------|
| `status` | Always `"ok"`. A liveness failure is a connection error or a non-2xx, not a field value. |
| `role` | `"gateway"` or `"worker"` (see [per-user workers](linux-user-workers.md)). |
| `uptimeSeconds` | Process uptime. A monitor can watch this for unexpected restarts. |

`curl -fsS` is the intended check: the status code carries the whole answer.

---

## `GET /health/ready` — readiness

Reports whether any wrapped CLI is actually usable. Answers `200` for `ok` and
`degraded`, and `503` for `down`.

### Without an API key

The minimum an external monitor needs — a rollup and a count. Nothing about the
version, the install, or which engine is broken.

```bash
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3456/health/ready
```

```json
{ "status": "degraded", "engines": { "ready": 1, "total": 3 } }
```

### With an API key

A caller that already holds a valid `API_KEYS` credential gets the per-engine
detail. There is no separate knob for this: with `API_KEYS` unset the whole
server is open already, so every response is the detailed one.

```bash
curl -s -H "Authorization: Bearer $API_KEY" http://127.0.0.1:3456/health/ready | jq .
```

```json
{
  "status": "degraded",
  "role": "gateway",
  "version": "0.2.0",
  "startedAt": "2026-09-08T01:02:03.000Z",
  "uptimeSeconds": 84213,
  "engines": {
    "mode": "host",
    "probedAt": "2026-09-08T18:41:02.000Z",
    "ageMs": 12400,
    "stale": false,
    "items": {
      "claude": {
        "state": "unknown",
        "detail": "No credential provisioned through this API. Claude Code may still be logged in on the host (credentials are kept in the OS keychain and cannot be read here)."
      },
      "codex": { "state": "authenticated", "source": "host" },
      "codex_custom": {
        "state": "unauthenticated",
        "detail": "No gateway provisioned. Submit an API key and `base_url` through this API."
      }
    }
  },
  "features": {
    "apiKeyAuth": true,
    "authProvisioning": true,
    "agentProvisioning": false,
    "userWorkers": false
  },
  "usage": {
    "totalRequests": 1420,
    "failedRequests": 3,
    "lastRequestAt": "2026-09-08T18:39:11.000Z"
  }
}
```

---

## Status semantics

`status` is a rollup over the per-engine `state` values.

| `state` | Meaning |
|---------|---------|
| `authenticated` | The engine answered, and it is logged in. |
| `unauthenticated` | The engine answered, and it is **not** logged in. Someone must run a login flow. |
| `unknown` | No verdict. The check timed out, the CLI is missing from the service `PATH`, or the credential is somewhere this process cannot read. |

| Rollup | HTTP | Condition |
|--------|------|-----------|
| `ok` | 200 | Every engine is `authenticated`. |
| `degraded` | 200 | Anything mixed, or anything `unknown`. Some engines may still serve. |
| `down` | 503 | **Every** engine is explicitly `unauthenticated`. |

### `unknown` is not a failure — read this before alerting

`503` is reserved for "every engine is *provably* unusable". `unknown` never
contributes to it.

This is not conservatism for its own sake. On macOS, Claude Code keeps its
credential in the OS keychain, which the proxy cannot read — so a **completely
healthy production Mac reports `claude` as `unknown` forever**. A rollup that
failed closed on `unknown` would pin that host at `503` permanently. A `codex`
CLI missing from the service `PATH` produces `unknown` for the same reason: no
verdict was obtained, and sending a caller through a login flow it may not need
is worse than saying so.

**Alert on `503` (`down`), not on `degraded`.** `degraded` is the normal steady
state for most installs. If you want to alert on a specific engine, read
`engines.items.<engine>.state` from the authenticated response and alert on
`unauthenticated` for the engines you actually route to.

### Freshness

Engine state is probed in the background and served from a snapshot, so a
request to `/health/ready` never blocks and never spawns a CLI itself. That
matters: `codex login status` spawns a subprocess, and an unauthenticated
endpoint that spawned one per request would be a denial-of-service lever.

| Field | Meaning |
|-------|---------|
| `probedAt` | When the snapshot was taken. `null` before the first probe lands. |
| `ageMs` | Snapshot age. `null` before the first probe lands. |
| `stale` | `true` when the snapshot has aged past 30s (a refresh is already running) or has not been taken yet. |

Consequences for an integrator:

- **The first call after a restart returns `probedAt: null`, `stale: true`, and
  an empty `items`** — the probe was kicked by that very request. `status` is
  `degraded`. Poll again in a few seconds for a real answer; do not treat the
  first response after a restart as a verdict.
- Concurrent callers cost exactly one probe, not one per request.
- A login through `/v1/auth/*` or a credential deletion drops the snapshot
  immediately, so readiness does not lag behind an authentication by up to 30s.
  This includes the device-code flow, which completes on its own without a final
  request: the snapshot is dropped when the CLI reaches its verdict, not when
  your next poll observes it.

---

## Per-user worker mode

When the gateway routes to [per-user workers](linux-user-workers.md), engine
credentials live in each worker's `HOME`. The gateway has no host engines of its
own to report, so it says so instead of guessing:

```json
{
  "status": "ok",
  "engines": {
    "mode": "per-user",
    "note": "Engine credentials are per user; ask /v1/auth/:engine/status with your identity."
  }
}
```

`status: "ok"` here means the gateway is ready to route — it is not a claim
about any user's engines. For a specific user's engine state, call
`GET /v1/auth/{engine}/status` with that user's identity; the gateway forwards
it to their worker. Note that `/health` and `/health/ready` are deliberately
**not** forwarded to a worker: a health check must not depend on picking a user.

---

## Wiring recipes

### Docker Compose

Already configured in [`deploy/docker/docker-compose.yml`](../deploy/docker/docker-compose.yml):

```yaml
healthcheck:
  test: ["CMD", "curl", "-fsS", "http://127.0.0.1:3456/health"]
  interval: 30s
  timeout: 5s
  retries: 3
```

Keep this on `/health`. Container restart policies must not be driven by engine
state.

### Kubernetes

```yaml
livenessProbe:
  httpGet: { path: /health, port: 3456 }
  periodSeconds: 30
readinessProbe:
  httpGet: { path: /health/ready, port: 3456 }
  periodSeconds: 30
  failureThreshold: 3
```

The readiness probe pulls a fully logged-out pod out of the Service without
killing it, which is the correct behaviour: a restart would not log it back in.

### External uptime monitor (over Tailscale, UptimeRobot, Checkly, …)

Point it at `/health/ready` and alert on a non-2xx. `503` means every CLI needs
a human to log it back in; nothing else produces one.

```
URL:      https://<host>:3456/health/ready
Expect:   HTTP 2xx
Interval: 60s
```

If your monitor can assert on the body, alert on `"status":"down"` rather than
on the absence of `"status":"ok"` — `degraded` is a normal healthy-enough state.

### Client-side pre-flight

```js
const res = await fetch(`${base}/health/ready`, {
  headers: { Authorization: `Bearer ${apiKey}` },
});
const health = await res.json();

if (health.engines?.stale) {
  // Snapshot not settled yet (fresh restart). Retry rather than conclude.
}

const usable = Object.entries(health.engines?.items ?? {})
  .filter(([, s]) => s.state !== "unauthenticated")
  .map(([engine]) => engine);
```

Filtering out only `unauthenticated` — rather than keeping only
`authenticated` — is deliberate: an `unknown` engine very often works (see
above), and excluding it would make a healthy macOS host look like it has no
Claude.

### launchd / systemd

Both installers already probe `/health` after install and use it as the service
liveness check. Nothing to add; see [macos-setup.md](macos-setup.md) and the
Linux sections of the [README](../README.md).

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `/health/ready` returns `503` | Every engine is explicitly logged out | Log in via `/auth` or `/v1/auth/{engine}/sessions` |
| `items` is `{}`, `probedAt` is `null` | First call since restart; probe was kicked by this request | Poll again in a few seconds |
| `claude` is permanently `unknown` on macOS | Its credential is in the OS keychain, unreadable from the proxy | Expected. Provision a token through `/v1/auth/claude/sessions` if you want a provable state |
| `codex` is `unknown` with `codex CLI not found on the service PATH` | The service's `PATH` lacks the CLI | Rerun the installer after adding the install directory to `PATH` |
| Response has no `engines.items` | The request carried no valid API key | Send `Authorization: Bearer <API_KEYS value>` |
| `engines.mode` is `per-user` | Per-user worker routing is active | Use `/v1/auth/{engine}/status` with a user identity |

## See also

- [Remote CLI auth provisioning](cli-auth-provisioning.md) — the login flows a
  `503` tells you to run
- [Per-user Linux workers](linux-user-workers.md)
- [Docker deployment](docker.md)
