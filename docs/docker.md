# Docker deployment

The root [`Dockerfile`](../Dockerfile) builds one image used both for the
per-user Linux worker integration test and for production. There is no
separate "test image" — the integration test builds and boots this exact
image and injects its test-only assets at run time (see [Integration test
relationship](#integration-test-relationship) below).

macOS and Windows only get [per-user Linux worker
isolation](linux-user-workers.md) through this image: Docker Desktop on those
platforms runs containers inside a Linux VM, so the systemd-based provisioner
and per-user `useradd` accounts described in `docs/linux-user-workers.md` need
a Linux host regardless of what the developer's machine actually is. Running
the container is the supported way to get that isolation on macOS/Windows;
Linux hosts can use the container too, or install directly with
`scripts/install-linux-user-workers.sh` (see that doc's Install section).

## Quick start

```bash
cd deploy/docker
cp gateway.env.example gateway.env   # edit keys
chmod 600 gateway.env                # keep real keys off other local users' reach
docker compose up -d --build
curl http://127.0.0.1:3456/health
```

If you forget to create `gateway.env` before `docker compose up`, Docker
materializes an empty directory in its place (both at this path and at
`/run/host-config/gateway.env` inside the container), and the gateway stays
down with no seed to install — the failure is silent by design, but if you
expected the gateway to start: `docker compose down`, `rm -rf
deploy/docker/gateway.env` (removing the directory Docker created), create
the real file, then `docker compose up -d` again.

`gateway.env` becomes `/etc/cli-openai-proxy/gateway.env` inside the
container on first boot (see [`gateway.env.example`](../deploy/docker/gateway.env.example)
for the `USER_API_KEYS` shape). `docker compose up -d --build` builds the
image from the repo root and starts the `proxy` service defined in
[`deploy/docker/docker-compose.yml`](../deploy/docker/docker-compose.yml),
publishing port 3456 by default (override with `HOST_PORT`).

## CLI authentication

The real `claude` and `codex` CLIs are installed system-wide at image build
time via the `INSTALL_CLIS` build arg. The compose file defaults it to both:

```yaml
args:
  INSTALL_CLIS: "${INSTALL_CLIS-@anthropic-ai/claude-code @openai/codex}"
```

Override it (e.g. `INSTALL_CLIS="@anthropic-ai/claude-code" docker compose up
-d --build`) to install only one, or set it to an empty string, as the
integration test and smoke test do, to skip installing real CLIs entirely.

Per-user CLI credentials are not baked into the image. Each dynamically
provisioned `cap_*` account gets its own HOME under the `state` volume
(`/var/lib/cli-openai-proxy/users` inside the container), and the normal
remote auth-provisioning flow writes each user's credential into their own
HOME exactly as it would on a bare-metal install. See
[docs/cli-auth-provisioning.md](cli-auth-provisioning.md) for that flow, and
[docs/linux-user-workers.md](linux-user-workers.md) for how a `(tenantId,
userId)` maps to a `cap_*` account.

## Privileges and networking

The container must run `--privileged` with `cgroup: host`, because systemd is
PID 1 inside it (`CMD ["/lib/systemd/systemd"]` in the Dockerfile) and needs a
writable cgroup tree plus its own `/run` tmpfs to manage the gateway,
provisioner, and per-user worker units. Do not expose the host's Docker
socket to the container — that would hand a root-equivalent container
control-plane access, on top of the privileges systemd already needs.
De-privileging this (e.g. running systemd under a more restricted profile) is
future work, not done in this release.

**Container network binding.** The gateway process defaults to
`HOST=127.0.0.1` when nothing overrides it, and the shared systemd unit
(`deploy/linux/cli-openai-proxy-gateway.service`) does not set `HOST`, so a
bare-metal install binds loopback-only — correct there, but unreachable
through Docker's published-port forwarding, since the port mapping connects
to the container's external interface, not its loopback. To fix this without
touching the shared unit, `deploy/docker/first-boot-install.sh` writes a
container-only systemd drop-in,
`/etc/systemd/system/cli-openai-proxy-gateway.service.d/docker-bind.conf`,
setting `HOST=0.0.0.0` for the gateway before it starts. Bare-metal installs
never run this script, so they are unaffected.

## Lifecycle rules

**Upgrade:** an image rebuild always recreates the container on the next `up
-d` — a running container is bound to the specific image it was created
from, so `docker compose up -d --build` (or `build` then `up -d`) sees a new
image ID and prints `Recreate`/`Recreated` even when no other compose-relevant
config (env vars, volumes, ports, etc.) changed. There is no way to upgrade
the app version in place while keeping the old container's writable layer.
Because the `cap_*` accounts described below live only in that writable
layer, **routine version upgrades trigger the same account-loss limitation as
any other recreation.**

**Recreation breaks provisioned accounts.** The `cap_*` Linux accounts that
per-user workers depend on live only in the container's writable layer —
`/etc/passwd`, `/etc/shadow`, and their `useradd`-created UID/GID mappings.
The `state` volume persists each account's HOME and the root-only mapping
database (UID, GID, account name, HMAC fingerprint) across container
recreation, but the OS-level account itself does not: a fresh container has a
fresh `/etc/passwd` with no `cap_*` entries. On the next request for an
already-provisioned (`ready`) identity, the provisioner does not re-run
`useradd` — that only happens for a still-`creating` record. Instead it goes
straight to re-verifying the existing account's UID/GID via `id -u`/`id -g`
(`src/isolation/linux-user-provisioner.ts:145-146`), and since the account
does not exist in the fresh container's `/etc/passwd`, that `id` lookup
itself fails, throwing before the UID/GID comparison on line 147 is ever
reached. Restarting with `docker compose stop` / `docker compose start`
keeps the same container and its writable layer, so this does not happen —
only recreation does.

**v1 rule:** since an upgrade always recreates the container, there is no
safe in-place upgrade path in this release. The correct v1 upgrade procedure
is:

```bash
docker compose down -v
docker compose up -d --build
```

`down -v` drops the `state` and `config` volumes so the fresh container
starts clean instead of hitting the UID/GID mismatch hard-fail described
above. This loses every provisioned user (accounts must re-provision from
scratch on next request) and every CLI credential stored in those users'
HOMEs (each user must re-run CLI auth) — there is no partial recovery.

`docker compose stop` / `docker compose start` remain the safe way to
restart the *same* image and config (e.g. a host reboot): they keep the same
container and its writable layer, so no accounts are lost. Never run `up -d`
after a config change or image rebuild if you want to keep provisioned
accounts — it recreates the container and hits the same hard-fail as an
upgrade.

Re-creating `cap_*` accounts with their previously recorded UID/GID (e.g. via
`useradd -u`) instead of requiring a fresh mapping is known follow-up work
that would make in-place upgrades possible; not implemented in this release.

**Release accumulation.** `first-boot-install.sh` runs the installer on every
container boot, and the installer creates a fresh immutable release under
`/opt/cli-openai-proxy/releases` each time — on bare metal this is pruned
over time, but inside a container nobody prunes it, so a container that gets
restarted or recreated frequently will accumulate releases in the writable
layer. Manual cleanup only for now; automatic pruning in a container context
is unimplemented.

## Integration test relationship

`npm run test:integration:linux-workers` (`tools/linux-worker-integration/run.sh`)
builds this exact image from the root `Dockerfile` and boots it the same way
production does (`--privileged`, host cgroupns, `/sys/fs/cgroup` bind mount).
It asserts the image ships no CLI binary and no devDependencies, then stages
the test-only stub `claude` CLI and the in-container assertion script by
`docker cp`-ing them to `/root/` and `install`-ing them from there into
`/usr/local/bin` — staging under `/root` rather than `/tmp` avoids a race with
systemd's boot-time `/tmp` clear (`systemd-tmpfiles-setup.service`). Nothing
test-specific is ever baked into the image itself; it needs Docker and runs in
CI on every PR.

## Smoke test

```bash
bash deploy/docker/smoke-test.sh
```

This boots the real compose stack (`deploy/docker/docker-compose.yml`) on a
throwaway port (3457) and throwaway volumes, without real CLIs
(`INSTALL_CLIS=""`), and asserts the `/health` endpoint comes up and the
auth boundary works (`401` unauthenticated, `200` with a bearer key). It
tears the stack down (`down -v`) on exit, so it never leaves state behind.

The smoke test and the production compose file both build the same image tag,
`cli-openai-proxy:local` — running the smoke test rebuilds and overwrites that
tag (a running production container keeps running on the image it already
started with, but the tag itself moves, so a subsequent recreate would pick up
the smoke-test build rather than whatever you built last for production).
