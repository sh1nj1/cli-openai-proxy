#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

SERVICE_NAME="${SERVICE_NAME:-com.claude-code-provider}"
PORT="${INSTALL_PORT:-3456}"
HOST="${INSTALL_HOST:-127.0.0.1}"
MIN_NODE_VERSION="22.13.0"

log() {
  printf '[install] %s\n' "$*"
}

warn() {
  printf '[install] WARNING: %s\n' "$*" >&2
}

die() {
  printf '[install] ERROR: %s\n' "$*" >&2
  exit 1
}

command_path() {
  command -v "$1" 2>/dev/null || true
}

unit_quote() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//%/%%}"
  printf '"%s"' "$value"
}

env_quote() {
  local value="$1"
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] \
    || die "Environment values must not contain newlines"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"' "$value"
}

[[ "$(uname -s)" == "Linux" ]] || die "This installer supports Linux only"
[[ "$EUID" -ne 0 ]] || die "Run this script as the service user, not with sudo"
[[ "$SERVICE_NAME" =~ ^[A-Za-z0-9_.@-]+$ ]] || die "Invalid SERVICE_NAME: $SERVICE_NAME"
[[ "$PORT" =~ ^[0-9]+$ ]] && ((PORT >= 1 && PORT <= 65535)) \
  || die "PORT must be an integer between 1 and 65535"
[[ "$HOST" != *$'\n'* && "$HOST" != *$'\r'* ]] \
  || die "HOST must not contain newlines"

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ENTRYPOINT="$PROJECT_DIR/dist/server/standalone.js"
CONFIG_HOME="$HOME/.config"
ENV_FILE="$CONFIG_HOME/claude-max-api-proxy.env"
SYSTEMD_USER_DIR="$CONFIG_HOME/systemd/user"
SERVICE_FILE="$SYSTEMD_USER_DIR/$SERVICE_NAME.service"
SERVICE_USER="$(id -un)"

[[ -f "$PROJECT_DIR/package.json" ]] || die "package.json not found in $PROJECT_DIR"

NODE_BIN="$(command_path node)"
NPM_BIN="$(command_path npm)"
SYSTEMCTL_BIN="$(command_path systemctl)"
LOGINCTL_BIN="$(command_path loginctl)"
SUDO_BIN="$(command_path sudo)"

[[ -n "$NODE_BIN" ]] || die "Node.js $MIN_NODE_VERSION or newer is required"
[[ -n "$NPM_BIN" ]] || die "npm is required"
[[ -n "$SYSTEMCTL_BIN" ]] || die "systemctl is required (Ubuntu with systemd)"
[[ -n "$LOGINCTL_BIN" ]] || die "loginctl is required (systemd-logind)"

"$NODE_BIN" -e '
  const current = process.versions.node.split(".").map(Number);
  const minimum = process.argv[1].split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (current[i] > minimum[i]) process.exit(0);
    if (current[i] < minimum[i]) process.exit(1);
  }
' "$MIN_NODE_VERSION" \
  || die "Node.js $MIN_NODE_VERSION or newer is required (found $("$NODE_BIN" --version))"

if [[ -z "$(command_path make)" || -z "$(command_path g++)" ]] \
  || [[ -z "$(command_path python3)" && -z "$(command_path python)" ]]; then
  APT_GET_BIN="$(command_path apt-get)"
  [[ -n "$APT_GET_BIN" && -n "$SUDO_BIN" ]] \
    || die "Native build tools are required. On Ubuntu: sudo apt-get install -y build-essential python3"
  log "Installing Ubuntu native build prerequisites"
  "$SUDO_BIN" "$APT_GET_BIN" update
  "$SUDO_BIN" "$APT_GET_BIN" install -y build-essential python3
fi

CLAUDE_BIN="$(command_path claude)"
if [[ -z "$CLAUDE_BIN" ]]; then
  warn "Claude Code CLI was not found; Claude requests will fail until it is installed and authenticated"
  warn "Install it with: npm install -g @anthropic-ai/claude-code"
fi
CODEX_BIN="$(command_path codex)"

log "Installing dependencies"
(cd "$PROJECT_DIR" && "$NPM_BIN" ci)

log "Building production files"
(cd "$PROJECT_DIR" && "$NPM_BIN" run build)
[[ -f "$ENTRYPOINT" ]] || die "Build did not create $ENTRYPOINT"

mkdir -p "$CONFIG_HOME" "$SYSTEMD_USER_DIR"

if [[ ! -f "$ENV_FILE" ]]; then
  ENV_PORT="$(env_quote "$PORT")"
  ENV_HOST="$(env_quote "$HOST")"
  {
    printf 'PORT=%s\n' "$ENV_PORT"
    printf 'HOST=%s\n' "$ENV_HOST"
    if [[ -n "${API_KEYS-}" ]]; then
      ENV_API_KEYS="$(env_quote "$API_KEYS")"
      printf 'API_KEYS=%s\n' "$ENV_API_KEYS"
    else
      printf '# API_KEYS="replace-with-a-long-random-key"\n'
    fi
    if [[ -n "${AUTH_ADMIN_KEYS-}" ]]; then
      ENV_AUTH_ADMIN_KEYS="$(env_quote "$AUTH_ADMIN_KEYS")"
      printf 'AUTH_ADMIN_KEYS=%s\n' "$ENV_AUTH_ADMIN_KEYS"
    else
      printf '# AUTH_ADMIN_KEYS="replace-with-a-separate-admin-key"\n'
    fi
    if [[ -n "${AUTH_TRUST_COMPLETION_CALLERS-}" ]]; then
      ENV_AUTH_TRUST="$(env_quote "$AUTH_TRUST_COMPLETION_CALLERS")"
      printf 'AUTH_TRUST_COMPLETION_CALLERS=%s\n' "$ENV_AUTH_TRUST"
    else
      printf '# AUTH_TRUST_COMPLETION_CALLERS="1"\n'
    fi
  } >"$ENV_FILE"
  chmod 600 "$ENV_FILE"
  log "Created configuration: $ENV_FILE"
else
  chmod 600 "$ENV_FILE"
  log "Keeping existing configuration: $ENV_FILE"
fi

NODE_DIR="$(dirname -- "$NODE_BIN")"
CLAUDE_DIR=""
if [[ -n "$CLAUDE_BIN" ]]; then
  CLAUDE_DIR="$(dirname -- "$CLAUDE_BIN")"
fi
CODEX_DIR=""
if [[ -n "$CODEX_BIN" ]]; then
  CODEX_DIR="$(dirname -- "$CODEX_BIN")"
fi
SERVICE_PATH="$NODE_DIR"
if [[ -n "$CLAUDE_DIR" && "$CLAUDE_DIR" != "$NODE_DIR" ]]; then
  SERVICE_PATH="$SERVICE_PATH:$CLAUDE_DIR"
fi
if [[ -n "$CODEX_DIR" && "$CODEX_DIR" != "$NODE_DIR" && "$CODEX_DIR" != "$CLAUDE_DIR" ]]; then
  SERVICE_PATH="$SERVICE_PATH:$CODEX_DIR"
fi
SERVICE_PATH="$SERVICE_PATH:/usr/local/bin:/usr/bin:/bin"

log "Writing systemd user service: $SERVICE_FILE"
{
  printf '[Unit]\n'
  printf 'Description=CLI OpenAI Proxy\n'
  printf 'Wants=network-online.target\n'
  printf 'After=network-online.target\n'
  printf '\n'
  printf '[Service]\n'
  printf 'Type=simple\n'
  printf 'WorkingDirectory=%s\n' "$(unit_quote "$PROJECT_DIR")"
  printf 'Environment=%s\n' "$(unit_quote "HOME=$HOME")"
  printf 'Environment=%s\n' "$(unit_quote "NODE_ENV=production")"
  printf 'Environment=%s\n' "$(unit_quote "PATH=$SERVICE_PATH")"
  printf 'EnvironmentFile=-%s\n' "$(unit_quote "$ENV_FILE")"
  printf 'ExecStart=%s %s\n' "$(unit_quote "$NODE_BIN")" "$(unit_quote "$ENTRYPOINT")"
  printf 'Restart=on-failure\n'
  printf 'RestartSec=5\n'
  printf 'TimeoutStopSec=30\n'
  printf 'UMask=0077\n'
  printf '\n'
  printf '[Install]\n'
  printf 'WantedBy=default.target\n'
} >"$SERVICE_FILE"

LINGER="$("$LOGINCTL_BIN" show-user "$SERVICE_USER" --property=Linger --value 2>/dev/null || true)"
if [[ "$LINGER" != "yes" ]]; then
  [[ -n "$SUDO_BIN" ]] \
    || die "sudo is required once to enable startup before login: loginctl enable-linger $SERVICE_USER"
  log "Enabling startup before login (sudo may ask for your password)"
  "$SUDO_BIN" "$LOGINCTL_BIN" enable-linger "$SERVICE_USER"
fi

log "Enabling and restarting $SERVICE_NAME"
"$SYSTEMCTL_BIN" --user daemon-reload
"$SYSTEMCTL_BIN" --user enable "$SERVICE_NAME.service"
"$SYSTEMCTL_BIN" --user restart "$SERVICE_NAME.service"
"$SYSTEMCTL_BIN" --user --no-pager --full status "$SERVICE_NAME.service" || {
  warn "The service did not start successfully"
  warn "Inspect logs with: journalctl --user -u $SERVICE_NAME.service -n 100"
  exit 1
}

log "Installation complete"
printf '\n'
printf '  Health:  http://%s:%s/health\n' "$HOST" "$PORT"
printf '  Status:  systemctl --user status %s.service\n' "$SERVICE_NAME"
printf '  Logs:    journalctl --user -u %s.service -f\n' "$SERVICE_NAME"
printf '  Config:  %s\n' "$ENV_FILE"
printf '\n'
printf 'After changing the config, run:\n'
printf '  systemctl --user restart %s.service\n' "$SERVICE_NAME"
