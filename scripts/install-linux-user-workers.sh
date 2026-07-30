#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This installer supports Linux only." >&2
  exit 1
fi
if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo $0" >&2
  exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
NODE_PATH="$(readlink -f "$(command -v node)")"
UNIT_SOURCE="${SOURCE_ROOT}/deploy/linux"
UNIT_TARGET="/etc/systemd/system"
CONFIG_DIR="/etc/cli-openai-proxy"
STATE_DIR="/var/lib/cli-openai-proxy"
RUNTIME_BASE="/opt/cli-openai-proxy/releases"
RUNTIME_ROOT="${RUNTIME_BASE}/$(date -u +%Y%m%dT%H%M%SZ)-$$"

if [[ ! -f "${SOURCE_ROOT}/dist/server/worker-standalone.js" ]]; then
  echo "Build first: npm ci && npm run build" >&2
  exit 1
fi
if [[ ! -d "${SOURCE_ROOT}/node_modules" ]]; then
  echo "Dependencies are missing. Run npm ci first." >&2
  exit 1
fi

NODE_MODE="$(stat -Lc '%a' "${NODE_PATH}")"
if [[ "$(stat -Lc '%u' "${NODE_PATH}")" -ne 0 || $((8#${NODE_MODE} & 8#022)) -ne 0 ]]; then
  echo "Refusing a root service with a non-root-owned or group/world-writable Node binary: ${NODE_PATH}" >&2
  exit 1
fi

if ! getent group cli-openai-proxy >/dev/null; then
  groupadd --system cli-openai-proxy
fi
if ! id cli-openai-proxy >/dev/null 2>&1; then
  useradd --system --gid cli-openai-proxy --home-dir "${STATE_DIR}/gateway" \
    --create-home --shell /usr/sbin/nologin cli-openai-proxy
fi

install -d -o root -g root -m 0755 "${CONFIG_DIR}"
install -d -o root -g root -m 0755 "${RUNTIME_BASE}"
install -d -o root -g root -m 0700 "${STATE_DIR}/provisioner"
install -d -o root -g root -m 0755 "${STATE_DIR}/users"
install -d -o cli-openai-proxy -g cli-openai-proxy -m 0700 "${STATE_DIR}/gateway"

if [[ ! -f "${CONFIG_DIR}/provisioner-identity.key" ]]; then
  umask 077
  head -c 32 /dev/urandom | base64 > "${CONFIG_DIR}/provisioner-identity.key"
fi
chown root:root "${CONFIG_DIR}/provisioner-identity.key"
chmod 0600 "${CONFIG_DIR}/provisioner-identity.key"

install -d -o root -g root -m 0755 "${RUNTIME_ROOT}"
cp -a \
  "${SOURCE_ROOT}/dist" \
  "${SOURCE_ROOT}/node_modules" \
  "${SOURCE_ROOT}/package.json" \
  "${RUNTIME_ROOT}/"
while IFS= read -r -d '' link; do
  target="$(readlink -f "${link}")"
  if [[ "${target}" != "${RUNTIME_ROOT}/"* ]]; then
    echo "Refusing runtime symlink outside the immutable release: ${link} -> ${target}" >&2
    exit 1
  fi
done < <(find "${RUNTIME_ROOT}" -type l -print0)
chown -R root:root "${RUNTIME_ROOT}"
chmod -R go-w "${RUNTIME_ROOT}"

if [[ ! -f "${CONFIG_DIR}/gateway.env" ]]; then
  install -o root -g cli-openai-proxy -m 0640 /dev/null "${CONFIG_DIR}/gateway.env"
fi

for unit in \
  cli-openai-proxy-provisioner.service \
  cli-openai-proxy-provisioner.socket \
  cli-openai-proxy-worker@.service \
  cli-openai-proxy-worker@.socket \
  cli-openai-proxy-gateway.service
do
  sed \
    -e "s|@NODE@|${NODE_PATH}|g" \
    -e "s|@APP_ROOT@|${RUNTIME_ROOT}|g" \
    "${UNIT_SOURCE}/${unit}" > "${UNIT_TARGET}/${unit}"
  chmod 0644 "${UNIT_TARGET}/${unit}"
done

systemctl daemon-reload
systemctl enable --now cli-openai-proxy-provisioner.socket
systemctl enable cli-openai-proxy-gateway.service

echo "Installed per-user worker units."
echo "Runtime: ${RUNTIME_ROOT}"
echo "Configure ${CONFIG_DIR}/gateway.env, then run:"
echo "  systemctl start cli-openai-proxy-gateway.service"
