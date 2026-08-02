#!/usr/bin/env bash
# Compose smoke test: boots the real production stack with throwaway volumes
# on port 3457 (3456 is the host launchctl service), waits for /health, and
# asserts the auth boundary plus one authenticated provisioning round-trip.
# Skips real CLIs (INSTALL_CLIS="") — chat completions are covered by
# tools/linux-worker-integration; this proves the compose wiring.
set -euo pipefail

DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT="cli-openai-proxy-smoke-$$"
KEY="smoke-key-0123456789abcdef01234567"
BASE_URL="http://127.0.0.1:3457"
# Force /tmp: Docker Desktop on macOS does not share the default $TMPDIR
# (/var/folders/...), which would silently break the bind mount.
ENV_FILE="$(mktemp /tmp/cli-openai-proxy-smoke.XXXXXX)"
printf 'USER_API_KEYS=%s\n' \
  "'[{\"key\":\"${KEY}\",\"tenantId\":\"smoke\",\"userId\":\"user-a\"}]'" > "${ENV_FILE}"

compose() {
  HOST_PORT=3457 GATEWAY_ENV_FILE="${ENV_FILE}" INSTALL_CLIS="" \
    docker compose -p "${PROJECT}" -f "${DIR}/docker-compose.yml" "$@"
}

cleanup() { compose down -v --timeout 20 >/dev/null 2>&1 || true; rm -f "${ENV_FILE}" "${ENV_FILE}.next"; }
trap cleanup EXIT

compose up -d --build

echo "==> waiting for /health"
timeout 180 bash -c \
  "until curl -fsS ${BASE_URL}/health >/dev/null 2>&1; do sleep 2; done" \
  || { compose logs; echo "FAIL: gateway never became healthy" >&2; exit 1; }

expect() {
  local want="$1"; shift
  local got
  # `|| true`: a refused connection makes curl exit non-zero after printing
  # 000, and the revocation steps below assert exactly that.
  got="$(curl -s -o /dev/null -w '%{http_code}' "$@" || true)"
  [[ "${got}" == "${want}" ]] \
    || { compose logs; echo "FAIL: expected HTTP ${want}, got ${got} for: $*" >&2; exit 1; }
}

# systemd unit state inside the container, whitespace-trimmed.
unit_state() {
  compose exec -T proxy systemctl is-active "$1" 2>/dev/null | tr -d '[:space:]' || true
}

expect 401 "${BASE_URL}/v1/usage"
expect 200 -H "Authorization: Bearer ${KEY}" "${BASE_URL}/v1/usage"

# Key rotation across a restart: the gateway is ordered after the first-boot
# oneshot, so the rotated seed must be live before the gateway ever answers —
# the old key may never be accepted again, even transiently.
# Rotate via write-temp + rename (a NEW inode, like editor/atomic saves), not
# in-place truncation: the single-file bind mount pins the old inode while the
# container runs, and this asserts stop/start re-resolves the source path.
echo "==> rotating key and restarting"
ROTATED_KEY="smoke-key-rotated-89abcdef0123456789abcdef"
printf 'USER_API_KEYS=%s\n' \
  "'[{\"key\":\"${ROTATED_KEY}\",\"tenantId\":\"smoke\",\"userId\":\"user-a\"}]'" \
  > "${ENV_FILE}.next"
mv "${ENV_FILE}.next" "${ENV_FILE}"
compose restart --timeout 30

echo "==> waiting for /health after restart"
timeout 180 bash -c \
  "until curl -fsS ${BASE_URL}/health >/dev/null 2>&1; do sleep 2; done" \
  || { compose logs; echo "FAIL: gateway never became healthy after restart" >&2; exit 1; }

expect 401 -H "Authorization: Bearer ${KEY}" "${BASE_URL}/v1/usage"
expect 200 -H "Authorization: Bearer ${ROTATED_KEY}" "${BASE_URL}/v1/usage"

# Revoke-everything: an emptied seed must clear the persisted env and hold the
# gateway down for the whole boot — with an empty env the gateway would
# disable bearer auth entirely, so serving anything would fail open. Truncate
# in place, exactly what an operator does to the bind-mounted file.
echo "==> emptying seed (revoke all keys) and restarting"
: > "${ENV_FILE}"
compose restart --timeout 30

echo "==> waiting for first-boot after revocation restart"
deadline=$((SECONDS + 180))
until [[ "$(unit_state cli-openai-proxy-first-boot.service)" == "active" ]]; do
  (( SECONDS < deadline )) \
    || { compose logs; echo "FAIL: first-boot did not complete after revocation restart" >&2; exit 1; }
  sleep 2
done

[[ "$(unit_state cli-openai-proxy-gateway.service)" != "active" ]] \
  || { compose logs; echo "FAIL: gateway is serving after all keys were revoked" >&2; exit 1; }
compose exec -T proxy test ! -e /etc/cli-openai-proxy/gateway.env \
  || { compose logs; echo "FAIL: persisted gateway.env survived an empty seed" >&2; exit 1; }
expect 000 "${BASE_URL}/health"
expect 000 -H "Authorization: Bearer ${ROTATED_KEY}" "${BASE_URL}/v1/usage"

# Recovery: repopulating the seed brings the gateway back on the next boot.
echo "==> restoring seed and restarting"
printf 'USER_API_KEYS=%s\n' \
  "'[{\"key\":\"${ROTATED_KEY}\",\"tenantId\":\"smoke\",\"userId\":\"user-a\"}]'" \
  > "${ENV_FILE}.next"
mv "${ENV_FILE}.next" "${ENV_FILE}"
compose restart --timeout 30

echo "==> waiting for /health after restore"
timeout 180 bash -c \
  "until curl -fsS ${BASE_URL}/health >/dev/null 2>&1; do sleep 2; done" \
  || { compose logs; echo "FAIL: gateway never became healthy after restore" >&2; exit 1; }
expect 200 -H "Authorization: Bearer ${ROTATED_KEY}" "${BASE_URL}/v1/usage"

echo "PASS: compose smoke test"
