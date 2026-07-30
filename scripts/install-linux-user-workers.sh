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
TMPFILES_TARGET="/etc/tmpfiles.d"
CONFIG_DIR="/etc/cli-openai-proxy"
STATE_DIR="/var/lib/cli-openai-proxy"
RUNTIME_BASE="/opt/cli-openai-proxy/releases"
RUNTIME_ROOT="${RUNTIME_BASE}/$(date -u +%Y%m%dT%H%M%SZ)-$$"
RUNTIME_NODE="${RUNTIME_ROOT}/bin/node"

validate_privileged_path() {
  local target="$1"
  local current="/"
  local component mode owner
  local -a components

  if [[ "${target}" != /* ]]; then
    echo "Refusing a non-absolute privileged executable path: ${target}" >&2
    exit 1
  fi
  IFS='/' read -r -a components <<< "${target#/}"
  for component in "${components[@]}"; do
    [[ -n "${component}" ]] || continue
    current="${current%/}/${component}"
    owner="$(stat -Lc '%u' -- "${current}")"
    mode="$(stat -Lc '%a' -- "${current}")"
    if [[ "${owner}" -ne 0 || $((8#${mode} & 8#022)) -ne 0 ]]; then
      echo "Refusing a privileged executable below a non-root-owned or group/world-writable path: ${current}" >&2
      exit 1
    fi
  done
}

if [[ ! -f "${SOURCE_ROOT}/dist/server/worker-standalone.js" ]]; then
  echo "Build first: npm ci && npm run build" >&2
  exit 1
fi
if [[ ! -d "${SOURCE_ROOT}/node_modules" ]]; then
  echo "Dependencies are missing. Run npm ci first." >&2
  exit 1
fi

validate_privileged_path "${NODE_PATH}"

if ! getent group cli-openai-proxy >/dev/null; then
  groupadd --system cli-openai-proxy
fi
if ! id cli-openai-proxy >/dev/null 2>&1; then
  useradd --system --gid cli-openai-proxy --home-dir "${STATE_DIR}/gateway" \
    --create-home --shell /usr/sbin/nologin cli-openai-proxy
fi

install -d -o root -g root -m 0755 "${CONFIG_DIR}"
install -d -o root -g root -m 0755 "${RUNTIME_BASE}"
install -d -o root -g root -m 0755 "${TMPFILES_TARGET}"
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
install -d -o root -g root -m 0755 "${RUNTIME_ROOT}/bin"
install -o root -g root -m 0755 "${NODE_PATH}" "${RUNTIME_NODE}"
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
validate_privileged_path "${RUNTIME_NODE}"

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
    -e "s|@NODE@|${RUNTIME_NODE}|g" \
    -e "s|@APP_ROOT@|${RUNTIME_ROOT}|g" \
    "${UNIT_SOURCE}/${unit}" > "${UNIT_TARGET}/${unit}"
  chmod 0644 "${UNIT_TARGET}/${unit}"
done

install -o root -g root -m 0644 \
  "${UNIT_SOURCE}/cli-openai-proxy-tmpfiles.conf" \
  "${TMPFILES_TARGET}/cli-openai-proxy.conf"
systemd-tmpfiles --create "${TMPFILES_TARGET}/cli-openai-proxy.conf"

systemctl daemon-reload
systemctl enable --now cli-openai-proxy-provisioner.socket
systemctl enable cli-openai-proxy-gateway.service

GATEWAY_WAS_ACTIVE=false
if systemctl is-active --quiet cli-openai-proxy-gateway.service; then
  GATEWAY_WAS_ACTIVE=true
  systemctl stop cli-openai-proxy-gateway.service
fi

# The gateway stays stopped while every loaded worker switches to this release,
# preventing requests from crossing mixed gateway/worker versions.
systemctl list-units \
  --type=service \
  --state=active \
  --no-legend \
  --plain \
  'cli-openai-proxy-worker@*.service' |
  while read -r worker_unit _; do
    if [[ -n "${worker_unit}" ]]; then
      systemctl restart "${worker_unit}"
    fi
  done

if systemctl is-active --quiet cli-openai-proxy-provisioner.service; then
  systemctl restart cli-openai-proxy-provisioner.service
fi
if [[ "${GATEWAY_WAS_ACTIVE}" == true ]]; then
  systemctl start cli-openai-proxy-gateway.service
  GATEWAY_MESSAGE="Restarted the active gateway on the new runtime."
else
  GATEWAY_MESSAGE="Configure ${CONFIG_DIR}/gateway.env, then run: systemctl start cli-openai-proxy-gateway.service"
fi

echo "Installed per-user worker units."
echo "Runtime: ${RUNTIME_ROOT}"
echo "${GATEWAY_MESSAGE}"
