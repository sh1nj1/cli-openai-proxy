# Per-user Linux workers

Per-user worker mode keeps one public gateway while running every CLI process as
the authenticated caller's dedicated Linux account.

```text
client -> gateway :3456 -> root provisioner -> systemd socket
                              (first request)       |
                                                   v
                                      worker running as cap_<hash>
                                                   |
                                                   v
                                             claude / codex
```

The gateway never calls `useradd`, runs as root, or changes UID. A small
socket-activated root provisioner owns only account creation, the root-only
identity mapping, and starting the matching worker socket. The worker inherits
the generated user's UID, GID, HOME, CLI credentials, and filesystem access.

## Install

Run the one-shot installer from the checkout:

```bash
sudo ./scripts/install-linux-user-workers.sh
```

The installer reuses a root-trusted Node.js 22.13.0 or newer. If none exists,
it downloads the latest official Node.js 22 Linux archive, verifies it against
Node.js's published SHA-256 manifest, and installs it under
`/opt/cli-openai-proxy/node`. A Node binary below a user-owned or
group/world-writable path is never accepted for Multi mode.

Source is copied to a private staging directory, then `npm ci`, the TypeScript
build, and production pruning run as the dedicated
invocation-scoped `cli-openai-proxy-bld-*` account. The installer never reuses
a preexisting account or UID. The transient account has no gateway group
membership, configuration access, persistent HOME, login shell, or usable
password. Any remaining build-account process is killed before root freezes
the result, then the account and group are removed. A global installer lock
prevents concurrent invocations from sharing deployment state.
Root freezes and validates the entrypoints and direct runtime dependencies
(including `express`) before promoting the result into `/opt`. No
administrator-owned NVM tree or caller-owned `node_modules` is used by the
system services.

The installer creates:

- low-privilege gateway account `cli-openai-proxy`
- transient, invocation-scoped build-only account `cli-openai-proxy-bld-*`
- root provisioner socket `/run/cli-openai-proxy/provisioner.sock`
- one socket-activated `cli-openai-proxy-worker@<account>` per user
- persistent homes under `/var/lib/cli-openai-proxy/users`
- root-only HMAC mapping key and mapping database
- a root-owned, non-writable runtime release under `/opt/cli-openai-proxy`

The first install creates `/etc/cli-openai-proxy/gateway.env` with separate
random user and administrator keys, plus a default tenant/user mapping. The
new keys are shown once at the end:

```text
USER_API_KEYS='[{"key":"...","tenantId":"default","userId":"default"}]'
AUTH_ADMIN_KEYS=...
```

Set `INSTALL_TENANT_ID` and `INSTALL_USER_ID` to choose stable IDs on first
install. Reinstalls preserve the whole environment file and its keys. Explicit
rotation requires `INSTALL_ROTATE_KEYS=1`; it keeps every existing tenant/user
mapping and replaces only its key. Save the newly printed values before closing
the terminal. The file is root-owned, readable by the gateway group, and mode
`0640`.

The installer enables and starts the services automatically, then verifies the
provisioner service/socket and gateway health:

```bash
sudo systemctl start cli-openai-proxy-gateway.service
sudo systemctl status cli-openai-proxy-gateway.service
```

`USER_WORKER_MODE=enabled` is set by the gateway unit. Do not run the ordinary
single-user `scripts/install-linux-single-user.sh` at the same time; it
installs a different systemd user service on the same default port. When
converting, invoke the Multi installer through `sudo` from the Single service
user. It disables and stops `com.cli-openai-proxy.service` before starting the
system gateway. For a different account or unit name, set
`INSTALL_SINGLE_USER` or `INSTALL_SINGLE_SERVICE_NAME`.

The installer also installs the engine CLIs. `INSTALL_CLIS` defaults to
`@anthropic-ai/claude-code @openai/codex`; set it to other space-separated npm
package names to change the set, or to an empty string to skip the step.
Like the application build, the packages are installed by the transient
unprivileged build account, frozen to root-owned read-only files, and promoted
to `/opt/cli-openai-proxy/clis`. The worker and gateway units run with
`PATH=<node bin dir>:/opt/cli-openai-proxy/clis/bin:/usr/local/bin:/usr/bin:/bin`,
so the managed CLIs are visible to every dynamically created worker account.
This system-wide location matters: workers cannot execute binaries hidden in
an administrator's HOME (nvm trees, `~/.local`, and similar are invisible to
them).

To add or update CLIs without a full reinstall, a system-wide manual install
also stays on the service PATH:

```bash
# Managed runtime (no root-trusted system Node existed at install time). The
# managed npm is a `#!/usr/bin/env node` script and sudo's secure_path does not
# include the versioned directory, so put its sibling node on PATH explicitly:
sudo env PATH="/opt/cli-openai-proxy/node/v<version>/bin:$PATH" \
  npm install -g @openai/codex @anthropic-ai/claude-code

# System Node (e.g. /usr/bin/node): plain global installs already land on PATH.
sudo npm install -g @openai/codex @anthropic-ai/claude-code
```

An adapter status of `"detail": "codex CLI not found on the service PATH"`
means the CLI was skipped via `INSTALL_CLIS` or landed outside the service
PATH.

Each new installation creates an
immutable release directory under `/opt`; old release directories may be
removed manually after the new services are healthy.
Re-running the installer stops an active gateway, restarts all active per-user
workers and the provisioner on the new release, then starts the gateway again.
Active CLI requests can be interrupted during this upgrade, so schedule it
during a maintenance window.

Containerized deployments — including macOS/Windows, where Docker Desktop runs
containers in a Linux VM — should use [docs/docker.md](docker.md) instead of
running the installer directly. The container's first-boot systemd unit runs
this same installer but promotes the already built, pruned, root-owned image
bundle; the image build performs the unprivileged dependency/build stage.

## Single to Multi credential transition

The Single service's CLI login state belongs to its original HOME and is not
copied. After Multi is healthy, use the generated admin key together with each
mapped user key to repeat Codex device login through `/v1/auth/*`, then repeat
that user's agent provisioning. Each operation is routed to the new dedicated
`cap_*` HOME. Remove old Single credentials only after all mapped users have
been verified.

## Integration test

`npm run test:integration:linux-workers` builds the production image from the
root `Dockerfile`, runs the real installer inside it, and asserts the
isolation boundaries end to end: dynamic `cap_*` account creation, worker
UID/HOME, socket and state-file permissions, fail-closed auth, and that a chat
completion's CLI process runs as the caller's dedicated account (via a stub
`claude` that reports its own OS identity). The stub `claude` is injected into
the running container at test time, not baked into the image — the
production image ships no CLI at all. It needs Docker and takes a few minutes;
CI runs it on every PR.

## Trusted user identity

The OpenAI request body's `user` field is session data and is never an authority.
Worker mode fails closed unless one of these identity mechanisms succeeds.
The gateway also refuses to start when either identity mechanism is configured
without active per-user worker routing.

### Per-user API keys

Set a compact JSON array. Keys must be at least 16 characters and IDs must be
stable internal identifiers, not names or email addresses.

```bash
USER_API_KEYS='[{"key":"replace-with-random-user-key","tenantId":"collavre","userId":"immutable-user-id"}]'
```

For completion and usage routes, send that key as the Bearer token. For
`/v1/auth/*`, `Authorization` is already the admin credential, so send the user
key separately:

```text
Authorization: Bearer <AUTH_ADMIN_KEYS entry>
X-CLI-Proxy-User-Key: <USER_API_KEYS entry>
```

### Signed identity headers

A trusted upstream can use one shared completion/admin key and sign the caller
identity with `USER_IDENTITY_HMAC_SECRET` (minimum 32 bytes). Send:

```text
X-CLI-Proxy-Tenant-ID
X-CLI-Proxy-User-ID
X-CLI-Proxy-Identity-Timestamp
X-CLI-Proxy-Identity-Signature
```

The timestamp is Unix seconds and must be within five minutes. The signature is
lowercase hex HMAC-SHA256 over:

```text
v1\n<METHOD>\n<PATH>\n<TIMESTAMP>\n<TENANT_ID>\n<USER_ID>
```

`METHOD` is uppercase and `PATH` excludes the query string. Terminate TLS at the
gateway or a trusted reverse proxy; otherwise bearer keys, signed identities,
prompts, and credentials cross the network in clear text.

## First request and lifecycle

For a new `(tenantId, userId)`, the provisioner:

1. derives a shell-safe `cap_<20 hex>` account from a root-held HMAC key;
2. runs `useradd --system --create-home` with `/usr/sbin/nologin` and enforces
   a `0700` HOME;
3. stores only the HMAC fingerprint, UID/GID, account, and HOME in a `0600`
   root-owned mapping file;
4. starts the user's systemd socket;
5. returns the socket path to the gateway.

Concurrent first requests share one in-process provisioning operation. Later
requests verify the persisted account UID/GID before starting its socket. A
connection or provisioning failure returns `503`; it never falls back to the
gateway account or another worker.

`PROVISIONER_MAX_USERS` defaults to 1000 to bound account-creation abuse. Keep
`/etc/cli-openai-proxy/provisioner-identity.key` stable and back it up together
with the mapping database: rotating it changes every derived mapping and would
create new accounts for existing identities.

Workers use `NoNewPrivileges`, a private `/tmp`, a read-only system outside
their HOME, `UMask=0077`, resource limits, and `KillMode=control-group`.
Unix-socket mode `0600` limits connections to the gateway service account.

The worker also owns the user's `/v1/auth/*` sessions and `/v1/usage` data.
Thus CLI login state and usage are per user. `/health` and `/v1/models` remain
gateway-level endpoints.

## Agent provisioning (optional)

Skill/instruction provisioning is off by default and is enabled per worker
unit, not gateway-wide. Uncomment the block already present in
`deploy/linux/cli-openai-proxy-worker@.service`:

| Env | Meaning |
| --- | --- |
| `PROVISION_SYNC` | `1` to enable this worker's own provisioning engine, syncing into its own HOME. See [docs/provisioning.md](provisioning.md#per-user-scope-worker-mode). |
| `PROVISION_ALLOWLIST` | Comma-separated hostnames allowed for the manifest and its artifacts. See [docs/provisioning.md](provisioning.md#enabling-it). |
| `PROVISION_AUTOAPPLY` | `approve` (default) or `auto`. See [docs/provisioning.md](provisioning.md#enabling-it). |

Leave `PROVISION_SYNC` unset on the gateway unit in this mode — see the
anti-footgun note in [docs/provisioning.md](provisioning.md#per-user-scope-worker-mode).

## Multi-OS boundary

Routing depends only on `WorkerProvisioner`, `WorkerTarget`, and `IpcEndpoint`.
Linux supplies the root provisioner and Unix-domain sockets. The IPC client
already represents Windows Named Pipes; a Windows service/account provisioner
can implement the same contract. Unsupported platforms fail with
`platform_unsupported` rather than running locally.

Service management and peer-credential verification remain platform adapters:

- Linux: systemd, Unix socket permissions
- macOS: launchd and `getpeereid()`
- Windows: Windows Service/Task Scheduler and Named Pipe ACLs

Only Linux provisioning is implemented in this release.
