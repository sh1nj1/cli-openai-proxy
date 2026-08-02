#!/usr/bin/env bash
# Container boot bootstrap: run the real installer (idempotent; creates a fresh
# immutable release each boot), then seed gateway.env from an optional
# host-provided file and start the gateway. Bare-metal installs do not use
# this — they run scripts/install-linux-user-workers.sh directly.
set -euo pipefail

SEED="/run/host-config/gateway.env"
GATEWAY_UNIT_DIR="/etc/systemd/system/cli-openai-proxy-gateway.service.d"
CONFIG_OK_FLAG="/run/cli-openai-proxy-config-ok"

# Docker creates /run/host-config as 0755 on the container's writable tmpfs
# (the ro bind mount only applies to the file inside it), so any cap_* worker
# process could otherwise read the host-provided seed file directly and get
# every tenant's API key, bypassing the 0640 root:cli-openai-proxy protection
# applied to the installed copy below. Guarded for set -e: a missing dir
# (e.g. bare-metal reuse of this script) must not abort the boot.
if [[ -d /run/host-config ]]; then
  chmod 0700 /run/host-config
fi

install -d -o root -g root -m 0755 "${GATEWAY_UNIT_DIR}"
# Boot-scoped config gate: /run is a fresh tmpfs every boot, so this flag only
# exists once the seed handling below has decided the config state. Any
# gateway start attempt before that is skipped by the condition. Install this
# drop-in before the shared installer: on a manual rerun, the installer must
# not restart the gateway with the old persisted env before the new seed is
# copied.
cat > "${GATEWAY_UNIT_DIR}/docker-config-gate.conf" <<EOF
[Unit]
ConditionPathExists=${CONFIG_OK_FLAG}
EOF
chmod 0644 "${GATEWAY_UNIT_DIR}/docker-config-gate.conf"

if [[ -f "${SEED}" ]]; then
  rm -f "${CONFIG_OK_FLAG}"
fi
systemctl daemon-reload

/opt/app/scripts/install-linux-user-workers.sh

# The gateway defaults to HOST=127.0.0.1 (deploy/linux/cli-openai-proxy-gateway.service),
# correct for the bare-metal install this unit is shared with. In a container,
# docker's published-port forwarding connects to the container's external
# interface, not its loopback, so a container deployment must bind all
# interfaces; the compose port mapping is the actual access boundary. This
# drop-in is container-only and never touches the shared bare-metal unit.
cat > "${GATEWAY_UNIT_DIR}/docker-bind.conf" <<'EOF'
[Service]
Environment=HOST=0.0.0.0
EOF
chmod 0644 "${GATEWAY_UNIT_DIR}/docker-bind.conf"
systemctl daemon-reload

if [[ -f "${SEED}" && -s "${SEED}" ]]; then
  install -o root -g cli-openai-proxy -m 0640 "${SEED}" /etc/cli-openai-proxy/gateway.env
  touch "${CONFIG_OK_FLAG}"
  # restart, not start: on first boot the gateway is installed but not yet
  # started, and outside boot (manual re-run) it may be running with a stale
  # env — restart covers both. --no-block is required: the gateway is ordered
  # After this oneshot (unit Before=), so a blocking restart issued while this
  # unit is still activating would deadlock waiting for its own caller. At
  # boot the queued gateway job starts it after this unit anyway, always with
  # the seed already in place.
  systemctl restart --no-block cli-openai-proxy-gateway.service
elif [[ -f "${SEED}" ]]; then
  # A present-but-empty seed is an explicit "revoke everything". Drop the
  # persisted copy (the seed is authoritative; the copy is always
  # re-derivable from it) and leave the gate closed so the gateway stays
  # down: with an empty env the gateway disables bearer auth entirely, so
  # refusing to serve is the only safe state.
  rm -f /etc/cli-openai-proxy/gateway.env
  echo "first-boot: seed gateway.env is empty — cleared persisted config, gateway held down this boot" >&2
else
  # No seed mounted (bare-metal-style in-container config management, or the
  # integration test): keep whatever is persisted and open the gate.
  touch "${CONFIG_OK_FLAG}"
fi
