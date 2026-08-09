# Agent provisioning API

The [auth provisioning API](cli-auth-provisioning.md) logs an engine in over
HTTP. This surface handles the step after login: giving the agent its
capabilities. An external app (e.g. Collavre) publishes **one JSON manifest**;
the proxy pulls it, verifies every source, and installs it into a
type-specific sandbox on the host. The external side needs no orchestration, no
callbacks, or signing infrastructure. Items may keep using pinned `.tar.gz`
artifacts or point at a public git repository commit, branch, or GitHub tree URL.

```
[external app]                          [cli-openai-proxy]
  provision.json + sources      ←pull─   fetch → verify → diff → install
					  lockfile ownership, TOFU approval
```

## Enabling it

Off unless `PROVISION_SYNC=1`. Without it every `/v1/provision/*` route answers
`404 provisioning_disabled` and the `provisioning_url` field on auth sessions is
ignored — upgrading the proxy never exposes an install channel by itself.

The routes are gated by the same `AUTH_ADMIN_KEYS` as the auth provisioning
API: installing prompt-loaded instructions is at least as sensitive as mutating
credentials, and a completion key is not accepted.

Git-backed items require a `git` executable on the service's `PATH`. The
official Docker image includes it. Bare-metal hosts that use only `.tar.gz`
sources do not need git; install the operating system's git package before
enabling a manifest that contains `git` sources.

| Env | Meaning |
| --- | --- |
| `PROVISION_SYNC` | `1` to enable. Unset = feature off (fail-closed). |
| `PROVISION_MANIFEST_URL` | Fixed manifest registration at startup (optional). |
| `PROVISION_ALLOWLIST` | Comma-separated hostnames allowed for the manifest **and** artifacts. Unset = artifacts must share the manifest's host. |
| `PROVISION_AUTOAPPLY` | `approve` (default): first-seen items stop at `pending_approval`. `auto`: install immediately. |
| `PROVISION_REFETCH_MS` | Drift-correction re-fetch interval. Default 3600000 (1h), `0` disables. |
| `PROVISION_STATE_DIR` | Lockfile directory. Default `~/.cli-openai-proxy`. |
| `PROVISION_SKILLS_DIR` | Canonical install dir for `skill` items. Default `~/.agents/skills` (read natively by Codex). |
| `PROVISION_SKILL_LINK_DIRS` | Comma-separated discovery directories that receive managed links to canonical skills. Default `~/.claude/skills`; set to an empty string to disable link fanout. |
| `PROVISION_CONFIG_DIR` | Install root for `config` items. Default `~/.config`; `XDG_CONFIG_HOME` is intentionally ignored because consuming CLIs read `~/.config` directly. |
| `PROVISION_WORKSPACE_ROOT` | Named workspace parent. Default `<worker HOME>/workspaces`. |
| `PROVISION_MAX_WORKSPACES_PER_USER` | Maximum named workspaces per worker/user. Default `32`; existing on-disk workspaces count toward the limit. |

## Per-user scope (worker mode)

Where the engine runs depends on deployment mode, not on any new flag:

- **Solo gateway** (no per-user workers) — one process-local engine, running
  in the gateway's own HOME (`~/.agents/skills`, linked from
  `~/.claude/skills`, plus `~/.cli-openai-proxy`).
- **Per-user Linux workers** (`deploy/linux/cli-openai-proxy-worker@.service`)
  — `X-CLI-Proxy-User-ID` selects the worker and shared engine credentials.
  With signed v2 identity, `X-CLI-Proxy-Workspace-ID` selects
  `<worker HOME>/workspaces/<id>` for skills, config, and lockfiles. Requests
  without that header retain the pre-v2 HOME paths exactly, including the
  canonical `.agents/skills` tree and its `.claude/skills` discovery links.
  `PROVISION_SYNC` on the worker unit remains the explicit opt-in; when unset,
  `/v1/provision/*` answers `404 provisioning_disabled`.

In worker mode `/v1/provision/*` still requires the admin key, and — like
every other scoped route — also requires a user identity
(`X-CLI-Proxy-User-Key` or the signed `X-CLI-Proxy-*` headers, see
[docs/linux-user-workers.md](linux-user-workers.md#trusted-user-identity)).
The gateway forwards the request to that user's worker, which answers from
its own state — there is no cross-user status view or shared endpoint.

Each named workspace owns its manifest URL, lockfile, TOFU approvals, sync
serialization, errors, and refetch timer. Approving or rotating an item in one
agent workspace cannot mutate another workspace's provisioning state.

Workers never receive `AUTH_ADMIN_KEYS` (only the gateway holds it), so a
worker's persisted manifest URL is encrypted at rest with a per-user
`manifest.key` generated alongside its lockfile instead of the admin key
material a solo gateway uses.

When worker routing is active, the gateway validates auth-session notification
ordering but never installs the manifest itself. Enable `PROVISION_SYNC=1` on
worker units; a worker without it returns `404 provisioning_disabled` and does
not fall back to gateway installation.

`PROVISION_SKILLS_DIR`, `PROVISION_CONFIG_DIR`, and `PROVISION_STATE_DIR` apply
only to the legacy/default workspace. Named workspaces always rebase those
locations below their workspace root; the worker logs one warning if legacy
overrides are present. `PROVISION_MANIFEST_URL` likewise applies only to the
default workspace.

The OS security boundary remains the user, not the agent. Workspaces belonging
to the same user run as the same `cap_*` account and can read one another by
path; this separation prevents accidental state/config collisions, not a
malicious prompt from crossing agent directories. Different users retain the
existing Linux-account boundary and cannot read each other's credentials or
workspace config.

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
    },
    {
      "type": "skill",
      "name": "review-helper",
      "git": {
	"url": "https://github.com/example/agent-bundles.git",
	"rev": "main",
	"path": "skills/review-helper"
      }
    },
    {
      "type": "skill",
      "name": "collavre",
      "git": {
	"url": "https://github.com/sh1nj1/plan42/tree/main/skills/collavre"
      }
    },
    {
      "type": "config",
      "name": "collavre",
      "url": "https://collavre.com/registry/workspace-config.tar.gz",
      "sha256": "6a4d…"
    }
  ]
}
```

- `items[]` with a per-item `type` is the whole contract. v1 supports
  `type: "skill"` and `type: "config"`; a type this proxy version does not know reports
  `unsupported` in the status view rather than failing the sync — a newer
  external app can ship new types before every proxy understands them.
- `name` must match `[a-z0-9][a-z0-9_-]{0,63}` — uppercase is rejected so
  names remain unique on case-insensitive filesystems; the name becomes a
  directory segment.
- Each supported item carries exactly one source:
  - `url` + `sha256` downloads the existing `.tar.gz` format. The digest pins
    the artifact bytes; a mismatch refuses the install.
  - `git` fetches a public repository. `rev` may be a full 40- or 64-character
    commit SHA reachable from an advertised branch or tag, or a branch name;
    tags are not accepted as `rev` values. `path` optionally selects one
    repository-relative directory, and omission installs the repository root.
    A GitHub `/tree/{branch}/{path}` browser URL may instead be supplied as
    `git.url`; it is normalized to those three fields automatically.
    Slash-containing branch names use the explicit `url` + `rev` + `path` form
    because GitHub tree URLs do not delimit the branch from the path.
- **The manifest never chooses paths.** Each type maps to a hardcoded sandbox
  (`skill` → `~/.agents/skills/{name}` with a managed
  `~/.claude/skills/{name}` link, `config` → `~/.config/{name}`).
  `git.path` selects source content only;
  it never affects the destination, so the channel cannot become an arbitrary
  remote file write.

Archive sources may put files at the archive root or under one top-level
directory. Git sources reject submodules and install only the selected tree.
Removing an item from the manifest uninstalls it on the next sync; an **empty
`items` array removes everything managed** (distinct from having no manifest
registered, which syncs nothing).

Skill content has one canonical copy. Codex discovers the default
`~/.agents/skills/{name}` directly, while Claude discovers the managed link at
`~/.claude/skills/{name}`. Additional link roots can be configured with
`PROVISION_SKILL_LINK_DIRS`. Link paths and filesystem identities are recorded
in the lockfile; changed or untracked entries fail with `untracked_content`
instead of being replaced or removed. On upgrade from the previous default,
the lockfile first records the proven legacy install root. Migration proceeds
only when the new canonical pathname is absent and after the replacement source
has been downloaded, verified, extracted, and audited. An exact lockfile-owned
`~/.claude/skills/{name}` tree is then retained in a hidden recovery directory
and replaced by the discovery link. A source-preparation failure therefore
leaves the legacy skill live. Canonical collisions and modified or ambiguous
legacy trees are left untouched. The recovery identity and its install root are
journaled before isolation so restart reuses the same recovery. During canonical
publication, the legacy snapshot, original key/root, and isolated tree identity
remain journaled until exposure succeeds; a failed no-replace publish or restart
restores that exact tree to the legacy path without replacing another entry.

### `type: "config"`

A config item installs at `{CONFIG_ROOT}/{name}`, where `CONFIG_ROOT` is
`PROVISION_CONFIG_DIR` or `~/.config`. Use the consuming CLI's directory name
as the item name—for Collavre, `name: "collavre"` places `config.json` at
`~/.config/collavre/config.json`.

- Config sources must use `url` + `sha256`; public `git` sources are refused.
- The archive must contain exactly one flat regular text file named
  `config.json`, or place that file below one wrapper directory matching the
  item name. The file is limited to 1 MiB (with the shared 10 MiB extracted
  archive ceiling). Links, traversal, nested directories, and NUL bytes are
  refused.
- The item directory is forced to `0700` and installed files to `0600`.
- Ownership is per file because the directory is shared with the CLI. Existing
  sibling files survive upgrades and removal. A colliding untracked file fails
  with `untracked_content`; approve again with `{"adopt": true}` to hand that
  file to provisioning explicitly.
- Removing the item deletes only lockfile-recorded files and leaves the shared
  item directory in place. A changed archive hash rotates credentials without
  another approval; an unchanged, intact item is not rewritten.
- Interrupted publication recovery reopens the recorded inode and erases its
  credential bytes through that descriptor. It may retain an empty, random
  `.provision-config-candidate-*` placeholder rather than risk unlinking a user
  file raced into the same name.
- Config contents are never executed or returned. The skill-specific
  remote-execution text heuristic is not applied, while all archive, size,
  binary, and path checks above remain enforced.

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
   view's `last_error`. URLs whose base64url representation exceeds 8 KiB are
   rejected so the private worker-to-gateway notification stays within the
   HTTP response-header budget.
2. **At startup** — `PROVISION_MANIFEST_URL`.
3. **Re-fetch** — once registered, the proxy re-pulls every
   `PROVISION_REFETCH_MS` (default 1h). Updating the JSON is all an external
   app does to roll out changes; a failed sync retries on the next tick.

Manifest and archive URLs may use signed query parameters, but embedded
`https://user:password@host/` credentials are rejected before any request. Git
URLs cannot contain credentials, query parameters, or fragments; v1 supports
public repositories only.

When the manifest and git repository use different hosts, both must appear in
the explicit allowlist. For example, a Collavre-hosted manifest using the
GitHub tree URL above needs
`PROVISION_ALLOWLIST=collavre.example,github.com` (with the real manifest host
in place of `collavre.example`).

## Endpoints

All under the admin key (`Authorization: Bearer <admin-key>`).

### `GET /v1/provision`

Status of every item from the last sync (or the lockfile before one):
`installed | pending_approval | unsupported | removed | failed` (+ `error`),
plus `workspace_id`, `manifest_url`, `last_sync_at`, `last_error`. Archive items report
`sha256`; git items report the requested `git.rev`, its `git.resolved_rev`
commit after resolution, and optional `git.path` without echoing the repository
URL.

### `POST /v1/provision/sync` → status view

Fetch and apply now. Idempotent — retry IS re-sync. `502` when the manifest
itself cannot be fetched or parsed.

### `POST /v1/provision/items/{type}/{name}/approve` → status view

Lift the trust-on-first-use stop for one item and sync. Only items present in
the current manifest can be approved. Once a name is approved, later upgrades
(new archive sha256, git revision, or branch head) apply without another stop.
For a config item that failed on a colliding untracked file, an optional JSON
body `{"adopt": true}` grants that one install permission to take over the file.

### `DELETE /v1/provision/items/{type}/{name}`

Uninstall and **revoke approval** — without revocation the next sync would
silently reinstall and DELETE would be a no-op. `DELETE` removes the item from
the status list immediately because the list reflects the last sync. The next
sync returns it as `pending_approval` if the manifest still names it, including
in `auto` mode. A client rendering immediately after deletion should either
re-sync or show the item as absent. The tombstone clears after the item leaves
the manifest.

## Security model

- **Pull, not push.** The proxy fetches from a URL an admin registered; there
  is no push channel to replay or forge, which is why v1 needs no manifest
  signatures.
- **Host policy.** `https` only (loopback excepted, for tests). Without
  `PROVISION_ALLOWLIST`, artifacts must come from the manifest's own host —
  registering a manifest is the trust decision, and it must not fan out to
  arbitrary origins by default.
- **Integrity.** Archives require sha256. A git commit is used directly; a
  branch is resolved through `refs/heads/*` on every sync, then that exact
  commit is fetched and recorded in the lockfile. Git verifies fetched objects
  before the selected tree is staged. Idempotency uses the archive digest or a
  fingerprint of the git URL/requested ref/resolved commit/path, not version
  strings. A moved branch therefore upgrades, while an unchanged branch does
  not reinstall.
- **Bounded content and archive transfer.** The manifest is capped at 1 MiB and
  each archive at 10 MiB while their bodies stream (an oversized or
  never-ending response is cut off at the limit, under an overall timeout).
  Archive decompression is bounded *before* extraction. Git fetches are shallow,
  time-bounded, and request a blob-size filter, though a server may ignore that
  filter; the fetch subprocess is terminated if its temporary repository grows
  beyond 16 MiB. The selected tree is always subject to the same 1 MiB file and
  10 MiB total-content audit before installation.
- **Redirects re-checked.** HTTP `fetch` is never allowed to follow a redirect on
  its own: every hop of a manifest or artifact fetch is validated against the
  same host policy, so an allowed host cannot bounce the request to a
  forbidden one.
- **Hardened git subprocess.** Git sources disable system/global config,
  credential helpers, hooks, redirects, lazy fetching, and all protocols except
  HTTPS (loopback HTTP is accepted for tests). Only branch refs are resolved;
  tags, submodules, URL credentials, and interactive authentication are
  refused.
- **Install = file placement only.** Nothing from either source is executed. Link
  entries and traversal names are refused. Skills additionally reject binaries,
  files over 1 MiB, and text matching pipe-download-into-shell patterns; config
  items use the tighter limits and text-only rules documented above but skip the
  skill-specific text heuristic. Skills publish their staged directory with the
  platform's atomic no-replace rename; config files use atomic per-file renames,
  so a reader sees either the previous complete file or the replacement. The
  optional native helper for descriptor-relative no-replace publication and
  removal ships for macOS and Linux on arm64/x64 (glibc and musl on Linux);
  installs that omit optional dependencies or use another POSIX target fail
  closed instead of falling back to racy path checks.
- **Lockfile ownership.** `~/.cli-openai-proxy/provision.lock.json` records
  what the proxy installed, including archive-owned directories and per-file
  hashes used to repair missing or modified content on the next sync. Managed
  discovery links are also recorded by path, target, and filesystem identity.
  Their publication intent is journaled before the symlink becomes visible, so
  an interrupted publication can be recovered or removed safely. Links are
  isolated and rechecked before removal. Upgrades
  journal both the stable and candidate ownership snapshots before swapping
  directories, so an interrupted swap is recoverable. Removal records its
  recovery identity before inspecting the target, atomically moves an owned
  target to that hidden recovery, and retains the complete tree; a later
  upgrade requires hash ownership evidence while that removal marker remains.
  Ambiguous targets without an exact snapshot or hash-verified owned file stay
  untouched. Skills a user installed by hand are never overwritten or deleted —
  a manifest item whose name collides with an untracked directory fails with
  `Refusing to replace untracked directory` instead of replacing it. Hidden
  removal, upgrade, and failed candidate recoveries are retained for explicit
  operator cleanup. Failed link isolation can likewise retain a hidden
  `.provision-link-*` entry. Recoveries are never automatically unlinked because an already-open
  descriptor can modify an inode after any integrity check.
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

### Per-user Linux workers

See [Per-user scope (worker mode)](#per-user-scope-worker-mode) above. With
`PROVISION_SYNC=1` on worker units, v2 requests install skills and config below
`~/workspaces/<workspace-id>`; canonical skills are exposed to Claude through
managed discovery links. The CLI child receives that directory as `HOME`.
`PAPERCLIP_HOME` remains `<worker HOME>/.paperclip`, and `CODEX_HOME` is
explicitly pinned to its user-scoped managed `codex-home`; the adapter seeds
that home from the login CLI's `<worker HOME>/.codex`. Codex login is therefore
shared by all of that user's agents without following the workspace `HOME`.
The run `cwd` remains a fresh temporary directory. Leaving `PROVISION_SYNC`
unset on worker units (the default) leaves provisioning off; it does not fall
back to the gateway HOME.
