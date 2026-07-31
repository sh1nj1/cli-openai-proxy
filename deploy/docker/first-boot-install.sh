#!/usr/bin/env bash
# Container boot bootstrap: run the real installer (idempotent; creates a fresh
# immutable release each boot), then seed gateway.env from an optional
# host-provided file and start the gateway. Bare-metal installs do not use
# this — they run scripts/install-linux-user-workers.sh directly.
set -euo pipefail

SEED="/run/host-config/gateway.env"

/opt/app/scripts/install-linux-user-workers.sh

if [[ -s "${SEED}" ]]; then
  install -o root -g cli-openai-proxy -m 0640 "${SEED}" /etc/cli-openai-proxy/gateway.env
  systemctl start cli-openai-proxy-gateway.service
fi
