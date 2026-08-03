#!/usr/bin/env bash
# Runs inside the systemd container as root. Installs the per-user worker
# services with the real installer, then asserts the gateway/provisioner/worker
# privilege boundaries end to end. Any failed assertion aborts the script.
set -euo pipefail

BASE_URL="http://127.0.0.1:3456"
KEY_A="itest-key-user-a-0123456789abcdef"
KEY_B="itest-key-user-b-0123456789abcdef"
KEY_UNMAPPED="itest-key-unmapped-0123456789abcd"
ADMIN_KEY="itest-admin-0123456789abcdef01234567"
USERS_DIR="/var/lib/cli-openai-proxy/users"
SOCKET_DIR="/run/cli-openai-proxy/workers"

step() { echo; echo "==> $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

dump_logs() {
  echo "---- journal (last 120 lines per unit) ----" >&2
  for unit in cli-openai-proxy-first-boot cli-openai-proxy-gateway \
      cli-openai-proxy-provisioner 'cli-openai-proxy-worker@*'; do
    journalctl -u "${unit}" --no-pager -n 120 >&2 || true
  done
}
trap dump_logs ERR

# curl_code <expected-status> <curl args...> — body goes to $BODY
curl_expect() {
  local expected="$1"; shift
  local status
  BODY="$(mktemp)"
  status="$(curl -sS -o "${BODY}" -w '%{http_code}' "$@")" \
    || fail "curl $* did not complete"
  [[ "${status}" == "${expected}" ]] \
    || fail "expected HTTP ${expected}, got ${status} for: $* — body: $(cat "${BODY}")"
}

unit_user() {
  local pid
  pid="$(systemctl show -p MainPID --value "$1")"
  [[ -n "${pid}" && "${pid}" != 0 ]] || fail "$1 has no main PID"
  ps -o user= -p "${pid}" | tr -d ' '
}

cap_accounts() { getent passwd | awk -F: '/^cap_/ {print $1}' | sort; }

step "Waiting for systemd to finish booting"
timeout 90 bash -c \
  'until state="$(systemctl is-system-running 2>/dev/null)"; [[ "$state" == running || "$state" == degraded ]]; do sleep 1; done' \
  || fail "systemd never reached running/degraded: $(systemctl is-system-running || true)"

step "Waiting for the first-boot installer"
timeout 120 bash -c \
  'until systemctl is-active --quiet cli-openai-proxy-first-boot.service; do
     systemctl is-failed --quiet cli-openai-proxy-first-boot.service && exit 2
     sleep 1
   done' || fail "first-boot installer did not complete"

step "Production image ships no devDependencies"
[[ ! -e /opt/app/node_modules/typescript ]] \
  || fail "devDependencies leaked into the runtime image"

step "Production image supports git-backed provisioning"
command -v git >/dev/null \
  || fail "git is missing from the production runtime image"
git --version >/dev/null \
  || fail "git in the production runtime image is not executable"

step "Installer never reuses a preexisting build account"
groupadd --system cli-openai-proxy-build
useradd --system --gid cli-openai-proxy-build --home-dir /home/build \
  --no-create-home --shell /bin/bash --password '$6$login-capable' \
  cli-openai-proxy-build
selected_build_account="$(bash -c '
  source /opt/app/scripts/install-linux-user-workers.sh
  ensure_build_account
  printf "%s\n" "$BUILD_ACCOUNT"
  retire_build_account
')"
[[ "${selected_build_account}" == cli-openai-proxy-bld-* ]] \
  || fail "installer did not select an invocation-scoped build account"
[[ "${selected_build_account}" != cli-openai-proxy-build ]] \
  || fail "installer reused the preexisting build account"
getent passwd cli-openai-proxy-build | grep -q ':/home/build:/bin/bash$' \
  || fail "installer modified the unrelated preexisting account"
getent passwd "${selected_build_account}" >/dev/null \
  && fail "transient build account survived retirement"
userdel cli-openai-proxy-build
if getent group cli-openai-proxy-build >/dev/null; then
  groupdel cli-openai-proxy-build
fi

step "Immutable release includes the auth UI runtime asset"
release_root="$(sed -n \
  's|^ExecStart=[^ ]* \([^ ]*\)/dist/server/standalone\.js$|\1|p' \
  /etc/systemd/system/cli-openai-proxy-gateway.service)"
[[ -n "${release_root}" ]] || fail "could not resolve immutable release from gateway unit"
[[ -f "${release_root}/tools/auth-test.html" ]] \
  || fail "auth UI asset is missing from immutable release: ${release_root}"

step "First install generated separate user and administrator keys"
mapfile -t generated_config < <(node --input-type=commonjs - <<'NODE'
const { readFileSync } = require("node:fs");
const lines = readFileSync("/etc/cli-openai-proxy/gateway.env", "utf8").split(/\r?\n/);
const read = (name) => {
  const line = lines.find((candidate) => candidate.startsWith(`${name}=`));
  if (!line) process.exit(2);
  let value = line.slice(name.length + 1).trim();
  if ((value.startsWith("'") && value.endsWith("'"))
      || (value.startsWith('"') && value.endsWith('"'))) value = value.slice(1, -1);
  return value;
};
const mappings = JSON.parse(read("USER_API_KEYS"));
if (!Array.isArray(mappings) || mappings.length !== 1) process.exit(3);
console.log(mappings[0].key);
console.log(read("AUTH_ADMIN_KEYS"));
console.log(`${mappings[0].tenantId}/${mappings[0].userId}`);
NODE
)
[[ "${generated_config[0]}" == cop_user_* && "${generated_config[1]}" == cop_admin_* ]] \
  || fail "installer did not generate both key classes"
[[ "${generated_config[0]}" != "${generated_config[1]}" ]] \
  || fail "user and administrator keys must differ"
[[ "${generated_config[2]}" == "default/default" ]] \
  || fail "installer did not create the default tenant/user mapping"

step "Reinstall probes the preserved nondefault gateway listener"
sed -i 's/^HOST=.*/HOST=127.0.0.1/' /etc/cli-openai-proxy/gateway.env
sed -i 's/^PORT=.*/PORT=3457/' /etc/cli-openai-proxy/gateway.env
rm -f /etc/systemd/system/cli-openai-proxy-gateway.service.d/docker-bind.conf
# An older install may have left this parent private; repair must still run
# when the installer selects the trusted system Node.js runtime.
chmod 0700 /opt/cli-openai-proxy
INSTALL_USE_PREBUILT=1 \
INSTALL_PRINT_KEYS=0 \
INSTALL_READINESS_TIMEOUT=30 \
  /opt/app/scripts/install-linux-user-workers.sh
[[ "$(stat -c '%U %a' /opt/cli-openai-proxy)" == "root 755" ]] \
  || fail "reinstall did not repair the managed runtime parent"
curl_expect 200 "http://127.0.0.1:3457/health"

step "Configuring per-user API keys and starting the gateway"
cat > /etc/cli-openai-proxy/gateway.env <<EOF
USER_API_KEYS='[{"key":"${KEY_A}","tenantId":"itest","userId":"user-a"},{"key":"${KEY_B}","tenantId":"itest","userId":"user-b"}]'
AUTH_ADMIN_KEYS=${ADMIN_KEY}
EOF
chown root:cli-openai-proxy /etc/cli-openai-proxy/gateway.env
chmod 0640 /etc/cli-openai-proxy/gateway.env
systemctl restart cli-openai-proxy-gateway.service

timeout 30 bash -c \
  "until curl -fsS ${BASE_URL}/health >/dev/null 2>&1; do
     systemctl is-failed --quiet cli-openai-proxy-gateway.service && exit 2
     sleep 1
   done" || fail "gateway never became healthy"

step "Gateway runs as the low-privilege service account"
gw_user="$(unit_user cli-openai-proxy-gateway.service)"
[[ "${gw_user}" == "cli-openai-proxy" ]] \
  || fail "gateway runs as ${gw_user}, expected cli-openai-proxy"

step "Auth boundary: /health open, everything else fails closed"
curl_expect 200 "${BASE_URL}/health"
curl_expect 200 "${BASE_URL}/auth"
curl_expect 401 "${BASE_URL}/v1/usage"
curl_expect 401 -H "Authorization: Bearer ${KEY_UNMAPPED}" "${BASE_URL}/v1/usage"
[[ -z "$(cap_accounts)" ]] || fail "cap_ account exists before any authenticated request"

step "First request for user A provisions a dedicated account and worker"
curl_expect 200 -H "Authorization: Bearer ${KEY_A}" "${BASE_URL}/v1/usage"
grep -q '"totalRequests"' "${BODY}" || fail "usage response missing summary: $(cat "${BODY}")"
accounts_after_a="$(cap_accounts)"
[[ "$(wc -l <<< "${accounts_after_a}")" == 1 && -n "${accounts_after_a}" ]] \
  || fail "expected exactly one cap_ account, got: ${accounts_after_a}"
CAP_A="${accounts_after_a}"
echo "    user A -> ${CAP_A}"

worker_a="cli-openai-proxy-worker@${CAP_A}.service"
systemctl is-active --quiet "${worker_a}" || fail "${worker_a} is not active"
worker_a_user="$(unit_user "${worker_a}")"
# ps truncates long names; compare the truncated prefix.
[[ "${CAP_A}" == "${worker_a_user}"* ]] \
  || fail "worker A runs as ${worker_a_user}, expected ${CAP_A}"

home_a="${USERS_DIR}/${CAP_A}"
[[ "$(stat -c '%U %a' "${home_a}")" == "${CAP_A} 700" ]] \
  || fail "user A HOME has wrong owner/mode: $(stat -c '%U %a' "${home_a}")"
[[ "$(stat -c '%U %a' "${SOCKET_DIR}/${CAP_A}.sock")" == "cli-openai-proxy 600" ]] \
  || fail "worker A socket has wrong owner/mode: $(stat -c '%U %a' "${SOCKET_DIR}/${CAP_A}.sock")"

step "Auth UI requests require and accept the mapped user identity"
curl_expect 401 -H "Authorization: Bearer ${ADMIN_KEY}" "${BASE_URL}/v1/auth/engines"
curl_expect 200 -H "Authorization: Bearer ${ADMIN_KEY}" \
  -H "X-CLI-Proxy-User-Key: ${KEY_A}" "${BASE_URL}/v1/auth/engines"
grep -q '"object":"list"' "${BODY}" || fail "auth engine response is invalid: $(cat "${BODY}")"

step "User B gets a different account; user A's mapping is stable"
curl_expect 200 -H "Authorization: Bearer ${KEY_B}" "${BASE_URL}/v1/usage"
CAP_B="$(comm -13 <(echo "${accounts_after_a}") <(cap_accounts))"
[[ -n "${CAP_B}" && "${CAP_B}" != "${CAP_A}" ]] || fail "user B did not get a new account"
echo "    user B -> ${CAP_B}"

curl_expect 200 -H "Authorization: Bearer ${KEY_A}" "${BASE_URL}/v1/usage"
[[ "$(cap_accounts | wc -l)" == 2 ]] \
  || fail "repeat request for user A changed the account set: $(cap_accounts)"

step "Chat completion runs the CLI inside user A's account"
curl_expect 200 -H "Authorization: Bearer ${KEY_A}" -H "Content-Type: application/json" \
  -d '{"model":"paperclip/claude_local","messages":[{"role":"user","content":"who am i"}]}' \
  "${BASE_URL}/v1/chat/completions"
grep -q "FAKE_CLI_OK user=${CAP_A} " "${BODY}" \
  || fail "completion did not run as ${CAP_A}: $(cat "${BODY}")"
[[ "$(stat -c '%U' "${home_a}/fake-claude-ran.txt")" == "${CAP_A}" ]] \
  || fail "CLI marker file not owned by ${CAP_A}"

step "Body user field is session data, never an identity"
curl_expect 200 -H "Authorization: Bearer ${KEY_B}" -H "Content-Type: application/json" \
  -d '{"model":"paperclip/claude_local","user":"root","messages":[{"role":"user","content":"who am i"}]}' \
  "${BASE_URL}/v1/chat/completions"
grep -q "FAKE_CLI_OK user=${CAP_B} " "${BODY}" \
  || fail "completion with spoofed body user did not stay in ${CAP_B}: $(cat "${BODY}")"
[[ "$(cap_accounts | wc -l)" == 2 ]] \
  || fail "spoofed body user provisioned an extra account: $(cap_accounts)"

step "Provisioner state stays root-only"
[[ "$(stat -c '%U %a' /var/lib/cli-openai-proxy/provisioner/users.json)" == "root 600" ]] \
  || fail "mapping database has wrong owner/mode"
[[ "$(stat -c '%U %a' /etc/cli-openai-proxy/provisioner-identity.key)" == "root 600" ]] \
  || fail "identity key has wrong owner/mode"

echo
echo "PASS: all per-user worker isolation checks succeeded"
