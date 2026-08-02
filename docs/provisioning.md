# Agent provisioning API

The [auth provisioning API](cli-auth-provisioning.md) logs an engine in over
HTTP. This surface handles the step after login: giving the agent its
capabilities. An external app (e.g. Collavre) publishes **one JSON manifest**;
the proxy pulls it, verifies every artifact, and installs it into a
type-specific sandbox on the host. The external side needs no orchestration, no
callbacks, no signing infrastructure — a statically hosted JSON file plus the
artifacts it names is a complete integration.

```
[external app]                          [cli-openai-proxy]
  provision.json + artifacts    ←pull─   fetch → verify → diff → install
  (static hosting is enough)             lockfile ownership, TOFU approval
```

## Enabling it

Off unless `PROVISION_SYNC=1`. Without it every `/v1/provision/*` route answers
`404 provisioning_disabled` and the `provisioning_url` field on auth sessions is
ignored — upgrading the proxy never exposes an install channel by itself.

The routes are gated by the same `AUTH_ADMIN_KEYS` as the auth provisioning
API: installing prompt-loaded instructions is at least as sensitive as mutating
credentials, and a completion key is not accepted.

| Env | Meaning |
| --- | --- |
| `PROVISION_SYNC` | `1` to enable. Unset = feature off (fail-closed). |
| `PROVISION_MANIFEST_URL` | Fixed manifest registration at startup (optional). |
| `PROVISION_ALLOWLIST` | Comma-separated hostnames allowed for the manifest **and** artifacts. Unset = artifacts must share the manifest's host. |
| `PROVISION_AUTOAPPLY` | `approve` (default): first-seen items stop at `pending_approval`. `auto`: install immediately. |
| `PROVISION_REFETCH_MS` | Drift-correction re-fetch interval. Default 3600000 (1h), `0` disables. |
| `PROVISION_STATE_DIR` | Lockfile directory. Default `~/.cli-openai-proxy`. |
| `PROVISION_SKILLS_DIR` | Install dir for `skill` items. Default `~/.claude/skills`. |

## The manifest

```json
{
  "schema": "agent-provisioning/v1",
  "items": [
    {
      "type": "skill",
      "name": "pr-monitor",
      "url": "https://collavre.com/registry/pr-monitor-1.4.2.tar.gz",
      "sha256": "9f2c…"
    }
  ]
}
```

- `items[]` with a per-item `type` is the whole contract. v1 supports
  `type: "skill"`; a type this proxy version does not know reports
  `unsupported` in the status view rather than failing the sync — a newer
  external app can ship new types before every proxy understands them.
- `name` must match `[a-z0-9][a-z0-9_-]{0,63}` — it becomes a directory
  segment.
- `sha256` pins the artifact. A mismatch refuses the install.
- **The manifest never chooses paths.** Each type maps to a hardcoded sandbox
  (`skill` → `~/.claude/skills/{name}`); there is no `path` field by design,
  so the channel cannot become an arbitrary remote file write.

Artifacts are `.tar.gz`, either files at the archive root or everything under
one top-level directory. Removing an item from the manifest uninstalls it on
the next sync; an **empty `items` array removes everything managed** (distinct
from having no manifest registered, which syncs nothing).

## How the manifest URL arrives

Three ways, all equivalent once registered:

1. **With a login** — `POST /v1/auth/{engine}/sessions` accepts an optional
   `provisioning_url`. When that session reaches `authorized`, the proxy
   registers the URL and syncs. One request wires auth + capabilities; the
   external app never has to sequence anything.

   ```json
   { "flow": "device-code", "provisioning_url": "https://collavre.com/agents/vrex/provision.json" }
   ```

   A provisioning failure never fails the login — it lands in the status
   view's `last_error`.
2. **At startup** — `PROVISION_MANIFEST_URL`.
3. **Re-fetch** — once registered, the proxy re-pulls every
   `PROVISION_REFETCH_MS` (default 1h). Updating the JSON is all an external
   app does to roll out changes; a failed sync retries on the next tick.

## Endpoints

All under the admin key (`Authorization: Bearer <admin-key>`).

### `GET /v1/provision`

Status of every item from the last sync (or the lockfile before one):
`installed | pending_approval | unsupported | removed | failed` (+ `error`),
plus `manifest_url`, `last_sync_at`, `last_error`.

### `POST /v1/provision/sync` → status view

Fetch and apply now. Idempotent — retry IS re-sync. `502` when the manifest
itself cannot be fetched or parsed.

### `POST /v1/provision/items/{type}/{name}/approve` → status view

Lift the trust-on-first-use stop for one item and sync. Only items present in
the current manifest can be approved. Once a name is approved, later upgrades
(new sha256) apply without another stop.

### `DELETE /v1/provision/items/{type}/{name}`

Uninstall and **revoke approval** — without revocation the next sync would
silently reinstall and DELETE would be a no-op. The item returns as
`pending_approval` if the manifest still names it.

## Security model

- **Pull, not push.** The proxy fetches from a URL an admin registered; there
  is no push channel to replay or forge, which is why v1 needs no manifest
  signatures.
- **Host policy.** `https` only (loopback excepted, for tests). Without
  `PROVISION_ALLOWLIST`, artifacts must come from the manifest's own host —
  registering a manifest is the trust decision, and it must not fan out to
  arbitrary origins by default.
- **Integrity.** Artifact sha256 is mandatory and idempotency is judged on
  content hash, not version strings — a registry that re-publishes different
  bytes under the same name re-installs (and a tampered one fails).
- **Bounded transfer and expansion.** The download is capped at 10 MiB while
  the body streams (an oversized or never-ending response is cut off at the
  limit, under an overall timeout), and the archive's decompressed size is
  bounded *before* extraction — a small gzip bomb never reaches the
  filesystem.
- **Redirects re-checked.** `fetch` is never allowed to follow a redirect on
  its own: every hop of a manifest or artifact fetch is validated against the
  same host policy, so an allowed host cannot bounce the request to a
  forbidden one.
- **Install = file placement only.** Nothing from an archive is executed. Link
  entries, traversal names, binaries, files over 1 MiB, and text matching
  pipe-download-into-shell patterns are refused. Extraction stages next to the
  target and swaps in atomically; a failed upgrade leaves the previous install
  untouched.
- **Lockfile ownership.** `~/.cli-openai-proxy/provision.lock.json` records
  what the proxy installed; removal only ever touches what it lists. Skills a
  user installed by hand are never overwritten or deleted — a manifest item
  whose name collides with an untracked directory fails with
  `Refusing to replace untracked directory` instead of replacing it.
- **TOFU approval.** In the default `approve` mode a first-seen `(type, name)`
  stops at `pending_approval` until an admin approves it.

### What this does not protect against

A skill is instructions loaded into the agent's prompt. Everything above
bounds *what can arrive* and *where it can land* — it cannot make the
instructions themselves safe. Whoever controls the manifest URL (or the
account behind it) controls what the connected agent is told to do. Treat
enabling `PROVISION_SYNC` — and especially `PROVISION_AUTOAPPLY=auto` — as the
same class of decision as `AUTH_TRUST_COMPLETION_CALLERS`: an explicit
declaration that the manifest's publisher is inside your trust boundary.

### Per-user Linux workers: a known limitation

Provisioning installs into the **gateway process's** skills directory
(`PROVISION_SKILLS_DIR`, default the gateway's `~/.claude/skills`). The
per-user Linux workers (`deploy/linux/cli-openai-proxy-worker@.service`) run
with their own `HOME=/var/lib/cli-openai-proxy/users/%i` and their own write
scope, so they do not see what the gateway installed even when the status view
reports it as `installed`. In that deployment, provisioning currently covers
only engines running as the gateway user; distributing skills into worker
homes (or a shared, per-engine load path) is future work.
