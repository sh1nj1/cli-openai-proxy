#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

SERVICE_NAME="${SERVICE_NAME:-com.claude-code-provider}"
PORT="${INSTALL_PORT:-3456}"
HOST="${INSTALL_HOST:-127.0.0.1}"
MIN_NODE_VERSION="22.13.0"
READINESS_TIMEOUT="${INSTALL_READINESS_TIMEOUT:-30}"

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

trusted_command_path() {
  local name="$1"
  local candidate

  for candidate in "/usr/bin/$name" "/usr/sbin/$name" "/bin/$name" "/sbin/$name"; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return
    fi
  done
  return 0
}

unit_quote() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  value="${value//$'\t'/\\t}"
  value="${value//%/%%}"
  printf '"%s"' "$value"
}

unit_scalar_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  value="${value//$'\t'/\\t}"
  value="${value// /\\x20}"
  value="${value//\"/\\x22}"
  value="${value//\'/\\x27}"
  value="${value//%/%%}"
  printf '%s' "$value"
}

env_quote() {
  local value="$1"
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] \
    || die "Environment values must not contain newlines"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"' "$value"
}

path_metadata_is_trusted() {
  local path="$1"
  local expected_type="$2"
  local metadata
  local owner
  local mode

  if [[ "$expected_type" == "directory" ]]; then
    [[ -d "$path" ]] || return 1
  else
    [[ -f "$path" ]] || return 1
  fi
  metadata="$(LC_ALL=C "$STAT_BIN" --dereference --format='%u %a' -- "$path" 2>/dev/null)" \
    || return 1
  read -r owner mode <<<"$metadata"
  [[ "$owner" == "0" || "$owner" == "$EUID" ]] || return 1
  [[ "$mode" =~ ^[0-7]+$ ]] || return 1
  (( (8#$mode & 8#022) == 0 ))
}

trusted_existing_directory_ancestors() {
  local current="$1"
  local parent

  while true; do
    [[ ! -L "$current" || -e "$current" ]] || return 1
    if [[ -e "$current" ]] && ! path_metadata_is_trusted "$current" directory; then
      return 1
    fi
    parent="$(dirname -- "$current")"
    [[ "$parent" != "$current" ]] || return 0
    current="$parent"
  done
}

service_path_is_trusted() {
  local candidate="$1"
  local existing
  local parent
  local resolved

  [[ "$candidate" == /* ]] || return 1
  trusted_existing_directory_ancestors "$candidate" || return 1

  existing="$candidate"
  while [[ ! -e "$existing" ]]; do
    [[ ! -L "$existing" ]] || return 1
    parent="$(dirname -- "$existing")"
    [[ "$parent" != "$existing" ]] || return 1
    existing="$parent"
  done
  resolved="$("$REALPATH_BIN" --canonicalize-existing -- "$existing" 2>/dev/null)" \
    || return 1
  trusted_existing_directory_ancestors "$resolved"
}

service_executable_is_trusted() {
  local executable="$1"
  local resolved

  [[ "$executable" == /* && -f "$executable" && -x "$executable" ]] || return 1
  service_path_is_trusted "$(dirname -- "$executable")" || return 1
  resolved="$("$REALPATH_BIN" --canonicalize-existing -- "$executable" 2>/dev/null)" \
    || return 1
  [[ -x "$resolved" ]] || return 1
  service_path_is_trusted "$(dirname -- "$resolved")" || return 1
  path_metadata_is_trusted "$resolved" file
}

service_file_is_trusted() {
  local file="$1"
  local resolved

  [[ "$file" == /* && -f "$file" ]] || return 1
  service_path_is_trusted "$(dirname -- "$file")" || return 1
  resolved="$("$REALPATH_BIN" --canonicalize-existing -- "$file" 2>/dev/null)" \
    || return 1
  service_path_is_trusted "$(dirname -- "$resolved")" || return 1
  path_metadata_is_trusted "$resolved" file
}

prepare_trusted_directory() {
  local directory="$1"
  local description="$2"

  [[ "$directory" == /* ]] \
    || die "$description must be an absolute path: $directory"
  service_path_is_trusted "$directory" \
    || die "Refusing $description with untrusted ownership or permissions: $directory"
  mkdir -p -- "$directory"
  service_path_is_trusted "$directory" \
    || die "Failed to create a trusted $description: $directory"
}

append_service_path() {
  local directory="$1"

  [[ "$directory" == /* ]] || return 0
  [[ "$directory" != *:* && "$directory" != *$'\n'* && "$directory" != *$'\r'* ]] || return 0
  [[ ":$SERVICE_PATH:" != *":$directory:"* ]] || return 0
  if ! service_path_is_trusted "$directory"; then
    warn "Skipping service PATH directory writable by another user: $directory"
    return 0
  fi
  if [[ -n "$SERVICE_PATH" ]]; then
    SERVICE_PATH="$SERVICE_PATH:$directory"
  else
    SERVICE_PATH="$directory"
  fi
}

health_check() {
  "$NODE_BIN" -e '
    const http = require("node:http");
    const request = http.get({
      hostname: process.argv[1],
      port: Number(process.argv[2]),
      path: "/health",
      timeout: 1000,
    }, (response) => {
      response.resume();
      const healthy = response.statusCode >= 200 && response.statusCode < 300;
      response.on("end", () => process.exit(healthy ? 0 : 1));
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => process.exit(1));
  ' "$1" "$2"
}

listener_belongs_to_pid() {
  "$NODE_BIN" -e '
    const fs = require("node:fs");
    const pid = process.argv[1];
    const expectedPort = Number(process.argv[2]);

    try {
      const socketInodes = new Set();
      for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
	let target;
	try {
	  target = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
	} catch {
	  continue;
	}
	const match = /^socket:\[(\d+)\]$/.exec(target);
	if (match) socketInodes.add(match[1]);
      }

      for (const table of [`/proc/${pid}/net/tcp`, `/proc/${pid}/net/tcp6`]) {
	let rows;
	try {
	  rows = fs.readFileSync(table, "utf8").trim().split("\n").slice(1);
	} catch {
	  continue;
	}
	for (const row of rows) {
	  const fields = row.trim().split(/\s+/);
	  if (fields.length < 10 || fields[3] !== "0A") continue;
	  const separator = fields[1].lastIndexOf(":");
	  const port = Number.parseInt(fields[1].slice(separator + 1), 16);
	  if (port === expectedPort && socketInodes.has(fields[9])) {
	    process.exit(0);
	  }
	}
      }
    } catch {
      // The unit may be between restart attempts; let the caller retry.
    }
    process.exit(1);
  ' "$1" "$2"
}

read_effective_listener() {
  local pid="$1"
  local env_entry
  local value

  [[ -r "/proc/$pid/environ" ]] || return 1
  EFFECTIVE_HOST="127.0.0.1"
  EFFECTIVE_PORT="3456"
  while IFS= read -r -d '' env_entry; do
    case "$env_entry" in
    HOST=*)
      value="${env_entry#HOST=}"
      [[ -z "$value" ]] || EFFECTIVE_HOST="$value"
      ;;
    PORT=*)
      value="${env_entry#PORT=}"
      [[ -z "$value" ]] || EFFECTIVE_PORT="$value"
      ;;
    esac
  done <"/proc/$pid/environ"

  [[ -n "$EFFECTIVE_HOST" ]]
  [[ "$EFFECTIVE_PORT" =~ ^[0-9]+$ ]] \
    && ((EFFECTIVE_PORT >= 1 && EFFECTIVE_PORT <= 65535))
}

[[ "$(uname -s)" == "Linux" ]] || die "This installer supports Linux only"
[[ "$EUID" -ne 0 ]] || die "Run this script as the service user, not with sudo"
[[ "$SERVICE_NAME" =~ ^[A-Za-z0-9_.@-]+$ ]] || die "Invalid SERVICE_NAME: $SERVICE_NAME"
[[ "$PORT" =~ ^[0-9]+$ ]] && ((PORT >= 1 && PORT <= 65535)) \
  || die "PORT must be an integer between 1 and 65535"
[[ "$READINESS_TIMEOUT" =~ ^[0-9]+$ ]] && ((READINESS_TIMEOUT >= 1 && READINESS_TIMEOUT <= 300)) \
  || die "INSTALL_READINESS_TIMEOUT must be an integer between 1 and 300 seconds"
[[ "$HOST" != *$'\n'* && "$HOST" != *$'\r'* ]] \
  || die "HOST must not contain newlines"

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ENTRYPOINT="$PROJECT_DIR/dist/server/standalone.js"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
ENV_FILE="$CONFIG_HOME/claude-max-api-proxy.env"
SYSTEMD_USER_DIR="$CONFIG_HOME/systemd/user"
SERVICE_FILE="$SYSTEMD_USER_DIR/$SERVICE_NAME.service"

[[ -f "$PROJECT_DIR/package.json" ]] || die "package.json not found in $PROJECT_DIR"

NODE_BIN="$(command_path node)"
NPM_BIN="$(command_path npm)"
SYSTEMCTL_BIN="$(command_path systemctl)"
LOGINCTL_BIN="$(trusted_command_path loginctl)"
SUDO_BIN="$(trusted_command_path sudo)"
ID_BIN="$(trusted_command_path id)"
STAT_BIN="$(trusted_command_path stat)"
REALPATH_BIN="$(trusted_command_path realpath)"
MKTEMP_BIN="$(trusted_command_path mktemp)"
MV_BIN="$(trusted_command_path mv)"
RM_BIN="$(trusted_command_path rm)"

[[ -n "$NODE_BIN" ]] || die "Node.js $MIN_NODE_VERSION or newer is required"
[[ -n "$NPM_BIN" ]] || die "npm is required"
[[ -n "$SYSTEMCTL_BIN" ]] || die "systemctl is required (Ubuntu with systemd)"
[[ -n "$LOGINCTL_BIN" ]] || die "loginctl is required (systemd-logind)"
[[ -n "$ID_BIN" ]] || die "id is required"
[[ -n "$STAT_BIN" ]] || die "stat is required (GNU coreutils)"
[[ -n "$REALPATH_BIN" ]] || die "realpath is required (GNU coreutils)"
[[ -n "$MKTEMP_BIN" ]] || die "mktemp is required (GNU coreutils)"
[[ -n "$MV_BIN" ]] || die "mv is required (GNU coreutils)"
[[ -n "$RM_BIN" ]] || die "rm is required (GNU coreutils)"
service_executable_is_trusted "$NODE_BIN" \
  || die "Refusing Node.js executable with untrusted ownership or permissions: $NODE_BIN"
service_path_is_trusted "$PROJECT_DIR" \
  || die "Refusing project directory with untrusted ownership or permissions: $PROJECT_DIR"

SERVICE_USER="$("$ID_BIN" -un)"

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
  APT_GET_BIN="$(trusted_command_path apt-get)"
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
else
  service_executable_is_trusted "$CLAUDE_BIN" \
    || die "Refusing Claude Code executable with untrusted ownership or permissions: $CLAUDE_BIN"
fi
CODEX_BIN="$(command_path codex)"
if [[ -z "$CODEX_BIN" ]]; then
  warn "Codex CLI was not found; Codex requests will fail until it is installed and authenticated"
else
  service_executable_is_trusted "$CODEX_BIN" \
    || die "Refusing Codex executable with untrusted ownership or permissions: $CODEX_BIN"
fi

log "Installing dependencies"
(cd "$PROJECT_DIR" && "$NPM_BIN" ci)

log "Building production files"
(cd "$PROJECT_DIR" && "$NPM_BIN" run build)
[[ -f "$ENTRYPOINT" ]] || die "Build did not create $ENTRYPOINT"
service_file_is_trusted "$ENTRYPOINT" \
  || die "Refusing application entrypoint with untrusted ownership or permissions: $ENTRYPOINT"

prepare_trusted_directory "$CONFIG_HOME" "configuration directory"
prepare_trusted_directory "$SYSTEMD_USER_DIR" "systemd user unit directory"

if [[ -e "$ENV_FILE" || -L "$ENV_FILE" ]]; then
  service_file_is_trusted "$ENV_FILE" \
    || die "Refusing existing configuration with untrusted ownership or permissions: $ENV_FILE"
  chmod 600 "$ENV_FILE"
  log "Keeping existing configuration: $ENV_FILE"
else
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
NPM_PREFIX="$("$NPM_BIN" prefix --global 2>/dev/null || true)"
SERVICE_PATH=""
append_service_path "$NODE_DIR"
append_service_path "$CLAUDE_DIR"
append_service_path "$CODEX_DIR"
append_service_path "$HOME/.local/bin"
append_service_path "$HOME/bin"
if [[ -n "$NPM_PREFIX" ]]; then
  append_service_path "$NPM_PREFIX/bin"
fi
IFS=: read -r -a USER_PATH_DIRS <<<"${PATH:-}"
for directory in "${USER_PATH_DIRS[@]}"; do
  append_service_path "$directory"
done
append_service_path "/usr/local/bin"
append_service_path "/usr/bin"
append_service_path "/bin"

log "Writing systemd user service: $SERVICE_FILE"
if [[ -e "$SERVICE_FILE" || -L "$SERVICE_FILE" ]]; then
  service_file_is_trusted "$SERVICE_FILE" \
    || die "Refusing existing systemd unit with untrusted ownership or permissions: $SERVICE_FILE"
fi
SERVICE_FILE_TMP="$("$MKTEMP_BIN" "$SYSTEMD_USER_DIR/.${SERVICE_NAME}.service.XXXXXX")" \
  || die "Failed to create temporary systemd unit in $SYSTEMD_USER_DIR"
service_file_is_trusted "$SERVICE_FILE_TMP" || {
  "$RM_BIN" -f -- "$SERVICE_FILE_TMP"
  die "Temporary systemd unit has untrusted ownership or permissions: $SERVICE_FILE_TMP"
}
{
  printf '[Unit]\n'
  printf 'Description=CLI OpenAI Proxy\n'
  printf 'Wants=network-online.target\n'
  printf 'After=network-online.target\n'
  printf '\n'
  printf '[Service]\n'
  printf 'Type=simple\n'
  printf 'WorkingDirectory=%s\n' "$(unit_scalar_escape "$PROJECT_DIR")"
  printf 'Environment=%s\n' "$(unit_quote "HOME=$HOME")"
  printf 'Environment=%s\n' "$(unit_quote "NODE_ENV=production")"
  printf 'Environment=%s\n' "$(unit_quote "PATH=$SERVICE_PATH")"
  printf 'EnvironmentFile=%s\n' "$(unit_scalar_escape "$ENV_FILE")"
  printf 'ExecStart=%s %s\n' "$(unit_quote "$NODE_BIN")" "$(unit_quote "$ENTRYPOINT")"
  printf 'Restart=on-failure\n'
  printf 'RestartSec=5\n'
  printf 'TimeoutStopSec=30\n'
  printf 'UMask=0077\n'
  printf '\n'
  printf '[Install]\n'
  printf 'WantedBy=default.target\n'
} >"$SERVICE_FILE_TMP" || {
  "$RM_BIN" -f -- "$SERVICE_FILE_TMP"
  die "Failed to write temporary systemd unit: $SERVICE_FILE_TMP"
}
"$MV_BIN" -fT -- "$SERVICE_FILE_TMP" "$SERVICE_FILE" || {
  "$RM_BIN" -f -- "$SERVICE_FILE_TMP"
  die "Failed to replace systemd unit: $SERVICE_FILE"
}
service_file_is_trusted "$SERVICE_FILE" \
  || die "Generated systemd unit has untrusted ownership or permissions: $SERVICE_FILE"

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

EFFECTIVE_HOST=""
EFFECTIVE_PORT=""
PROBE_HOST=""
MAIN_PID=""
READY=0
DEADLINE=$((SECONDS + READINESS_TIMEOUT))

log "Waiting up to ${READINESS_TIMEOUT}s for the health endpoint"
while ((SECONDS < DEADLINE)); do
  MAIN_PID="$("$SYSTEMCTL_BIN" --user show "$SERVICE_NAME.service" \
    --property=MainPID --value 2>/dev/null || true)"
  if [[ "$MAIN_PID" =~ ^[1-9][0-9]*$ ]] && read_effective_listener "$MAIN_PID"; then
    PROBE_HOST="$EFFECTIVE_HOST"
    case "$PROBE_HOST" in
      0.0.0.0) PROBE_HOST="127.0.0.1" ;;
      :: | "[::]") PROBE_HOST="::1" ;;
    esac

    CURRENT_MAIN_PID=""
    if listener_belongs_to_pid "$MAIN_PID" "$EFFECTIVE_PORT" \
      && health_check "$PROBE_HOST" "$EFFECTIVE_PORT"; then
      CURRENT_MAIN_PID="$("$SYSTEMCTL_BIN" --user show "$SERVICE_NAME.service" \
      --property=MainPID --value 2>/dev/null || true)"
    fi
    if [[ "$CURRENT_MAIN_PID" == "$MAIN_PID" ]] \
      && listener_belongs_to_pid "$MAIN_PID" "$EFFECTIVE_PORT"; then
      READY=1
      break
    fi
  fi
  sleep 1
done

if ((READY == 0)); then
  "$SYSTEMCTL_BIN" --user --no-pager --full status "$SERVICE_NAME.service" || true
  warn "The service did not become ready within ${READINESS_TIMEOUT}s"
  warn "Inspect logs with: journalctl --user -u $SERVICE_NAME.service -n 100"
  exit 1
fi

DISPLAY_HOST="$EFFECTIVE_HOST"
if [[ "$DISPLAY_HOST" == *:* && "$DISPLAY_HOST" != \[*\] ]]; then
  DISPLAY_HOST="[$DISPLAY_HOST]"
fi
DISPLAY_PROBE_HOST="$PROBE_HOST"
if [[ "$DISPLAY_PROBE_HOST" == *:* && "$DISPLAY_PROBE_HOST" != \[*\] ]]; then
  DISPLAY_PROBE_HOST="[$DISPLAY_PROBE_HOST]"
fi

log "Installation complete"
printf '\n'
printf '  Listener: %s:%s\n' "$DISPLAY_HOST" "$EFFECTIVE_PORT"
printf '  Health:   http://%s:%s/health\n' "$DISPLAY_PROBE_HOST" "$EFFECTIVE_PORT"
printf '  Status:  systemctl --user status %s.service\n' "$SERVICE_NAME"
printf '  Logs:    journalctl --user -u %s.service -f\n' "$SERVICE_NAME"
printf '  Config:  %s\n' "$ENV_FILE"
printf '\n'
printf 'After changing the config, run:\n'
printf '  systemctl --user restart %s.service\n' "$SERVICE_NAME"
