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

Build once, then install the system services:

```bash
npm ci
npm run build
sudo ./scripts/install-linux-user-workers.sh
```

The installer creates:

- low-privilege gateway account `cli-openai-proxy`
- root provisioner socket `/run/cli-openai-proxy/provisioner.sock`
- one socket-activated `cli-openai-proxy-worker@<account>` per user
- persistent homes under `/var/lib/cli-openai-proxy/users`
- root-only HMAC mapping key and mapping database
- a root-owned, non-writable runtime release under `/opt/cli-openai-proxy`

Configure `/etc/cli-openai-proxy/gateway.env`, then start the gateway:

```bash
sudo systemctl start cli-openai-proxy-gateway.service
sudo systemctl status cli-openai-proxy-gateway.service
```

`USER_WORKER_MODE=enabled` is set by the gateway unit. Do not run the ordinary
single-user `install.sh` at the same time; it installs a different systemd user
service.

The installer refuses a Node binary when the binary or any parent in its
resolved path is not root-owned or is writable by group/other. It copies the
validated binary into the immutable release used by every service. Install Node
and the supported CLIs system-wide; dynamically created users cannot execute
binaries hidden in an administrator's HOME. Each new installation creates an
immutable release directory under `/opt`; old release directories may be
removed manually after the new services are healthy.
Re-running the installer stops an active gateway, restarts all active per-user
workers and the provisioner on the new release, then starts the gateway again.
Active CLI requests can be interrupted during this upgrade, so schedule it
during a maintenance window.

## Integration test

`npm run test:integration:linux-workers` builds a systemd-enabled Ubuntu image,
runs the real installer inside it, and asserts the isolation boundaries end to
end: dynamic `cap_*` account creation, worker UID/HOME, socket and state-file
permissions, fail-closed auth, and that a chat completion's CLI process runs as
the caller's dedicated account (via a stub `claude` that reports its own OS
identity). It needs Docker and takes a few minutes; CI runs it on every PR.

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
