#!/usr/bin/env bash
# Container boot bootstrap: run the real installer (idempotent; creates a fresh
# immutable release each boot), then seed gateway.env from an optional
# host-provided file and start the gateway. Bare-metal installs do not use
# this — they run scripts/install-linux-user-workers.sh directly.
set -euo pipefail

SEED="/run/host-config/gateway.env"
GATEWAY_UNIT_DIR="/etc/systemd/system/cli-openai-proxy-gateway.service.d"

# Docker creates /run/host-config as 0755 on the container's writable tmpfs
# (the ro bind mount only applies to the file inside it), so any cap_* worker
# process could otherwise read the host-provided seed file directly and get
# every tenant's API key, bypassing the 0640 root:cli-openai-proxy protection
# applied to the installed copy below. Guarded for set -e: a missing dir
# (e.g. bare-metal reuse of this script) must not abort the boot.
if [[ -d /run/host-config ]]; then
  chmod 0700 /run/host-config
fi

/opt/app/scripts/install-linux-user-workers.sh

# The gateway defaults to HOST=127.0.0.1 (deploy/linux/cli-openai-proxy-gateway.service),
# correct for the bare-metal install this unit is shared with. In a container,
# docker's published-port forwarding connects to the container's external
# interface, not its loopback, so a container deployment must bind all
# interfaces; the compose port mapping is the actual access boundary. This
# drop-in is container-only and never touches the shared bare-metal unit.
install -d -o root -g root -m 0755 "${GATEWAY_UNIT_DIR}"
cat > "${GATEWAY_UNIT_DIR}/docker-bind.conf" <<'EOF'
[Service]
Environment=HOST=0.0.0.0
EOF
chmod 0644 "${GATEWAY_UNIT_DIR}/docker-bind.conf"
systemctl daemon-reload

if [[ -f "${SEED}" && -s "${SEED}" ]]; then
  install -o root -g cli-openai-proxy -m 0640 "${SEED}" /etc/cli-openai-proxy/gateway.env
  systemctl start cli-openai-proxy-gateway.service
fi
